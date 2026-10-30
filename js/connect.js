// Connectivity page: for a date, each in-situ spacecraft's magnetic
// connection to the Sun (ballistic Parker spiral to the model's outer
// boundary, then the PFSS or PFSS + SCS field line to the photosphere), the
// polarity it predicts, the observations HelioFleet holds of its source
// region around the source time, and the model's current sheet in the
// coronagraph fields of view HelioFleet defines.

import { THEMES, currentTheme, divergingLUT } from "./theme.js";
import { historyIndex, rotationFor, fleetFor } from "./history.js";
import * as geo from "./connect-geo.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement, params = new URLSearchParams(location.search);
const DAY = 86400000, DEG = Math.PI / 180;
const FLEET_URL = "https://sr-dash.github.io/heliofleet/";
const VS = [300, 400, 500, 600, 700, 800], RSS = [1.5, 1.8, 2.0, 2.2, 2.5, 2.8, 3.0, 3.5];
// In-situ spacecraft, in the order shown; Earth stands for the L1 monitors.
const BODIES = [["psp", "Parker Solar Probe"], ["solo", "Solar Orbiter"], ["bepi", "BepiColombo"], ["sta", "STEREO-A"], ["stb", "STEREO-B"], ["earth", "Earth / L1"]];
const INS_NAMES = { iris: "IRIS", eis: "Hinode/EIS", visp: "DKIST/ViSP", vbi: "DKIST/VBI", dlnirsp: "DKIST/DL-NIRSP", vtf: "DKIST/VTF",
  euihri: "Solar Orbiter/EUI-HRI EUV", euilya: "Solar Orbiter/EUI-HRI Lyα", phihrt: "Solar Orbiter/PHI-HRT", spice: "Solar Orbiter/SPICE" };
// Coronagraph and heliospheric-imager fields, from HelioFleet (js/instruments.js
// there; sources listed in that file). unit rs: plane-of-sky solar radii;
// deg: elongation. side: both, east (solar east), ram (direction of travel),
// earth (the side where Earth is).
const INSTRUMENTS = [
  { id: "c2", sc: "soho", name: "SOHO LASCO C2", unit: "rs", inner: 2.2, outer: 6, side: "both" },
  { id: "c3", sc: "soho", name: "SOHO LASCO C3", unit: "rs", inner: 3.7, outer: 30, side: "both" },
  { id: "cor1a", sc: "sta", name: "STEREO-A COR1", unit: "rs", inner: 1.4, outer: 4, side: "both" },
  { id: "cor2a", sc: "sta", name: "STEREO-A COR2", unit: "rs", inner: 2.5, outer: 15, side: "both" },
  { id: "hi1a", sc: "sta", name: "STEREO-A HI-1", unit: "deg", inner: 4, outer: 24, side: "earth" },
  { id: "cor2b", sc: "stb", name: "STEREO-B COR2", unit: "rs", inner: 2.5, outer: 15, side: "both" },
  { id: "metis", sc: "solo", name: "Solar Orbiter Metis", unit: "deg", inner: 1.6, outer: 2.9, side: "both" },
  { id: "solohi", sc: "solo", name: "Solar Orbiter SoloHI", unit: "deg", inner: 5.4, outer: 44.9, side: "east" },
  { id: "wispri", sc: "psp", name: "Parker WISPR-I", unit: "deg", inner: 13.5, outer: 53, side: "ram" },
  { id: "velc", sc: "aditya", name: "Aditya-L1 VELC", unit: "rs", inner: 1.05, outer: 3, side: "both", from: "2023-09-02" },
  { id: "ccor2", sc: "swfo", name: "SOLAR-1 CCOR-2", unit: "rs", inner: 3, outer: 22, side: "both", from: "2025-09-24" },
  { id: "aspiics", sc: "earth", name: "Proba-3 ASPIICS", unit: "rs", inner: 1.1, outer: 3, side: "both", from: "2024-12-05", gaps: [["2026-02-14", "2026-06-04"]] },
  { id: "ccor1", sc: "earth", name: "GOES-19 CCOR-1", unit: "rs", inner: 3.7, outer: 17, side: "both", from: "2024-06-25" },
  { id: "nfi", sc: "earth", name: "PUNCH NFI", unit: "deg", inner: 1.5, outer: 8, side: "both", from: "2025-03-12" },
];

const today = new Date().toISOString().slice(0, 10);
const okDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && v >= "2010-05-01";
const S = {
  date: okDay(params.get("date")) ? params.get("date") : today,
  rout: [0, 5, 10, 21.5].includes(+params.get("scs")) ? +params.get("scs") : 0,
  rss: RSS.includes(+params.get("rss")) ? +params.get("rss") : 2.5,
  v: VS.includes(+params.get("v")) ? +params.get("v") : 400,
  sc: params.get("conn") === "sc",
  bg: params.get("bg") === "open" ? "open" : "field",
  focus: params.get("focus") || "psp",
  ins: params.get("ins") || "c3",
};
let sol = null, timeline = null, matches = [], obsCache = new Map();
const T = () => THEMES[currentTheme()];
const color = (k) => (k === "earth" ? T().fleet.earth : T().fleet[k] || T().planet);
const addDays = (day, k) => new Date(Date.parse(day + "T12:00:00Z") + k * DAY).toISOString().slice(0, 10);
const fmtT = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const fmtDur = (ms) => { const h = ms / 3600000; return h < 48 ? `${h.toFixed(0)} h` : `${(h / 24).toFixed(1)} d`; };

// ------------------------------------------------------------- worker
let worker = null, seq = 0;
const waiting = new Map();
function call(msg, onProgress) {
  worker ??= (() => {
    const w = new Worker(new URL("./connect-worker.js?v=e02c82c7a0", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const p = waiting.get(e.data.id);
      if (!p) return;
      if (e.data.type === "progress") return p.onProgress?.(e.data.stage, e.data.f);
      waiting.delete(e.data.id);
      e.data.type === "error" ? p.reject(new Error(e.data.message)) : p.resolve(e.data);
    };
    return w;
  })();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...msg, id });
  });
}

// ------------------------------------------------------------- controls
function setupControls() {
  $("date").value = S.date; $("date").max = addDays(today, 30);
  $("model").value = String(S.rout);
  $("rss").innerHTML = RSS.map((r) => `<option value="${r}"${r === S.rss ? " selected" : ""}>${r.toFixed(1)} R☉</option>`).join("");
  $("v").innerHTML = VS.map((v) => `<option value="${v}"${v === S.v ? " selected" : ""}>${v} km/s</option>`).join("");
  $("sc").checked = S.sc;
  const go = () => { syncUrl(); run(); };
  $("date").onclick = (e) => { try { e.target.showPicker(); } catch (err) { /* older browsers */ } };
  $("date").onchange = (e) => { if (okDay(e.target.value)) { S.date = e.target.value; go(); } };
  $("prev").onclick = () => { S.date = addDays(S.date, -1); $("date").value = S.date; go(); };
  $("next").onclick = () => { S.date = addDays(S.date, 1); $("date").value = S.date; go(); };
  $("model").onchange = (e) => { S.rout = +e.target.value; go(); };
  $("rss").onchange = (e) => { S.rss = +e.target.value; go(); };
  $("v").onchange = (e) => { S.v = +e.target.value; syncUrl(); afterSolve(); };
  $("sc").onchange = (e) => { S.sc = e.target.checked; syncUrl(); afterSolve(); };
  for (const b of document.querySelectorAll("[data-bg]")) b.onclick = () => {
    S.bg = b.dataset.bg;
    for (const x of document.querySelectorAll("[data-bg]")) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); }
    syncUrl(); drawMap();
  };
  $("ins").onchange = (e) => { S.ins = e.target.value; syncUrl(); drawSky(); };
}
function syncUrl() {
  const q = new URLSearchParams({ date: S.date });
  if (S.rout) q.set("scs", S.rout);
  if (S.rss !== 2.5) q.set("rss", S.rss);
  if (S.v !== 400) q.set("v", S.v);
  if (S.sc) q.set("conn", "sc");
  if (S.bg !== "field") q.set("bg", S.bg);
  if (S.focus !== "psp") q.set("focus", S.focus);
  if (S.ins !== "c3") q.set("ins", S.ins);
  if (params.get("theme")) q.set("theme", params.get("theme"));
  history.replaceState(null, "", "?" + q);
  const v = new URLSearchParams({ date: S.date, view: "fleet" });
  if (S.rout) v.set("scs", S.rout);
  if (S.rss !== 2.5) v.set("rss", S.rss);
  $("back").href = "./?" + v;
  // The same moment on HelioFleet: its map with the spirals at this speed, and
  // the sky as the focus spacecraft sees it (positions here are at 12:00 UTC).
  const t = `${S.date}T12:00Z`, f = new URLSearchParams({ t, spirals: 1 });
  if (S.v !== 400) f.set("wind", S.v);
  $("fleetLink").href = `${FLEET_URL}?${f}`;
  const name = BODIES.find(([k]) => k === S.focus)?.[1].replace(" / L1", "") || "Earth";
  $("fleetSky").href = `${FLEET_URL}sky.html?${new URLSearchParams({ t, obs: S.focus })}`;
  $("fleetSky").textContent = `Sky from ${name} on HelioFleet ↗`;
}

// ------------------------------------------------------------- solving
async function run() {
  const status = $("status");
  status.className = "status"; status.textContent = `Solving ${S.date}…`;
  try {
    const idx = await historyIndex(), { rot, exact } = rotationFor(idx, S.date), pos = await fleetFor(S.date);
    const res = await call({ type: "solve", url: new URL(`data/history/${rot.file}`, location.href).href, key: rot.cr, scale: idx.scale_G,
      shape: idx.shape, rss: S.rss, rout: S.rout, fleet: pos.fleet },
    (stage, f) => { status.textContent = `Solving ${S.date}: ${stage} ${Math.round(100 * f)}%`; });
    sol = { ...res, pos, rot, exact };
    // Direction of travel (inertial) for ram-side imagers: tomorrow's position,
    // moved back by one day of the Carrington frame's rotation.
    try {
      const nx = (await fleetFor(addDays(S.date, 1))).fleet, rate = 360 / 25.38;
      sol.timelineNext = Object.fromEntries(Object.entries(nx).filter(([, b]) => b.lon != null)
        .map(([k, b]) => [k, [b.r * geo.AU_RS * Math.cos(b.lat * DEG) * Math.cos((b.lon + rate) * DEG), b.r * geo.AU_RS * Math.cos(b.lat * DEG) * Math.sin((b.lon + rate) * DEG), b.r * geo.AU_RS * Math.sin(b.lat * DEG)]]));
    } catch (e) { sol.timelineNext = null; }
    status.className = exact ? "status" : "status warn";
    status.textContent = `Field: SDO/HMI rotation map CR ${rot.cr} (${rot.start.slice(0, 10)} to ${rot.stop.slice(0, 10)})`
      + (exact ? "" : `, the nearest to ${S.date}: no rotation map covers this date yet`) + ` · ${res.meta.model.name}`
      + `${S.rout ? `, cusp ${res.meta.model.rcp} R☉, edge ${S.rout} R☉` : `, source surface ${S.rss.toFixed(1)} R☉`} · positions at 12:00 UTC.`;
    await afterSolve(true);
  } catch (err) {
    status.className = "status warn"; status.textContent = "Could not compute: " + err.message;
  }
}

// The speed each body is connected at: the chosen one, or (self-consistent)
// iterated with the footpoint's own WSA-type speed until it repeats.
function speedFor(key) {
  if (!S.sc) return S.v;
  const byV = new Map(sol.rows.filter((r) => r.body === key).map((r) => [r.v, r]));
  let v = S.v;
  const seen = [];
  for (let k = 0; k < 30; k++) {
    const r = byV.get(v);
    if (!r?.vwsa) return v;
    const next = Math.max(200, Math.min(900, Math.round(r.vwsa / 25) * 25));
    if (next === v) return v;
    if (seen.includes(next)) {
      const cyc = seen.slice(seen.indexOf(next)).concat(v);
      return cyc.reduce((a, b) => (Math.abs((byV.get(a)?.vwsa ?? 1e9) - a) <= Math.abs((byV.get(b)?.vwsa ?? 1e9) - b) ? a : b));
    }
    seen.push(v); v = next;
  }
  return v;
}

// Everything that follows from the solution: one row per body.
function connections() {
  const rEdge = sol.meta.model.rout || sol.meta.model.rss, t = Date.parse(S.date + "T12:00:00Z");
  const sign = (lon, lat) => {             // photospheric B_r of the model at a footpoint
    const i = Math.min(179, Math.max(0, Math.floor(lat + 90))), j = Math.floor(((lon % 360) + 360) % 360) % 360;
    return sol.phot[i * 360 + j] >= 0 ? 1 : -1;
  };
  const out = [];
  for (const [key, name] of BODIES) {
    const b = sol.pos.fleet[key];
    if (!b || b.lon == null) continue;
    const v = speedFor(key), idx = sol.rows.findIndex((r) => r.body === key && r.v === v);
    if (idx < 0) continue;
    const row = sol.rows[idx], cloud = [];
    sol.rows.forEach((r, i) => {
      if (r.body !== key || Math.abs(r.v - v) > 100) return;
      if (r.foot) cloud.push({ lon: r.foot[0], lat: r.foot[1] });
      for (const list of sol.ensemble) { const e = list[i]; if (e) cloud.push({ lon: e[0], lat: e[1] }); }
    });
    const agree = cloud.length ? cloud.filter((f) => sign(f.lon, f.lat) === row.pol).length / cloud.length : null;
    // Travel time from the model's outer boundary; for a spacecraft inside
    // the SCS domain, from the cusp surface along its own field line.
    const rFrom = row.inside ? sol.meta.model.rcp : rEdge;
    const dt = geo.travelMs(b.r, rFrom, v), dtSlow = geo.travelMs(b.r, rFrom, Math.max(200, v - 100)), dtFast = geo.travelMs(b.r, rFrom, Math.min(900, v + 100));
    out.push({ key, name, b, v, row, idx, cloud, agree, src: t - dt, dt, win: [t - dtSlow - 6 * 3600000, t - dtFast + 6 * 3600000] });
  }
  return out;
}

async function afterSolve(full = false) {
  if (!sol) return;
  sol.conn = connections();
  if (!sol.conn.some((c) => c.key === S.focus)) { S.focus = sol.conn[0]?.key || "earth"; syncUrl(); }
  drawTable(); drawMap(); setupObsBodies(); drawSky();
  if (full || !timeline || timeline.v !== S.v) loadTimeline();
  loadObservations();
}

// ------------------------------------------------------------- table
function drawTable() {
  const rEdge = sol.meta.model.rout || sol.meta.model.rss;
  const head = `<thead><tr><th>Spacecraft</th><th>Distance</th><th>Wind</th><th>Travel time</th><th>Source time (UTC)</th>
    <th>At ${rEdge} R☉</th><th>Footpoint</th><th>f<sub>s</sub></th><th>DCHB</th><th>v<sub>WSA</sub></th><th>Polarity</th><th>Agreement</th><th>To current sheet</th><th>Observed</th></tr></thead>`;
  const rows = sol.conn.map((c) => {
    const r = c.row, n = matches.filter((m) => m.key === c.key);
    const obs = n.length ? `${n.filter((m) => m.inMain).length} contain · ${n.length} total` : '<span class="faint">none</span>';
    return `<tr data-key="${c.key}" class="${c.key === S.focus ? "sel" : ""}" tabindex="0">
      <td><span class="dot" style="background:${color(c.key)}"></span>${c.name}</td>
      <td>${c.b.r.toFixed(3)} au</td><td>${c.v} km/s${S.sc ? '<span class="faint"> (sc)</span>' : ""}</td>
      <td>${fmtDur(c.dt)}</td><td>${fmtT(c.src)}</td>
      <td>${r.inside ? `<span class="faint" title="Inside the current-sheet model's domain: traced from the spacecraft itself">at the spacecraft, ${r.r.toFixed(1)} R☉</span>` : `${r.ss[0].toFixed(1)}°, ${r.ss[1] >= 0 ? "+" : ""}${r.ss[1].toFixed(1)}°`}</td>
      <td>${r.foot ? `${r.foot[0].toFixed(1)}°, ${r.foot[1] >= 0 ? "+" : ""}${r.foot[1].toFixed(1)}°` : '<span class="faint">does not reach</span>'}</td>
      <td>${r.fs != null ? r.fs.toFixed(1) : "–"}</td><td>${r.dchb != null ? r.dchb.toFixed(1) + "°" : "–"}</td><td>${r.vwsa != null ? r.vwsa.toFixed(0) + " km/s" : "–"}</td>
      <td><span class="pol ${r.pol > 0 ? "out" : "in"}">${r.pol > 0 ? "outward" : "inward"}</span></td>
      <td>${c.agree != null ? Math.round(100 * c.agree) + "%" : "–"}</td>
      <td>${r.sheetDeg != null ? r.sheetDeg.toFixed(1) + "°" : "–"}</td><td>${obs}</td></tr>`;
  }).join("");
  $("table").innerHTML = head + `<tbody>${rows || '<tr><td class="empty" colspan="14">No in-situ spacecraft on this date.</td></tr>'}</tbody>`;
  root.style.setProperty("--pos", T().pos); root.style.setProperty("--neg", T().neg);
  for (const tr of $("table").querySelectorAll("tbody tr[data-key]")) {
    const pick = () => { S.focus = tr.dataset.key; syncUrl(); drawTable(); drawMap(); setupObsBodies(); loadObservations(); };
    tr.onclick = pick; tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  }
}

// ------------------------------------------------------------- source map
const MAP = { x0: 64, y0: 18, w: 1352, h: 676 };
function drawMap() {
  const cv = $("map"), g = cv.getContext("2d"), th = T(), cs = getComputedStyle(root);
  const ink = cs.getPropertyValue("--text").trim(), muted = cs.getPropertyValue("--muted").trim();
  g.fillStyle = cs.getPropertyValue("--card").trim(); g.fillRect(0, 0, cv.width, cv.height);
  const { x0, y0, w, h } = MAP, X = (lon) => x0 + (((lon % 360) + 360) % 360) / 360 * w, Y = (lat) => y0 + (90 - lat) / 180 * h;
  // Background: the model's photospheric field, or its open-field regions.
  const img = g.createImageData(360, 180), lut = divergingLUT(), hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const cp = hex(th.pos), cn = hex(th.neg), cc = hex(th.occluder);
  for (let i = 0; i < 180; i++) for (let j = 0; j < 360; j++) {
    const src = i * 360 + j, dst = 4 * ((179 - i) * 360 + j);
    let c;
    if (S.bg === "open") { const p = sol.pol[src]; c = p > 0 ? cp : p < 0 ? cn : cc; }
    else { const s = Math.max(-1, Math.min(1, sol.phot[src] / 20)), k = Math.round((s + 1) / 2 * 255) * 4; c = [lut[k], lut[k + 1], lut[k + 2]]; }
    img.data.set([c[0], c[1], c[2], 255], dst);
  }
  const off = new OffscreenCanvas(360, 180); off.getContext("2d").putImageData(img, 0, 0);
  g.imageSmoothingEnabled = S.bg !== "open";
  g.drawImage(off, x0, y0, w, h);
  // Axes.
  g.strokeStyle = muted; g.lineWidth = 1; g.strokeRect(x0, y0, w, h);
  g.font = "15px system-ui, sans-serif"; g.fillStyle = muted; g.textAlign = "center";
  for (let lon = 0; lon <= 360; lon += 30) g.fillText(String(lon), X(lon === 360 ? 359.999 : lon), y0 + h + 22);
  g.fillText("Carrington longitude [°]", x0 + w / 2, y0 + h + 46);
  g.textAlign = "right";
  for (let lat = -90; lat <= 90; lat += 30) g.fillText(String(lat), x0 - 8, Y(lat) + 5);
  // Neutral line(s).
  const line = (pts, dash, width, col) => {
    g.setLineDash(dash); g.lineWidth = width; g.strokeStyle = col; g.beginPath();
    for (let k = 0; k < pts.length; k += 2) {
      const x = X(pts[k]), y = Y(pts[k + 1]);
      if (k && Math.abs(pts[k] - pts[k - 2]) > 180) g.moveTo(x, y); else if (k) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke(); g.setLineDash([]);
  };
  for (const h0 of sol.meta.hcs || []) line(h0, [], 2.5, th.hcs);
  if (S.rout) for (const h0 of sol.meta.hcs_out || []) line(h0, [9, 6], 2, th.hcs);
  // Observation footprints of the focused body's source region.
  const focusMatches = matches.filter((m) => m.key === S.focus);
  g.lineWidth = 1.6;
  for (const m of focusMatches) {
    const pts = geo.footprintCarrington(m.row, earthAtCache(m.tm));
    g.strokeStyle = m.inMain ? ink : muted; g.beginPath();
    pts.forEach(([lon, lat], k) => { const x = X(lon), y = Y(lat); k && Math.abs(lon - pts[k - 1][0]) < 180 ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.closePath(); g.stroke();
  }
  // Each body: spread, outer-boundary point, footpoint.
  const placed = [];
  for (const c of sol.conn) {
    const col = color(c.key), r = c.row, focus = c.key === S.focus;
    g.globalAlpha = focus ? 0.55 : 0.3; g.fillStyle = col;
    for (const f of c.cloud) { g.beginPath(); g.arc(X(f.lon), Y(f.lat), 2.6, 0, 2 * Math.PI); g.fill(); }
    g.globalAlpha = 1;
    const sx = X(r.ss[0]), sy = Y(r.ss[1]);
    g.fillStyle = col; g.strokeStyle = th.bg; g.lineWidth = 2;
    g.fillRect(sx - 6, sy - 6, 12, 12); g.strokeRect(sx - 6, sy - 6, 12, 12);
    if (!r.foot) continue;
    const fx = X(r.foot[0]), fy = Y(r.foot[1]);
    if (Math.abs(r.ss[0] - r.foot[0]) < 180) {
      g.setLineDash([5, 5]); g.strokeStyle = col; g.lineWidth = focus ? 2 : 1.2; g.beginPath(); g.moveTo(sx, sy); g.lineTo(fx, fy); g.stroke(); g.setLineDash([]);
    }
    g.beginPath(); g.arc(fx, fy, focus ? 9 : 7, 0, 2 * Math.PI); g.fillStyle = col; g.fill(); g.lineWidth = 2.5; g.strokeStyle = th.bg; g.stroke();
    // Labels avoid each other.
    g.font = `${focus ? 600 : 400} 15px system-ui, sans-serif`;
    const tw = g.measureText(c.name).width;
    let lx = fx + 12, ly = fy - 10;
    for (const dy of [0, 22, -22, 44, -44]) {
      const box = [lx, ly + dy - 14, lx + tw, ly + dy + 4];
      if (!placed.some((p) => box[0] < p[2] && p[0] < box[2] && box[1] < p[3] && p[1] < box[3])) { ly += dy; placed.push(box); break; }
    }
    g.fillStyle = cs.getPropertyValue("--card").trim(); g.globalAlpha = 0.75; g.fillRect(lx - 3, ly - 15, tw + 6, 20); g.globalAlpha = 1;
    g.fillStyle = ink; g.textAlign = "left"; g.fillText(c.name, lx, ly);
  }
  $("mapLegend").innerHTML = [
    `<span><i style="background:${th.hcs}"></i>neutral line at ${sol.meta.model.rcp || S.rss} R☉</span>`,
    S.rout ? `<span><i style="background:repeating-linear-gradient(90deg,${th.hcs} 0 6px,transparent 6px 10px)"></i>current sheet at ${S.rout} R☉</span>` : "",
    `<span><i class="box" style="background:${muted}"></i>square: where the spiral meets the model's outer boundary</span>`,
    `<span><i class="box" style="background:${muted};border-radius:50%"></i>circle: footpoint · dots: spread</span>`,
    focusMatches.length ? `<span><i style="background:${ink}"></i>outlines: observations of ${sol.conn.find((c) => c.key === S.focus)?.name} (bright: contain the footpoint)</span>` : "",
    S.bg === "open" ? `<span><i class="box" style="background:${th.pos}"></i>open outward <i class="box" style="background:${th.neg}"></i>open inward</span>` : `<span>B<sub>r</sub> of the smoothed model map, ±20 G</span>`,
  ].join("");
}

// ------------------------------------------------------------- timeline
async function loadTimeline() {
  const days = Array.from({ length: 27 }, (_, k) => addDays(S.date, k - 13));
  try {
    const fleets = await Promise.all(days.map((d) => fleetFor(d).then((p) => ({ day: d, fleet: p.fleet })).catch(() => null)));
    const res = await call({ type: "timeline", days: fleets.filter(Boolean), v: S.v });
    timeline = { v: S.v, days: res.days };
    drawTimeline();
  } catch (e) { timeline = null; }
}
function drawTimeline() {
  const cv = $("timeline"), g = cv.getContext("2d"), th = T(), cs = getComputedStyle(root);
  const ink = cs.getPropertyValue("--text").trim(), muted = cs.getPropertyValue("--muted").trim();
  const bodies = BODIES.filter(([k]) => timeline?.days.some((d) => d.bodies[k]));
  cv.height = 70 + 40 * Math.max(1, bodies.length);
  g.fillStyle = cs.getPropertyValue("--card").trim(); g.fillRect(0, 0, cv.width, cv.height);
  if (!timeline) return;
  const x0 = 200, w = cv.width - x0 - 20, n = timeline.days.length, cw = w / n;
  g.font = "15px system-ui, sans-serif";
  bodies.forEach(([k, name], i) => {
    const y = 20 + i * 40;
    g.fillStyle = color(k); g.beginPath(); g.arc(14, y + 15, 6, 0, 2 * Math.PI); g.fill();
    g.fillStyle = ink; g.textAlign = "left"; g.fillText(name, 28, y + 20);
    timeline.days.forEach((d, j) => {
      const b = d.bodies[k];
      if (!b || !b.pol) return;
      g.fillStyle = b.pol > 0 ? th.pos : th.neg;
      g.globalAlpha = b.sheetDeg != null && b.sheetDeg < 5 ? 0.35 : 0.95;
      g.fillRect(x0 + j * cw + 1, y + 2, cw - 2, 28);
    });
    g.globalAlpha = 1;
  });
  const k0 = timeline.days.findIndex((d) => d.day === S.date);
  if (k0 >= 0) { g.strokeStyle = ink; g.lineWidth = 3; g.strokeRect(x0 + k0 * cw, 14, cw, 40 * bodies.length + 2); }
  g.fillStyle = muted; g.textAlign = "center";
  timeline.days.forEach((d, j) => { if (j % 3 === 1) g.fillText(d.day.slice(5), x0 + (j + 0.5) * cw, cv.height - 22); });
  g.textAlign = "left";
  g.fillStyle = th.pos; g.fillRect(x0, cv.height - 12, 12, 10); g.fillStyle = muted; g.fillText("outward", x0 + 16, cv.height - 2);
  g.fillStyle = th.neg; g.fillRect(x0 + 100, cv.height - 12, 12, 10); g.fillStyle = muted; g.fillText("inward", x0 + 116, cv.height - 2);
  g.fillText(`at ${timeline.v} km/s; pale: within 5° of the current sheet`, x0 + 200, cv.height - 2);
  cv.onclick = (e) => {
    const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) * cv.width / r.width, j = Math.floor((x - x0) / cw);
    if (j >= 0 && j < n) { S.date = timeline.days[j].day; $("date").value = S.date; syncUrl(); run(); }
  };
}

// ------------------------------------------------------------- observations
let earthSamples = [];
const earthAtCache = (t) => geo.interpolate(earthSamples, t);
function setupObsBodies() {
  $("obsBodies").innerHTML = sol.conn.map((c) => `<button type="button" data-k="${c.key}" class="${c.key === S.focus ? "on" : ""}" aria-pressed="${c.key === S.focus}">${c.name}</button>`).join("");
  for (const b of $("obsBodies").querySelectorAll("button")) b.onclick = () => { S.focus = b.dataset.k; syncUrl(); drawTable(); drawMap(); setupObsBodies(); loadObservations(); };
}
async function obsMonth(ym) {
  if (!obsCache.has(ym)) obsCache.set(ym, fetch(`${FLEET_URL}data/obs/${ym}.json`).then((r) => (r.ok ? r.json() : { rows: [] })).then((d) => d.rows || []).catch(() => []));
  return obsCache.get(ym);
}
async function loadObservations() {
  const ticket = (loadObservations.n = (loadObservations.n || 0) + 1);
  const c = sol.conn.find((x) => x.key === S.focus);
  const tbl = $("obs");
  if (!c) { tbl.innerHTML = ""; return; }
  tbl.innerHTML = `<tbody><tr><td class="empty">Searching HelioFleet's observations…</td></tr></tbody>`;
  const [from, to] = c.win;
  // Earth's position through the window, for the projections.
  const days = [];
  for (let t = from - DAY; t <= to + 2 * DAY; t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
  const pos = await Promise.all(days.map((d) => fleetFor(d).then((p) => ({ t: Date.parse(d + "T12:00:00Z"), lon: p.L0, lat: p.B0, r: p.fleet.earth?.r ?? 1 })).catch(() => null)));
  earthSamples = pos.filter(Boolean);
  const months = [...new Set([from, to].map((t) => new Date(t).toISOString().slice(0, 7)))];
  const rows = (await Promise.all(months.map(obsMonth))).flat();
  if (ticket !== loadObservations.n) return;
  const feet = c.row.foot ? [{ lon: c.row.foot[0], lat: c.row.foot[1] }, ...c.cloud] : c.cloud;
  const found = feet.length ? geo.matchObservations(rows, feet, from, to, earthAtCache) : [];
  matches = matches.filter((m) => m.key !== c.key).concat(found.map((m) => ({ ...m, key: c.key })));
  $("obsSub").innerHTML = `Observations from <a href="${FLEET_URL}sky.html#observations">HelioFleet</a> (IRIS, Hinode/EIS, DKIST, Solar Orbiter EUI-HRI, PHI-HRT and SPICE) made between <b>${fmtT(from)}</b> and <b>${fmtT(to)}</b> UTC: the source-time window of ${c.name} for ${Math.max(200, c.v - 100)}–${Math.min(900, c.v + 100)} km/s, ±6 h. Listed when the field contains the footpoint or lies within 5° of its spread.`;
  if (!found.length) {
    tbl.innerHTML = `<tbody><tr><td class="empty">${feet.length ? "No catalogued high-resolution observation of this source region in the window." : "This connection does not reach the photosphere."}</td></tr></tbody>`;
  } else {
    tbl.innerHTML = `<thead><tr><th>Instrument</th><th>Start (UTC)</th><th>End</th><th>View</th><th>Footpoint</th><th>Spread inside</th><th>Programme</th><th>Links</th></tr></thead><tbody>` +
      found.slice(0, 200).map((m) => {
        const r = m.row, sky = `${FLEET_URL}sky.html?t=${encodeURIComponent(r.t0.slice(0, 16) + "Z")}${r.f === "S" ? "&obs=solo" : ""}&hl=${encodeURIComponent(r.id)}#observations`;
        return `<tr><td>${INS_NAMES[r.i] || r.i}</td><td>${r.t0.slice(0, 16).replace("T", " ")}</td><td>${(r.t1 || r.t0).slice(11, 16)}</td>
          <td>${r.f === "S" ? "Solar Orbiter" : "Earth"}</td><td>${m.inMain ? "<b>inside</b>" : m.nearDeg === 0 ? "spread inside" : m.nearDeg < 0.05 ? "at the edge" : `${m.nearDeg.toFixed(1)}° away`}</td>
          <td>${Math.round(100 * m.share)}%</td><td title="${(r.n || "").replace(/"/g, "&quot;")}">${(r.n || "").slice(0, 46)}${(r.n || "").length > 46 ? "…" : ""}</td>
          <td>${r.u ? `<a href="${r.u}" target="_blank" rel="noopener">data</a> · ` : ""}<a href="${sky}" target="_blank" rel="noopener">HelioFleet</a></td></tr>`;
      }).join("") + "</tbody>";
  }
  drawTable(); drawMap();
}

// ------------------------------------------------------------- coronagraphs
const flying = (ins, day) => (!ins.from || day >= ins.from) && !(ins.gaps || []).some(([a, b]) => day >= a && day < b);
function instruments() {
  return INSTRUMENTS.filter((i) => flying(i, S.date) && sol.pos.fleet[i.sc]?.lon != null);
}
function drawSky() {
  const list = instruments(), sel = $("ins");
  if (!list.some((i) => i.id === S.ins)) S.ins = list[0]?.id || "";
  sel.innerHTML = list.map((i) => `<option value="${i.id}"${i.id === S.ins ? " selected" : ""}>${i.name}</option>`).join("");
  const ins = list.find((i) => i.id === S.ins), cv = $("sky"), g = cv.getContext("2d"), th = T(), cs = getComputedStyle(root);
  const ink = cs.getPropertyValue("--text").trim(), muted = cs.getPropertyValue("--muted").trim(), card = cs.getPropertyValue("--card").trim();
  g.fillStyle = card; g.fillRect(0, 0, cv.width, cv.height);
  if (!ins) { $("skyLegend").textContent = "No coronagraph is flying on this date."; return; }
  const ob = sol.pos.fleet[ins.sc], rObs = ob.r * geo.AU_RS, cam = geo.skyCamera(ob.lon, ob.lat, rObs);
  const S0 = cv.width / 2, deg = ins.unit === "deg";
  const half = ins.outer * 1.08, scale = S0 / half;
  // Display coordinates: plane-of-sky solar radii, or elongation (azimuthal
  // equidistant) for the wide-field imagers.
  const toXY = (p) => {
    const s = geo.skyPoint(cam, p);
    if (!s.front) return null;
    if (deg) { const a = s.pa * DEG; return [S0 - s.elong * Math.sin(a) * scale, S0 - s.elong * Math.cos(a) * scale]; }   // east left
    return [S0 + s.x * scale, S0 - s.y * scale];
  };
  const sunR = deg ? Math.asin(1 / rObs) / DEG : 1;
  const rIn = sol.meta.model.rcp || S.rss, rTop = sol.meta.model.rout || S.rss;
  const rMax = deg ? Math.min(3 * geo.AU_RS, rObs * 2.5) : ins.outer * 1.6;
  const OMEGA = geo.OMEGA, wind = S.v;
  const cart = (r, lon, lat) => [r * Math.cos(lat * DEG) * Math.cos(lon * DEG), r * Math.cos(lat * DEG) * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
  // Thomson-scattering weight: structures near the plane of the sky (the
  // plane through Sun centre perpendicular to the line of sight) show best.
  const weight = (p) => { const r = Math.hypot(...p), c = Math.abs(p[0] * cam.f[0] + p[1] * cam.f[1] + p[2] * cam.f[2]) / r; return Math.exp(-((Math.asin(Math.min(1, c)) / DEG / 22) ** 2)); };
  const strand = (pts, col, width, alphaMax) => {
    g.strokeStyle = col; g.lineWidth = width;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      if (geo.hiddenBySun(cam, a) || geo.hiddenBySun(cam, b)) continue;
      const A = toXY(a), B = toXY(b);
      if (!A || !B) continue;
      g.globalAlpha = alphaMax * (0.03 + 0.97 * weight(b));
      g.beginPath(); g.moveTo(...A); g.lineTo(...B); g.stroke();
    }
    g.globalAlpha = 1;
  };
  const radii = Array.from({ length: 50 }, (_, j) => rTop * Math.pow(rMax / rTop, j / 49));
  const wound = (lon, lat) => radii.map((r) => cart(r, lon - (OMEGA * (r - rTop) * 695700 / wind) / DEG, lat));
  // Open field lines, continued as Parker spirals beyond the model's edge.
  const xyz = sol.lines.xyz, counts = sol.lines.counts, kind = sol.meta.kind;
  for (let i = 0, o = 0; i < counts.length; o += 3 * counts[i], i++) {
    if (!kind[i] || i % 2) continue;
    const pts = [];
    for (let k = 0; k < counts[i]; k++) pts.push([xyz[o + 3 * k], xyz[o + 3 * k + 1], xyz[o + 3 * k + 2]]);
    const e = pts[pts.length - 1], r0 = Math.hypot(...e);
    if (r0 > rTop * 0.95) {
      const lon0 = Math.atan2(e[1], e[0]) / DEG, lat0 = Math.asin(e[2] / r0) / DEG;
      for (const r of radii) if (r > r0) pts.push(cart(r, lon0 - (OMEGA * (r - r0) * 695700 / wind) / DEG, lat0));
    }
    strand(pts, kind[i] > 0 ? th.pos : th.neg, 1.2, 0.6);
  }
  // The current sheet: SCS ribs from the cusp surface, then wound strands.
  const sheet = S.rout ? sol.meta.hcs_out || [] : sol.meta.hcs || [];
  if (S.rout) for (const ribs of sol.meta.hcs_ribs || []) for (let k = 0; k < ribs.length; k += 2) {
    const rb = ribs[k], pts = [];
    for (let q = 0; q < rb.length; q += 3) pts.push(cart(rb[q + 2], rb[q], rb[q + 1]));
    strand(pts, th.hcs, 1.6, 0.9);
  }
  for (const h of sheet) for (let k = 0; k < h.length; k += 8) strand(wound(h[k], h[k + 1]), th.hcs, 1.6, 0.9);
  for (const h of sol.meta.hcs || []) { const pts = []; for (let k = 0; k < h.length; k += 2) pts.push(cart(rIn, h[k], h[k + 1])); strand(pts, th.hcs, 2.5, 1); }
  // The field of view: occulter, field, and the side for half-field imagers.
  const sideSign = (() => {
    if (ins.side === "east") return -1;
    if (ins.side === "earth") { const e = sol.pos.fleet.earth, s = geo.skyPoint(cam, cart(e.r * geo.AU_RS, e.lon, e.lat)); return Math.sign(s.x) || 1; }
    if (ins.side === "ram") {
      const next = sol.timelineNext?.[ins.sc];
      if (next) { const s = geo.skyPoint(cam, next); return Math.sign(s.x) || 1; }
    }
    return 0;
  })();
  g.fillStyle = card; g.globalAlpha = 0.92;
  g.beginPath(); g.arc(S0, S0, ins.inner * scale, 0, 2 * Math.PI); g.fill(); g.globalAlpha = 1;
  g.fillStyle = muted; g.beginPath(); g.arc(S0, S0, sunR * scale, 0, 2 * Math.PI); g.fill();
  g.strokeStyle = ink; g.lineWidth = 2; g.setLineDash([]);
  if (sideSign) {
    g.save(); g.beginPath(); g.rect(sideSign > 0 ? S0 : 0, 0, S0, cv.height); g.clip();
  }
  for (const r of [ins.inner, ins.outer]) { g.beginPath(); g.arc(S0, S0, r * scale, 0, 2 * Math.PI); g.stroke(); }
  if (sideSign) g.restore();
  g.fillStyle = card; g.globalAlpha = 0.6;
  g.beginPath(); g.rect(0, 0, cv.width, cv.height); g.arc(S0, S0, ins.outer * scale, 0, 2 * Math.PI, true); g.fill("evenodd");
  if (sideSign) g.fillRect(sideSign > 0 ? 0 : S0, 0, S0, cv.height);       // the side a half-field imager does not see
  g.globalAlpha = 1;
  // Labels.
  g.fillStyle = ink; g.font = "600 20px system-ui, sans-serif"; g.textAlign = "left";
  g.fillText(ins.name, 18, 32);
  g.font = "15px system-ui, sans-serif"; g.fillStyle = muted;
  g.fillText(`${S.date} · from ${ob.r.toFixed(3)} au · ${deg ? `elongation ${ins.inner}–${ins.outer}°` : `${ins.inner}–${ins.outer} R☉ in the plane of the sky`}`, 18, 56);
  g.fillText("N ↑   W →", cv.width - 110, cv.height - 18);
  $("skyLegend").innerHTML = `<span><i style="background:${th.hcs}"></i>current sheet${S.rout ? " (SCS ribs to " + S.rout + " R☉, then Parker spiral)" : " (Parker spiral beyond the source surface)"}</span>
    <span><i style="background:${th.pos}"></i><i style="background:${th.neg}"></i>open field, outward / inward</span>
    <span>circles: the instrument's field (inner occulter, outer edge)${sideSign ? "; half-field imager: the drawn side" : ""}</span>
    <span>wind ${S.v} km/s for the spirals</span>`;
}

// ------------------------------------------------------------- theme, start
const themeBtn = $("theme");
const themeLabel = () => { themeBtn.textContent = root.dataset.theme === "dark" ? "Light theme" : "Dark theme"; };
themeBtn.onclick = () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("hf.theme", root.dataset.theme); } catch (e) {}
  themeLabel(); if (sol) { drawTable(); drawMap(); drawTimeline(); drawSky(); }
};
themeLabel();
setupControls();
syncUrl();
run();
