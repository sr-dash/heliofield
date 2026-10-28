// Any date since 2010: the HMI rotation map covering it, the fleet's
// Carrington positions that day, and the in-browser solve.

const JSOC = "https://jsoc1.stanford.edu/data/hmi/synoptic/";
let index = null;
const years = new Map();

export async function historyIndex() {
  index ??= await fetch("data/history/index.json").then((r) => {
    if (!r.ok) throw new Error("history index unavailable");
    return r.json();
  });
  return index;
}

// The rotation whose time span holds noon UTC of the date; otherwise the
// nearest one, flagged so the page can say so.
export function rotationFor(idx, day) {
  const t = `${day}T12:00:00Z`, rots = idx.rotations;
  const hit = rots.find((r) => r.start <= t && t <= r.stop);
  if (hit) return { rot: hit, exact: true };
  let best = rots[0], gap = Infinity;
  for (const r of rots) {
    const d = Math.min(Math.abs(Date.parse(r.start) - Date.parse(t)), Math.abs(Date.parse(r.stop) - Date.parse(t)));
    if (d < gap) { gap = d; best = r; }
  }
  return { rot: best, exact: false };
}

export const sourceUrl = (cr) => `${JSOC}hmi.Synoptic_Mr_small.${cr}.fits`;

// Earth's L0/B0 and each body's Carrington position at 12:00 UTC.
export async function fleetFor(day) {
  const y = +day.slice(0, 4);
  if (!years.has(y)) years.set(y, fetch(`data/history/fleet/${y}.json`).then((r) => {
    if (!r.ok) throw new Error(`no positions for ${y}`);
    return r.json();
  }));
  const doc = await years.get(y);
  const i = Math.round((Date.parse(day) - Date.parse(doc.start)) / 86400000);
  if (i < 0 || i >= doc.n) throw new Error(`no positions for ${day}`);
  const fleet = {};
  for (const [k, b] of Object.entries(doc.bodies)) {
    if (b.lon[i] == null) continue;
    fleet[k] = { name: b.name, planet: b.planet, lon: b.lon[i], lat: b.lat[i], r: b.r[i] };
  }
  return { fleet, L0: doc.L0[i], B0: doc.B0[i], CR: doc.CR[i] };
}

// One worker, reused, so a rotation's solved field survives date changes
// inside it. cancel() kills it outright, which also frees its memory.
let worker = null, seq = 0, pending = null;
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./pfss-worker.js?v=54b9a1f7ad", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (!pending || m.id !== pending.id) return;
      if (m.type === "progress") pending.onProgress?.(m.stage, m.f);
      else if (m.type === "error") { pending.reject(new Error(m.message)); pending = null; }
      else { pending.resolve(m); pending = null; }
    };
    worker.onerror = (e) => { pending?.reject(new Error(e.message || "worker failed")); pending = null; };
  }
  return worker;
}
export function compute({ url, key, scale, shape, fleet, reuse, rss, rout }, onProgress) {
  cancel();
  return new Promise((resolve, reject) => {
    pending = { id: ++seq, resolve, reject, onProgress };
    getWorker().postMessage({ id: seq, url: new URL(url, location.href).href, key, scale, shape, fleet, reuse, rss, rout });
  });
}
// Ask the worker for a zip of the results of the field it solved last.
// Unlike compute(), this never cancels: that would discard the field.
export function exportResults(req) {
  if (pending) return Promise.reject(new Error("a computation is still running"));
  return new Promise((resolve, reject) => {
    pending = { id: ++seq, resolve, reject };
    getWorker().postMessage({ id: seq, type: "export", ...req });
  });
}
export function cancel() {
  if (pending) {
    worker?.terminate(); worker = null;
    pending.reject(new Error("cancelled")); pending = null;
  }
}
// Unflatten the worker's polylines.
export function unflatten(xyz, counts) {
  const out = [];
  let o = 0;
  for (const n of counts) {
    const p = new Array(n);
    for (let k = 0; k < n; k++, o += 3) p[k] = [xyz[o], xyz[o + 1], xyz[o + 2]];
    out.push(p);
  }
  return out;
}
