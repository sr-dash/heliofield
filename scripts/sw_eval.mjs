// One day's space-weather record, computed with the page's own model
// (js/sw-model.js) so the archive, the share card and the page always agree.
// Called by scripts/sw_record.py with the decoded product on stdin:
//   { day, meta, speed: [64800, null = no value], bss: [64800], cls: [64800], events }
// (events: HelioFleet's DONKI list, or null) and prints
//   { record, level, reasons, card, counts } on stdout.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as M from "../js/sw-model.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const req = JSON.parse(readFileSync(0, "utf8"));
const d = {
  day: req.day, meta: req.meta, t0: Date.parse(req.meta.obstime), L0: req.meta.L0, rss: req.meta.model.rss,
  speed: req.speed ? Float64Array.from(req.speed, (v) => (v == null ? NaN : v)) : null,
  bss: Float64Array.from(req.bss),
  cls: req.cls ? Int8Array.from(req.cls) : null,
};
const a = M.analyse(d);

// The page's history.fleetFor, from the repository's files.
const years = new Map();
function fleetAt(day) {
  const y = +day.slice(0, 4), path = `${ROOT}data/history/fleet/${y}.json`;
  if (!years.has(y)) years.set(y, existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
  const doc = years.get(y);
  if (!doc) return null;
  const i = Math.round((Date.parse(day) - Date.parse(doc.start)) / 86400000);
  if (i < 0 || i >= doc.n) return null;
  const fleet = {};
  for (const [k, b] of Object.entries(doc.bodies)) if (b.lon[i] != null) fleet[k] = { lon: b.lon[i], lat: b.lat[i], r: b.r[i] };
  return { fleet, L0: doc.L0[i] };
}
const metaFor = (day) => { const p = `${ROOT}data/${day}/meta.json`; return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };

const ev = req.events ? M.eventsAnalysis(req.events, d, a, { metaFor, fleetAt }) : null;
const o = M.overall(d, a, ev);
process.stdout.write(JSON.stringify({
  record: { ...M.record(d, a), level: o.level },
  level: o.level, reasons: o.reasons, card: M.cardSeries(d, a),
  counts: ev && { flares: ev.flares.length, cmes: ev.cmes.length, storms: ev.storms.length,
    earth_cmes: ev.cmes.filter((c) => c.targets.earth && c.targets.earth.hit !== "miss").length },
}));
