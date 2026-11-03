// One day's space-weather record, computed with the page's own model
// (js/sw-model.js) so the archive and the page always agree. Called by
// scripts/sw_record.py with the decoded product on stdin:
//   { day, meta, speed: [64800, null = no value], bss: [64800], cls: [64800] }
// and prints the record (see record() in sw-model.js) on stdout.

import { readFileSync } from "node:fs";
import * as M from "../js/sw-model.js";

const req = JSON.parse(readFileSync(0, "utf8"));
const d = {
  day: req.day, meta: req.meta, t0: Date.parse(req.meta.obstime), L0: req.meta.L0, rss: req.meta.model.rss,
  speed: req.speed ? Float64Array.from(req.speed, (v) => (v == null ? NaN : v)) : null,
  bss: Float64Array.from(req.bss),
  cls: req.cls ? Int8Array.from(req.cls) : null,
};
process.stdout.write(JSON.stringify(M.record(d, M.analyse(d))));
