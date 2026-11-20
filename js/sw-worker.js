// The space-weather page's own solve, for dates before the daily products:
// the rotation map's PFSS field at 2.5 R_sun, in the shape of a daily
// product (its meta.json fields, and the speed, source-surface and
// open-field grids its PNGs carry, north row first). A rotation's field is
// kept, so another date inside it only maps the fleet again.
import { solve, connectOnly, wsaGrid } from "./pfss.js?v=3d7963269f";

const RSS = 2.5;
let last = null;   // { key, models, speed, bss, cls, meta }

async function loadMap(url, scale) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`map download failed (${res.status})`);
  const raw = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  const q = new Int16Array(raw), br = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) br[i] = q[i] * scale;
  return br;
}

// 1-degree rows south first, to north first.
function flip(a, Type) {
  const out = new Type(a.length);
  for (let i = 0; i < 180; i++) out.set(a.subarray((179 - i) * 360, (180 - i) * 360), i * 360);
  return out;
}

self.onmessage = async (e) => {
  const d = e.data, id = d.id;
  const progress = (stage, f) => self.postMessage({ id, type: "progress", stage, f });
  try {
    if (!last || last.key !== d.key) {
      last = null;
      progress("download", 0);
      const br = await loadMap(d.url, d.scale);
      const out = solve(br, d.shape[0], d.shape[1], { rss: RSS, fleet: {}, progress: (s, f) => progress(s, 0.6 * f) });
      const m = out.models[0], sc = out.meta.ss_scale;
      const speed = wsaGrid(m, (f) => progress("speed map", 0.6 + 0.4 * f));
      last = {
        key: d.key, models: out.models, speed,
        bss: flip(Float64Array.from(out.ss, (x) => Math.max(-1, Math.min(1, x / sc))), Float64Array),   // as ss.png decodes
        cls: flip(Int8Array.from(m.pol), Int8Array),                                                     // as open.png decodes
        meta: { hcs: out.meta.hcs, open_flux_Mx: out.meta.open_flux_Mx, ss_scale: sc, model: out.meta.model },
      };
    }
    const { connect, ensemble } = connectOnly(last.models, d.fleet);
    self.postMessage({ id, type: "done", meta: { ...last.meta, connect, ensemble }, speed: last.speed, bss: last.bss, cls: last.cls });
  } catch (err) {
    self.postMessage({ id, type: "error", message: err.message || String(err) });
  }
};
