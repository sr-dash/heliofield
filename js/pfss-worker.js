// Solves PFSS off the main thread. Keeps the last rotation's field so a new
// date inside the same rotation only re-traces spacecraft connectivity.
import { solve, connectOnly } from "./pfss.js";

let last = null;   // { key, G }

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
  const { id, url, key, scale, shape, fleet, reuse } = e.data;
  const progress = (stage, f) => self.postMessage({ id, type: "progress", stage, f });
  try {
    // Only when the page still shows this rotation's field.
    if (reuse && last && last.key === key) {
      const { connect, conn } = connectOnly(last.G, fleet);
      const { xyz, counts } = flatten(conn);
      self.postMessage({ id, type: "connect", connect, xyz, counts }, [xyz.buffer, counts.buffer]);
      return;
    }
    last = null;                       // release the previous rotation's field first
    progress("download", 0);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`map download failed (${res.status})`);
    const raw = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const q = new Int16Array(raw), br = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) br[i] = q[i] * scale;
    const out = solve(br, shape[0], shape[1], { fleet, progress });
    last = { key, G: out.G };
    const { xyz, counts } = flatten(out.polys);
    self.postMessage({ id, type: "done", meta: out.meta, xyz, counts, brTex: out.brTex, ssTex: out.ssTex },
      [xyz.buffer, counts.buffer, out.brTex.buffer, out.ssTex.buffer]);
  } catch (err) {
    self.postMessage({ id, type: "error", message: err.message || String(err) });
  }
};
