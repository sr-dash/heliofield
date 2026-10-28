// Solves PFSS off the main thread. Keeps the last rotation's field so a new
// date inside the same rotation only re-traces spacecraft connectivity, and
// its map and harmonic coefficients so another source-surface height only
// re-solves the field. The same holds for switching the SCS model on or off.
import { solve, connectOnly } from "./pfss.js?v=b541db08ad";

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

self.onmessage = async (e) => {
  const { id, url, key, scale, shape, fleet, reuse, rss = 2.5, rout = 0 } = e.data;
  const progress = (stage, f) => self.postMessage({ id, type: "progress", stage, f });
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
