// The connectivity page's computations, off the main thread: the field of the
// rotation map covering a date (PFSS, optionally with the Schatten current
// sheet), each spacecraft's magnetic connection at every speed of the grid,
// the polarity that connection predicts at the spacecraft, how close it runs
// to the current sheet, and the same polarity day by day over a rotation.
import { solve, connectOnly, surfaceBr, VGRID } from "./pfss.js?v=1e0df6a8d5";
import { annotate, topPolarity, toSheet } from "./connect-model.js?v=b8f7ec1dd0";

const DEG = Math.PI / 180;
let last = null;   // { key, br, coef, rss, rout, models, meta }

function flatten(polys) {
  const counts = new Int32Array(polys.length);
  let n = 0;
  polys.forEach((p, i) => { counts[i] = p.length; n += p.length; });
  const xyz = new Float32Array(3 * n);
  let o = 0;
  for (const p of polys) for (const q of p) { xyz[o++] = q[0]; xyz[o++] = q[1]; xyz[o++] = q[2]; }
  return { xyz, counts };
}

async function loadMap(url, scale) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`map download failed (${res.status})`);
  const raw = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  const q = new Int16Array(raw), br = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) br[i] = q[i] * scale;
  return br;
}

self.onmessage = async (e) => {
  const d = e.data, id = d.id;
  const progress = (stage, f) => self.postMessage({ id, type: "progress", stage, f });
  try {
    if (d.type === "solve") {
      let br, coef = null;
      if (last && last.key === d.key) ({ br, coef } = last);
      else { last = null; progress("download", 0); br = await loadMap(d.url, d.scale); }
      const out = solve(br, d.shape[0], d.shape[1], { rss: d.rss, rout: d.rout, coef, fleet: d.fleet, progress });
      const m = out.models[0], meta = out.meta;
      last = { key: d.key, br, coef: out.coef, rss: d.rss, rout: d.rout, models: out.models, meta };
      const nf = meta.lines.count;
      const lines = flatten(out.polys.slice(0, nf)), conn = flatten(out.polys.slice(nf));
      const ny = 180, nx = 360;
      const phot = surfaceBr(out.coef, 1, d.rss, ny, nx);          // model photospheric B_r, 1-degree rows
      const pol = Int8Array.from(m.pol);
      const { rows, ensemble } = annotate(m, meta, meta.connect, meta.ensemble);
      self.postMessage({
        id, type: "solved",
        meta: { model: meta.model, hcs: meta.hcs, hcs_out: meta.hcs_out, hcs_ribs: meta.hcs_ribs, open_flux_Mx: meta.open_flux_Mx,
          kind: meta.lines.kind, vgrid: VGRID, ensembleRss: ensemble.rss },
        rows, ensemble: ensemble.foot, lines, conn, phot, pol,
      }, [lines.xyz.buffer, lines.counts.buffer, conn.xyz.buffer, conn.counts.buffer, phot.buffer, pol.buffer]);
      return;
    }
    if (!last) throw new Error("no field solved yet");
    const m = last.models[0];
    if (d.type === "connect") {
      // Another moment inside the same rotation: only the connections change.
      const { connect, conn, ensemble } = connectOnly(last.models, d.fleet);
      const { rows } = annotate(m, last.meta, connect, ensemble);
      const c = flatten(conn);
      self.postMessage({ id, type: "connected", rows, ensemble: ensemble.foot, conn: c }, [c.xyz.buffer, c.counts.buffer]);
      return;
    }
    if (d.type === "timeline") {
      // Day by day over the rotation: where each body's spiral meets the
      // model's outer boundary at speed v, the polarity there, and its angle
      // to the current sheet. No tracing to the photosphere is needed.
      const rEdge = m.rout || m.rss, sheet = m.S ? last.meta.hcs_out || [] : last.meta.hcs || [];
      const OMEGA = 2 * Math.PI / (25.38 * 86400), AU_RS = 149597870.7 / 695700;
      const out = d.days.map(({ day, fleet }) => {
        const bodies = {};
        for (const [k, b] of Object.entries(fleet)) {
          if (b.planet || b.lon == null) continue;
          const r = b.r * AU_RS, inside = !!m.S && r < rEdge && r > m.rcp * 1.01;   // inside the SCS domain: no spiral
          const lon = (((inside ? b.lon : b.lon + OMEGA * (r - rEdge) * 695700 / d.v / DEG)) % 360 + 360) % 360, lat = Math.max(-89, Math.min(89, b.lat));
          bodies[k] = { lon: +lon.toFixed(2), lat: +lat.toFixed(2), pol: topPolarity(m, lon, lat, inside ? r : null), sheetDeg: toSheet(sheet, lon, lat) };
        }
        return { day, bodies };
      });
      self.postMessage({ id, type: "timeline", days: out });
      return;
    }
    throw new Error(`unknown request ${d.type}`);
  } catch (err) {
    self.postMessage({ id, type: "error", message: err.message || String(err) });
  }
};
