// Observations page: the day's images from SDO/AIA, SOHO/LASCO, STEREO-A and
// Solar Orbiter (prepared by the heliofield-imagery repository: solar north
// up, with each observer's Carrington position, plate scale and Sun centre),
// with the model's field lines projected from that observer. The field is
// the day's PFSS product, or the HMI rotation map with the Schatten current
// sheet solved in the browser by the connectivity page's worker.

import { THEMES } from "./theme.js";
import { historyIndex, rotationFor, fleetFor } from "./history.js";
import "./totop.js";
import { enhance as datePicker } from "./datepicker.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement, params = new URLSearchParams(location.search);
const DEG = Math.PI / 180, ARCSEC = DEG / 3600, RSUN_KM = 695700, DAY = 86400000;
const OMEGA = 2 * Math.PI / (25.38 * 86400);
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
// Embed (?embed=1): four panels for a frame on another page; panels= picks
// them (ids from the images' index), each "a|b" taking the first present.
const EMBED = params.get("embed") === "1";
const EMBED_PANELS = (params.get("panels") || "aia193,lasco_c2,eui174|euvi_a,hmi|phi").split(",").map((s) => s.split("|"));
// Where the images live: their own repository's site, or a local copy.
const IMG = (params.get("imagery") || (LOCAL ? "http://localhost:8812/" : "https://sr-dash.github.io/heliofield-imagery/")).replace(/\/?$/, "/");
const FLEET_URL = "https://sr-dash.github.io/heliofleet/";
const S = {
  // Where each panel's slider starts: 100 shows the standard image, 0 the enhanced one.
  date: params.get("date"), view: ["std", "cmp", "enh"].includes(params.get("view")) ? params.get("view") : "cmp",
  model: ["5", "10", "21.5"].includes(params.get("scs")) ? params.get("scs") : params.get("scs") === "0" ? "hmi" : "daily",
  v: [300, 400, 500, 600, 700].includes(+params.get("v")) ? +params.get("v") : 400,
  closed: params.get("closed") !== "0", open: params.get("open") !== "0", sheet: params.get("sheet") !== "0", grid: params.get("grid") !== "0",
  alpha: Math.max(0, Math.min(100, +(params.get("alpha") ?? 100))),
  width: Math.max(0.3, Math.min(4, +(params.get("width") ?? 0.9))),            // line width, times the default
};
let dates = [], daily = new Set(), day = null, field = null, earthL0 = null, images = new Map(), split = new Map();
const SPLIT = { std: 100, cmp: 50, enh: 0 };
const fieldCache = new Map();
// Lines always use the dark-theme colours: they sit on dark images.
const C = THEMES.dark;

// ------------------------------------------------------------- data
const json = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });

async function dailyField(date) {
  const meta = await json(`data/${date}/meta.json`);
  const q = new Int16Array(await fetch(`data/${date}/lines.bin`).then((r) => r.arrayBuffer()));
  const lines = [], s = 1 / meta.qscale;
  let o = 0;
  meta.counts.forEach((n, i) => {
    if (i < meta.lines.kind.length) {
      const pts = new Float32Array(3 * n);
      for (let k = 0; k < 3 * n; k++) pts[k] = q[o + k] * s;
      lines.push({ pts, kind: meta.lines.kind[i] });
    }
    o += 3 * n;
  });
  return { lines, edge: meta.model.rss, sheets: [{ r: meta.model.rss, lines: meta.hcs || [] }], ribs: [], meta,
    label: `PFSS, ${meta.source.short || meta.source.name} map of ${meta.obstime.slice(0, 16).replace("T", " ")} UTC` };
}

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
  return new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject, onProgress }); worker.postMessage({ ...msg, id }); });
}
async function scsField(date, rout) {
  const idx = await historyIndex(), { rot, exact } = rotationFor(idx, date), pos = await fleetFor(date);
  const res = await call({ type: "solve", url: new URL(`data/history/${rot.file}`, location.href).href, key: rot.cr, scale: idx.scale_G,
    shape: idx.shape, rss: 2.5, rout, fleet: pos.fleet }, (stage, f) => { $("status").textContent = `Solving the field for ${date}: ${stage} ${Math.round(100 * f)}%`; });
  const { xyz, counts } = res.lines, lines = [];
  let o = 0;
  counts.forEach((n, i) => { lines.push({ pts: xyz.subarray(3 * o, 3 * (o + n)), kind: res.meta.kind[i] }); o += n; });
  const map = `HMI rotation map CR ${rot.cr}${exact ? "" : ", the nearest to this date"}`;
  if (!rout) return { lines, edge: res.meta.model.rss, ribs: [], sheets: [{ r: res.meta.model.rss, lines: res.meta.hcs || [] }], label: `PFSS, ${map}` };
  return { lines, edge: res.meta.model.rout, ribs: res.meta.hcs_ribs || [],
    sheets: [{ r: res.meta.model.rcp, lines: res.meta.hcs || [] }, { r: res.meta.model.rout, lines: res.meta.hcs_out || [] }],
    label: `PFSS + SCS to ${rout} R☉ (cusp ${res.meta.model.rcp} R☉), ${map}` };
}
// The day's product where there is one; before HelioField's daily products
// began, the HMI rotation map, solved here.
const modelFor = () => (S.model === "daily" && !daily.has(S.date) ? "hmi" : S.model);
async function getField() {
  const m = modelFor(), key = `${S.date}|${m}`;
  if (!fieldCache.has(key)) fieldCache.set(key, m === "daily" ? dailyField(S.date) : scsField(S.date, m === "hmi" ? 0 : +m));
  try { return await fieldCache.get(key); } catch (e) { fieldCache.delete(key); throw e; }
}

// One rendering of a panel: "std", or "enh" (WOW on disks, NRGF on
// coronagraphs). Loaded with CORS so a view can be downloaded.
function image(p, which) {
  const file = which === "enh" ? p.files.enh || p.files.wow : p.files.std;
  if (!file) return Promise.resolve(null);
  const url = IMG + `days/${S.date}/${file}`;
  if (!images.has(url)) images.set(url, new Promise((ok, fail) => {
    const im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => ok(im); im.onerror = () => fail(new Error(`image ${url}`)); im.src = url;
  }));
  return images.get(url).catch(() => null);
}
const pair = (p) => Promise.all([image(p, "std"), image(p, "enh")]);
const methods = (p) => ({ std: p.methods?.std || "standard", enh: p.methods?.enh || (p.files.wow ? "WOW" : null) });

// ------------------------------------------------------------- projection
// The observer's frame (SunPy's heliocentric/Thompson): z towards the
// observer, x towards solar west, y towards solar north; helioprojective
// angles from there, then pixels of the north-up image.
function camera(p) {
  const L = p.observer.lon * DEG, B = p.observer.lat * DEG;
  const o = [Math.cos(B) * Math.cos(L), Math.cos(B) * Math.sin(L), Math.sin(B)];
  const x = [-Math.sin(L), Math.cos(L), 0];
  const y = [o[1] * x[2] - o[2] * x[1], o[2] * x[0] - o[0] * x[2], o[0] * x[1] - o[1] * x[0]];
  const D = p.observer.r_rs, k = 1 / (p.scale_arcsec * ARCSEC), [cx, cy] = p.center;
  const outer = p.fov_rs ? p.fov_rs[1] : Infinity;
  return {
    o, D, lon: p.observer.lon,
    // [px, py, visible, plane-of-sky weight]
    at(q) {
      const X = q[0] * x[0] + q[1] * x[1] + q[2] * x[2], Y = q[0] * y[0] + q[1] * y[1] + q[2] * y[2], Z = q[0] * o[0] + q[1] * o[1] + q[2] * o[2];
      const dz = D - Z, tx = Math.atan2(X, dz), ty = Math.asin(Y / Math.hypot(X, Y, dz)), rho = Math.hypot(X, Y);
      const vis = !(Z < 0 && rho < 1) && rho <= outer;
      const r = Math.hypot(X, Y, Z), w = Math.exp(-((Math.asin(Math.min(1, Math.abs(Z) / r)) / DEG / 25) ** 2));
      return [cx + tx * k, cy - ty * k, vis, w, Z > 0 && rho < 1];      // last: in front of the disk
    },
    // How far out [R_sun] the image reaches, for continuing the field.
    reach: D * Math.tan(Math.hypot(p.width, p.height) / 2 * p.scale_arcsec * ARCSEC),
  };
}
const cart = (r, lon, lat) => [r * Math.cos(lat * DEG) * Math.cos(lon * DEG), r * Math.cos(lat * DEG) * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
// Radii from r0 to r1, denser near the Sun.
const radii = (r0, r1, n = 40) => Array.from({ length: n }, (_, j) => r0 * Math.pow(r1 / r0, (j + 1) / n));
// Beyond the model's edge, open field follows a Parker spiral at speed v.
function spiral(lon0, lat0, r0, r1) { return radii(r0, r1).map((r) => cart(r, lon0 - (OMEGA * (r - r0) * RSUN_KM / S.v) / DEG, lat0)); }

// ------------------------------------------------------------- drawing
function draw(cv, p, ims, f, at = 100) {
  cv.width = p.width; cv.height = p.height;
  const g = cv.getContext("2d"), [std, enh] = ims || [];
  g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height);
  if (std) g.drawImage(std, 0, 0, cv.width, cv.height);
  // The comparison: the enhanced image right of the divider.
  const xs = cv.width * at / 100;
  if (enh && at < 100) {
    g.save(); g.beginPath(); g.rect(xs, 0, cv.width - xs, cv.height); g.clip();
    g.drawImage(enh, 0, 0, cv.width, cv.height); g.restore();
  }
  const lw = Math.max(1.6, cv.width / 330) * S.width, A = S.alpha / 100;
  if (f) overlay(g, p, f, lw, A);
  if (S.grid) grid(g, p, camera(p), lw / S.width * 0.7);
  if (enh && at > 0 && at < 100) {
    const m = methods(p), s = cv.width / 520;
    g.globalAlpha = 1; g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = 2 * s;
    g.beginPath(); g.moveTo(xs, 0); g.lineTo(xs, cv.height); g.stroke();
    g.font = `600 ${Math.round(12 * s)}px system-ui, sans-serif`;
    const tag = (txt, x, align) => {
      g.textAlign = align; const w = g.measureText(txt).width + 10 * s, x0 = align === "right" ? x - w : x;
      g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(x0, 6 * s, w, 20 * s);
      g.fillStyle = "#fff"; g.fillText(txt, align === "right" ? x - 5 * s : x + 5 * s, 21 * s);
    };
    tag(m.std, xs - 4 * s, "right"); tag(m.enh, xs + 4 * s, "left"); g.textAlign = "left";
  }
}

// The field lines, each as one path over a thin dark halo, so they read on
// bright and dark images alike.
function overlay(g, p, f, lw, A) {
  const cam = camera(p), coro = p.kind === "coronagraph", rMax = Math.min(60, cam.reach * 1.1);
  g.lineCap = "round"; g.lineJoin = "round";
  // front: how to draw the parts that lie in front of the solar disk ("same"
  // or "dashed"). High-lying structure there projects onto the disk but is
  // not seen against it.
  const stroke = (pts, col, width, alpha, front = "same") => {
    const cs = pts.map((q) => cam.at(q)), wn = cs.filter((c) => c[2]);
    if (wn.length < 2) return;
    const a = alpha * (coro ? 0.3 + 0.7 * wn.reduce((t, c) => t + c[3], 0) / wn.length : 1);
    for (const part of front === "dashed" ? ["off", "on"] : ["all"]) {
      g.beginPath();
      let pen = false;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i], keep = c[2] && (part === "all" || (part === "on") === c[4] || (i && (part === "on") === cs[i - 1][4]));
        if (keep) { pen ? g.lineTo(c[0], c[1]) : g.moveTo(c[0], c[1]); pen = true; } else pen = false;
      }
      const dash = part === "on";
      g.setLineDash(dash ? [width * 2.2, width * 1.8] : []);
      g.globalAlpha = a * (dash ? 0.3 : 0.5); g.strokeStyle = "#000"; g.lineWidth = width + lw * 1.1; g.stroke();
      g.globalAlpha = a * (dash ? 0.6 : 1); g.strokeStyle = col; g.lineWidth = dash ? width * 0.75 : width; g.stroke();
    }
    g.setLineDash([]);
  };
  const asPoints = (flat) => { const out = []; for (let k = 0; k < flat.length; k += 3) out.push([flat[k], flat[k + 1], flat[k + 2]]); return out; };
  for (const l of f.lines) {
    if (l.kind === 0 ? !S.closed : !S.open) continue;
    const pts = asPoints(l.pts), col = l.kind === 0 ? C.closed : l.kind > 0 ? C.pos : C.neg;
    stroke(pts, col, lw * (l.kind === 0 ? 1 : 1.15), A * (l.kind === 0 ? 0.85 : 0.95));
    if (l.kind !== 0) {
      // The spiral beyond the model's edge is an assumption, drawn fainter.
      const e = pts[pts.length - 1], r0 = Math.hypot(...e);
      if (r0 > f.edge * 0.95 && rMax > r0) stroke([e, ...spiral(Math.atan2(e[1], e[0]) / DEG, Math.asin(e[2] / r0) / DEG, r0, rMax)], col, lw * 0.8, A * 0.4);
    }
  }
  if (S.sheet) {
    for (const s of f.sheets) for (const h of s.lines) {
      const pts = []; for (let k = 0; k < h.length; k += 2) pts.push(cart(s.r, h[k], h[k + 1]));
      stroke(pts, C.hcs, lw * 2.4, Math.min(1, A + 0.25), "dashed");
    }
    for (const ribs of f.ribs) for (let k = 0; k < ribs.length; k += 2) {
      const rb = ribs[k], pts = [];
      for (let q = 0; q < rb.length; q += 3) pts.push(cart(rb[q + 2], rb[q], rb[q + 1]));
      stroke(pts, C.hcs, lw * 1.6, A, "dashed");
    }
    const outer = f.sheets[f.sheets.length - 1];
    if (coro && rMax > outer.r) for (const h of outer.lines) for (let k = 0; k < h.length; k += 14) stroke(spiral(h[k], h[k + 1], outer.r, rMax), C.hcs, lw * 1.4, A * 0.6, "dashed");
  }
  g.globalAlpha = 1;
}

// Orientation: the heliographic grid on the disk (Stonyhurst, every 15°;
// the equator and central meridian stronger), the limb, the north pole, and
// for coronagraphs rings at fixed heights; a north arrow and E/W in a corner.
function grid(g, p, cam, lw) {
  const col = "rgba(235,240,255,", coro = p.kind === "coronagraph";
  const line = (pts, a, w) => {
    g.strokeStyle = col + a + ")"; g.lineWidth = w; g.beginPath();
    let pen = false;
    for (const q of pts) { const c = cam.at(q); if (c[2] && hypot2d(q, cam) ) { pen ? g.lineTo(c[0], c[1]) : g.moveTo(c[0], c[1]); pen = true; } else pen = false; }
    g.stroke();
  };
  const L0 = cam.lon;                                    // the observer's Carrington longitude: the grid is centred on it
  if (!coro) {
    for (let lat = -75; lat <= 75; lat += 15) line(Array.from({ length: 181 }, (_, j) => cart(1.0005, L0 - 90 + j, lat)), lat === 0 ? 0.55 : 0.28, lw * (lat === 0 ? 1.1 : 0.8));
    for (let dl = -75; dl <= 75; dl += 15) line(Array.from({ length: 121 }, (_, j) => cart(1.0005, L0 + dl, -90 + 1.5 * j)), dl === 0 ? 0.55 : 0.28, lw * (dl === 0 ? 1.1 : 0.8));
  }
  // The limb, and for coronagraphs rings of constant plane-of-sky height.
  const [cx, cy] = p.center, k = 1 / (p.scale_arcsec * ARCSEC), ring = (r) => Math.atan(r / cam.D) * k;
  g.setLineDash([]); g.strokeStyle = col + "0.75)"; g.lineWidth = lw * 1.2;
  g.beginPath(); g.arc(cx, cy, ring(1), 0, 2 * Math.PI); g.stroke();
  if (coro) {
    g.font = `${Math.round(13 * p.width / 520)}px system-ui, sans-serif`; g.fillStyle = col + "0.8)";
    g.setLineDash([lw * 4, lw * 5]); g.lineWidth = lw * 0.9;
    for (const r of [2.5, 5, 10, 20].filter((r) => r <= p.fov_rs[1])) {
      g.strokeStyle = col + "0.35)"; g.beginPath(); g.arc(cx, cy, ring(r), 0, 2 * Math.PI); g.stroke();
      g.fillText(`${r} R☉`, cx + ring(r) * 0.72 + 4, cy - ring(r) * 0.72 - 4);
    }
    g.setLineDash([]);
  }
  // The solar rotation axis through the north pole, as the observer sees it.
  const np = cam.at([0, 0, 1]), ax = cam.at([0, 0, coro ? 2.2 : 1.25]);
  g.strokeStyle = col + "0.9)"; g.lineWidth = lw * 1.6;
  g.beginPath(); g.moveTo(np[0], np[1]); g.lineTo(ax[0], ax[1]); g.stroke();
  if (np[2]) { g.fillStyle = col + "0.95)"; g.beginPath(); g.arc(np[0], np[1], lw * 2.6, 0, 2 * Math.PI); g.fill(); }
  // Corner compass: solar north up, east to the left.
  const s = p.width / 520, x0 = p.width - 42 * s, y0 = 52 * s;
  g.strokeStyle = col + "0.95)"; g.fillStyle = col + "0.95)"; g.lineWidth = 2 * s;
  g.beginPath(); g.moveTo(x0, y0 + 14 * s); g.lineTo(x0, y0 - 22 * s); g.stroke();
  g.beginPath(); g.moveTo(x0, y0 - 30 * s); g.lineTo(x0 - 6 * s, y0 - 19 * s); g.lineTo(x0 + 6 * s, y0 - 19 * s); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(x0 + 14 * s, y0 + 14 * s); g.lineTo(x0 - 22 * s, y0 + 14 * s); g.stroke();
  g.font = `600 ${Math.round(14 * s)}px system-ui, sans-serif`; g.textAlign = "center";
  g.fillText("N", x0, y0 - 34 * s); g.fillText("E", x0 - 30 * s, y0 + 19 * s); g.textAlign = "left";
}
// A point of the grid is drawn only on the near side of the Sun.
function hypot2d(q, cam) { return q[0] * cam.o[0] + q[1] * cam.o[1] + q[2] * cam.o[2] > 0.0; }

// ------------------------------------------------------------- page
const fmtT = (s) => s.slice(0, 16).replace("T", " ");
function caption(p) {
  if (EMBED) return `<b>${p.label}</b><div class="meta">${fmtT(p.t_obs)} UTC</div>`;
  const dt = (Date.parse(p.t_obs) - Date.parse(day.map_time)) / 3600000;
  const sep = earthL0 != null ? ((p.observer.lon - earthL0 + 540) % 360) - 180 : null;
  const from = { SDO: "SDO", SOHO: "SOHO", STEREO: "STEREO-A", "Solar Orbiter": "Solar Orbiter" }[p.observatory];
  return `<b>${p.label}</b><div class="meta">${fmtT(p.t_obs)} UTC (${dt >= 0 ? "+" : ""}${dt.toFixed(1)} h from the map) · from ${from}, ${(p.observer.r_rs / 215.032).toFixed(3)} au${sep != null && Math.abs(sep) > 2 ? `, ${Math.abs(sep).toFixed(0)}° ${sep > 0 ? "west" : "east"} of Earth` : ""}</div>`;
}
function panelView(p, cv, ctl) {
  const redraw = () => pair(p).then((ims) => draw(cv, p, ims, field, split.get(p.id) ?? SPLIT[S.view]));
  if (ctl) {
    ctl.hidden = !(p.files.enh || p.files.wow);
    ctl.value = split.get(p.id) ?? SPLIT[S.view];
    ctl.oninput = () => { split.set(p.id, +ctl.value); redraw(); };
  }
  return redraw;
}
const shown = () => (EMBED
  ? EMBED_PANELS.map((alts) => alts.map((id) => day.panels.find((p) => p.id === id)).find(Boolean)).filter(Boolean)
  : day.panels);
async function render() {
  const grid = $("grid");
  grid.replaceChildren();
  for (const p of shown()) {
    const card = document.createElement("figure"); card.className = "panel"; card.style.margin = "0";
    const view = document.createElement("div"); view.className = "view";
    const cv = document.createElement("canvas"); cv.setAttribute("role", "img"); cv.setAttribute("aria-label", `${p.label} with model field lines`);
    const ctl = document.createElement("input"); ctl.type = "range"; ctl.min = 0; ctl.max = 100; ctl.className = "wipe";
    const m = methods(p);
    ctl.setAttribute("aria-label", `${p.label}: slide between ${m.std} and ${m.enh}`);
    view.append(cv);
    const cap = document.createElement("figcaption"); cap.className = "cap"; cap.innerHTML = caption(p);
    card.append(view, ctl, cap); grid.append(card);
    cv.width = p.width; cv.height = p.height;
    // In a frame the full page opens instead of the enlarged view.
    cv.onclick = () => (EMBED ? open(`https://sr-dash.github.io/heliofield/observations.html?date=${S.date}`, "_blank", "noopener") : openZoom(p));
    panelView(p, cv, ctl)();
  }
  const missing = EMBED ? [] : ["SDO", "SOHO", "STEREO", "Solar Orbiter"].filter((o) => !day.panels.some((p) => p.observatory === o));
  for (const o of missing) {
    const card = document.createElement("figure"); card.className = "panel missing"; card.style.margin = "0";
    card.innerHTML = `<div class="hole">No ${o} image within 18 hours of the map time.</div><figcaption class="cap"><b>${o}</b></figcaption>`;
    grid.append(card);
  }
  $("credits").textContent = "Credits: " + Object.values(day.credits).join(". ") + ".";
  if (EMBED) {
    const obs = [...new Set(shown().map((p) => p.observatory))];
    $("embedFoot").innerHTML = `<span>${fmtT(day.map_time).slice(0, 10)} · images ${obs.map((o) => ({ SDO: "SDO", SOHO: "SOHO", STEREO: "STEREO", "Solar Orbiter": "SolO" })[o]).join(", ")} (NASA/ESA)</span><a href="https://sr-dash.github.io/heliofield/observations.html?date=${S.date}" target="_blank" rel="noopener">All panels ↗</a>`;
  }
}
let zoomed = null;
async function openZoom(p) {
  zoomed = p;
  const d = $("zoom"), m = methods(p);
  $("zoomTitle").textContent = `${p.label}, ${fmtT(p.t_obs)} UTC`;
  $("zoomNote").textContent = `${field?.label || ""} · ${m.enh ? `left of the divider ${m.std}, right ${m.enh}` : m.std} · source: ${p.source}`;
  d.showModal();
  panelView(p, $("zoomCanvas"), $("zoomWipe"))();
  // The panel in the grid follows the zoomed slider.
  const own = $("zoomWipe").oninput, card = [...document.querySelectorAll(".panel .wipe")][day.panels.indexOf(p)];
  $("zoomWipe").oninput = () => { own(); if (card) { card.value = $("zoomWipe").value; card.oninput(); } };
}
// The zoomed view as a PNG, with a caption strip: what, when, how drawn,
// from which model, and the credit.
async function download() {
  const p = zoomed;
  if (!p) return;
  const ims = await pair(p), at = split.get(p.id) ?? SPLIT[S.view], m = methods(p);
  const img = document.createElement("canvas");
  draw(img, p, ims, field, at);
  const s = p.width / 1024, pad = Math.round(14 * s), lh = Math.round(22 * s), foot = pad * 2 + lh * 3;
  const out = document.createElement("canvas"); out.width = p.width; out.height = p.height + foot;
  const g = out.getContext("2d");
  g.drawImage(img, 0, 0);
  g.fillStyle = "#080b14"; g.fillRect(0, p.height, out.width, foot);
  g.fillStyle = "#e8eaf0"; g.font = `600 ${Math.round(18 * s)}px system-ui, sans-serif`;
  g.fillText(`${p.label} · ${fmtT(p.t_obs)} UTC · ${at >= 100 || !m.enh ? m.std : at <= 0 ? m.enh : `${m.std} | ${m.enh}`}`, pad, p.height + pad + lh * 0.8);
  g.fillStyle = "#a3abbb"; g.font = `${Math.round(15 * s)}px system-ui, sans-serif`;
  g.fillText(`Field lines: HelioField ${field?.label || ""}`, pad, p.height + pad + lh * 1.8);
  g.fillText(`${p.credit} · sr-dash.github.io/heliofield/observations.html`, pad, p.height + pad + lh * 2.8);
  out.toBlob((b) => {
    if (!b) return;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: `heliofield_${p.id}_${S.date}.png` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/png");
}
$("zoomDownload").onclick = download;
$("zoomClose").onclick = () => $("zoom").close();
$("zoom").addEventListener("click", (e) => { if (e.target === $("zoom")) $("zoom").close(); });

function syncUrl() {
  const q = new URLSearchParams({ date: S.date });
  if (S.view !== "cmp") q.set("view", S.view);
  if (S.model !== "daily") q.set("scs", S.model === "hmi" ? 0 : S.model);
  if (S.v !== 400) q.set("v", S.v);
  for (const k of ["closed", "open", "sheet", "grid"]) if (!S[k]) q.set(k, 0);
  if (S.alpha !== 100) q.set("alpha", S.alpha);
  if (S.width !== 0.9) q.set("width", S.width);
  if (params.get("imagery")) q.set("imagery", params.get("imagery"));
  if (EMBED) { q.set("embed", 1); if (params.get("panels")) q.set("panels", params.get("panels")); }
  if (params.get("theme")) q.set("theme", params.get("theme"));
  history.replaceState(null, "", "?" + q);
  $("back").href = `./?date=${S.date}`;
  $("fleetLink").href = `${FLEET_URL}?${new URLSearchParams({ t: `${S.date}T12:00Z`, spirals: 1 })}`;
  const k = dates.indexOf(S.date);
  $("prev").disabled = k <= 0; $("next").disabled = k >= dates.length - 1;
}
async function run() {
  const st = $("status");
  st.textContent = `Loading ${S.date}…`;
  try {
    day = await json(IMG + `days/${S.date}/index.json`);
    field = null;
    render();                              // images first, the field when it is ready
    earthL0 = (await fleetFor(S.date).catch(() => null))?.L0 ?? null;           // Earth's longitude, for the captions
    field = await getField();
    st.textContent = `${day.panels.length} images · map time ${fmtT(day.map_time)} UTC · field: ${field.label}.`;
    render();
  } catch (e) {
    console.error(e);
    st.textContent = `Could not load ${S.date}: ${e.message}`;
  }
}
const redraw = () => { syncUrl(); render(); };

// Frames for the imagery repository's movies (?frames=1): each panel of a
// day drawn as on this page, full size, with or without the field lines.
// The page is driven by a headless browser; nothing here runs otherwise.
if (params.get("frames") === "1") window.hfFrame = async (date, o = {}) => {
  S.date = date; S.model = o.model || "hmi"; S.grid = !!o.grid;
  if (o.alpha != null) S.alpha = o.alpha;
  if (o.width != null) S.width = o.width;
  images.clear();
  const d = await json(IMG + `days/${date}/index.json`);
  const f = o.lines ? await getField() : null, out = {};
  for (const p of d.panels) {
    if (o.ids && !o.ids.includes(p.id)) continue;
    const ims = await pair(p), cv = document.createElement("canvas");
    draw(cv, p, ims, f, ims[1] ? o.at ?? 0 : 100);
    out[p.id] = { label: p.label, t_obs: p.t_obs, png: cv.toDataURL("image/png") };
  }
  return { date, cr: d.cr, field: f?.label ?? null, panels: out };
};

function setup() {
  const inp = $("date");
  inp.min = dates[0]; inp.max = dates.at(-1); inp.value = S.date;
  const go = (d) => { S.date = d; inp.value = d; syncUrl(); run(); };
  const nearest = (d) => dates.reduce((b, x) => (Math.abs(Date.parse(x) - Date.parse(d)) < Math.abs(Date.parse(b) - Date.parse(d)) ? x : b), dates.at(-1));
  const have = new Set(dates);
  datePicker(inp, { label: "Date", marked: (d) => have.has(d) });                 // days with images
  inp.onchange = (e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) go(nearest(e.target.value)); };
  $("prev").onclick = () => { const k = dates.indexOf(S.date); if (k > 0) go(dates[k - 1]); };
  $("next").onclick = () => { const k = dates.indexOf(S.date); if (k < dates.length - 1) go(dates[k + 1]); };
  $("model").value = S.model;
  $("model").onchange = (e) => { S.model = e.target.value; syncUrl(); run(); };
  $("v").value = String(S.v);
  $("v").onchange = (e) => { S.v = +e.target.value; redraw(); };
  for (const b of document.querySelectorAll("[data-view]")) {
    const on = b.dataset.view === S.view; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    b.onclick = () => {
      S.view = b.dataset.view; split.clear();
      for (const x of document.querySelectorAll("[data-view]")) { const o = x === b; x.classList.toggle("on", o); x.setAttribute("aria-pressed", o); }
      redraw();
    };
  }
  for (const [id, k] of [["lyClosed", "closed"], ["lyOpen", "open"], ["lySheet", "sheet"], ["lyGrid", "grid"]]) { $(id).checked = S[k]; $(id).onchange = (e) => { S[k] = e.target.checked; redraw(); }; }
  $("lw").value = S.width;
  $("lw").oninput = (e) => { S.width = +e.target.value; redraw(); };
  $("alpha").value = S.alpha;
  $("alpha").oninput = (e) => { S.alpha = +e.target.value; redraw(); };
}

const themeBtn = $("theme");
const themeLabel = () => { const l = root.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"; themeBtn.setAttribute("aria-label", l); themeBtn.title = l; };
themeBtn.onclick = () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; try { localStorage.setItem("hf.theme", root.dataset.theme); } catch (e) {} themeLabel(); };
themeLabel();

(async () => {
  try {
    const [img, prod] = await Promise.all([json(IMG + "index.json"), json("data/index.json")]);
    dates = img.dates; daily = new Set(prod.dates);
    if (!dates.length) throw new Error("no images yet");
    S.date = dates.includes(S.date) ? S.date : dates.at(-1);
    setup(); syncUrl(); run();
  } catch (e) {
    console.error(e);
    $("status").textContent = "The images could not be loaded: " + e.message;
  }
})();
