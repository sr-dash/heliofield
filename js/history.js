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

let daily = null;
export async function dailyIndex() {
  daily ??= fetch("data/index.json").then((r) => (r.ok ? r.json() : { dates: [] })).catch(() => ({ dates: [] }));
  return daily;
}

const SOURCE = { GONG: "NSO/GONG synoptic map", HMI: "SDO/HMI daily synoptic frame" };
const fmtTime = (t) => `${t.slice(0, 10)} ${t.slice(11, 16)} UTC`;

// The input map every page uses for a date, by one rule: the day's own map
// where its daily product publishes one, else the HMI rotation map covering
// the date. A date neither covers (a missed night, or days after the latest
// rotation map) gets whichever is nearer in time, flagged exact = false.
// { kind: "daily" | "rotation", url, key, scale, shape, exact, day?, rot?,
//   label (map and its date, for on-map captions), short (a badge) }.
// rotation: true always takes the rotation map (the movies' frames).
export async function fieldFor(day, { rotation = false } = {}) {
  const [idx, di] = await Promise.all([historyIndex(), dailyIndex()]);
  const maps = rotation ? {} : di.maps || {};
  const ofDay = (d) => {
    const [src, t] = maps[d];
    return { kind: "daily", day: d, url: `data/${d}/map.bin.gz`, key: `day:${d}`, scale: di.map_scale_G ?? 0.1, shape: [180, 360],
      src, obstime: t, label: `${SOURCE[src] || src}, ${fmtTime(t)}`, short: `${src} daily ${d}` };
  };
  const ofRot = (rot, exact) => ({ kind: "rotation", rot, url: `data/history/${rot.file}`, key: rot.cr, scale: idx.scale_G, shape: idx.shape, exact,
    label: `SDO/HMI rotation map CR ${rot.cr}, ${rot.start.slice(0, 10)} to ${rot.stop.slice(0, 10)}`, short: `HMI CR ${rot.cr}` });
  if (maps[day]) return { ...ofDay(day), exact: true };
  const { rot, exact } = rotationFor(idx, day);
  if (exact) return ofRot(rot, true);
  const t = Date.parse(`${day}T12:00:00Z`), days = Object.keys(maps);
  const near = days.length ? days.reduce((b, d) => (Math.abs(Date.parse(d) - t) < Math.abs(Date.parse(b) - t) ? d : b)) : null;
  const gapRot = Math.min(Math.abs(Date.parse(rot.start) - t), Math.abs(Date.parse(rot.stop) - t));
  return near && Math.abs(Date.parse(`${near}T12:00:00Z`) - t) < gapRot ? { ...ofDay(near), exact: false } : ofRot(rot, false);
}

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
    worker = new Worker(new URL("./pfss-worker.js?v=18e7f5af66", import.meta.url), { type: "module" });
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
