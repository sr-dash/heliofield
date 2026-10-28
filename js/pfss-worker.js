// Solves PFSS off the main thread. Keeps the last rotation's field so a new
// date inside the same rotation only re-traces spacecraft connectivity, and
// its map and harmonic coefficients so another source-surface height only
// re-solves the field. The same holds for switching the SCS model on or off.
import { solve, connectOnly } from "./pfss.js?v=b541db08ad";
import { buildExport, bundleName, readme, SCRIPTS } from "./export.js?v=5bc999e2f9";

let last = null;   // { key, rss, rout, br, coef, models }

function flatten(polys) {
  const counts = new Int32Array(polys.length);
  let n = 0;
  polys.forEach((p, i) => { counts[i] = p.length; n += p.length; });
  const xyz = new Float32Array(3 * n);
  let o = 0;
  for (const p of polys) for (const q of p) { xyz[o++] = q[0]; xyz[o++] = q[1]; xyz[o++] = q[2]; }
  return { xyz, counts };
}

// A zip of the results of the field solved last: the NetCDF file, its
// header, the README and the Python scripts. fflate is loaded only now.
async function exportZip(req) {
  if (!last?.models) throw new Error("no field solved in this session");
  const enc = new TextEncoder();
  const lines = [], conn = [];
  for (let i = 0, o = 0; i < req.counts.length; i++) {
    const p = [];
    for (let k = 0; k < req.counts[i]; k++, o += 3) p.push([req.xyz[o], req.xyz[o + 1], req.xyz[o + 2]]);
    (i < req.meta.lines.count ? lines : conn).push(p);
  }
  const ctx = {
    br: last.br, ny: req.shape[0], nx: req.shape[1], coef: last.coef, model: last.models[0], meta: req.meta,
    lines, drawn: req.drawn, conn: req.connIdx.map((c) => ({ ...c, pts: conn[c.i] })), view: req.view,
    version: req.version, created: new Date().toISOString().slice(0, 19) + "Z", saved: req.saved,
  };
  const { nc, header } = buildExport({ ...ctx, kind: req.kind });
  const stem = bundleName(header), base = new URL("../download/", import.meta.url);
  const get = async (f) => { const r = await fetch(new URL(f, base), { cache: "no-cache" }); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.text(); };
  const texts = await Promise.all([...SCRIPTS, "README.txt"].map(get));
  const { zipSync } = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js");
  const files = { [`${stem}/${stem}.nc`]: nc, [`${stem}/${stem}_header.json`]: enc.encode(JSON.stringify(header, null, 1)) };
  if (req.kind !== "surface") {
    const s = buildExport({ ...ctx, kind: "surface" }), ss = bundleName(s.header);
    files[`${stem}/${ss}.nc`] = s.nc;
    files[`${stem}/${ss}_header.json`] = enc.encode(JSON.stringify(s.header, null, 1));
  }
  SCRIPTS.forEach((f, i) => { files[`${stem}/${f}`] = enc.encode(texts[i]); });
  files[`${stem}/README.txt`] = enc.encode(readme(texts[texts.length - 1], header));
  return { zip: zipSync(files, { level: 6 }), name: `${stem}.zip` };
}

self.onmessage = async (e) => {
  const { id, url, key, scale, shape, fleet, reuse, rss = 2.5, rout = 0 } = e.data;
  const progress = (stage, f) => self.postMessage({ id, type: "progress", stage, f });
  if (e.data.type === "export") {
    try {
      const { zip, name } = await exportZip(e.data);
      self.postMessage({ id, type: "zip", zip, name }, [zip.buffer]);
    } catch (err) {
      self.postMessage({ id, type: "error", message: err.message || String(err) });
    }
    return;
  }
  try {
    // Only when the page still shows this rotation's field.
    if (reuse && last && last.key === key && last.rss === rss && last.rout === rout) {
      const { connect, conn, ensemble } = connectOnly(last.models, fleet);
      const { xyz, counts } = flatten(conn);
      self.postMessage({ id, type: "connect", connect, ensemble, xyz, counts }, [xyz.buffer, counts.buffer]);
      return;
    }
    let br, coef = null;
    if (last && last.key === key) {
      ({ br, coef } = last);           // same map, another source surface
      last.models = null;
    } else {
      last = null;                     // release the previous rotation's field first
      progress("download", 0);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`map download failed (${res.status})`);
      const raw = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      const q = new Int16Array(raw);
      br = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) br[i] = q[i] * scale;
    }
    const out = solve(br, shape[0], shape[1], { rss, rout, coef, fleet, progress });
    last = { key, rss, rout, br, coef: out.coef, models: out.models };
    const { xyz, counts } = flatten(out.polys);
    self.postMessage({ id, type: "done", meta: out.meta, xyz, counts, brTex: out.brTex, ssTex: out.ssTex, footTex: out.footTex },
      [xyz.buffer, counts.buffer, out.brTex.buffer, out.ssTex.buffer, out.footTex.buffer]);
  } catch (err) {
    self.postMessage({ id, type: "error", message: err.message || String(err) });
  }
};
