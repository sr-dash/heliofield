// Space-weather page: one day's product (meta.json and the source-surface
// PNGs) turned into indicators: the solar wind propagated to Earth and the
// fleet, sector boundaries, coronal holes facing Earth, the seasonal
// geometry, upstream spacecraft, particle-event connectivity, and DONKI's
// fast CMEs with drag-based arrivals. The physics is in sw-model.js.

import { THEMES, currentTheme } from "./theme.js";
import { fleetFor } from "./history.js";
import "./totop.js";
import * as M from "./sw-model.js";
import { enhance as datePicker } from "./datepicker.js";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const root = document.documentElement, params = new URLSearchParams(location.search);
const DAY = 86400000, HOUR = 3600000;
const SITE = "https://sr-dash.github.io/heliofield/spaceweather.html";
const FLEET_URL = "https://sr-dash.github.io/heliofleet/";
const { BODIES } = M;
const EMBED = params.get("embed") === "1";
const STALE_DAYS = 14;
const LEADS = [0, 1, 3, 5, 7];
const S = { date: null, bg: params.get("bg") === "open" ? "open" : "speed", lead: params.get("lead") !== null && LEADS.includes(+params.get("lead")) ? +params.get("lead") : 1 };
let dates = [], D = null, events = null, series = null, track = null;
const metaCache = new Map();
const T = () => THEMES[currentTheme()];
const ink = () => { const cs = getComputedStyle(root); return { text: cs.getPropertyValue("--text").trim(), muted: cs.getPropertyValue("--muted").trim(), grid: cs.getPropertyValue("--grid").trim(), card: cs.getPropertyValue("--card").trim(), shade: cs.getPropertyValue("--shade").trim() }; };
const color = (k) => (k === "earth" ? T().fleet.earth : T().fleet[k] || T().planet);
const fmtDay = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtT = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const fmtHour = (t) => `${fmtDay(t)} ${new Date(t).toISOString().slice(11, 13)} UT`;
const plural = (n, a, b = a + "s") => `${n} ${n === 1 ? a : b}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sector = (b) => (b > 0 ? "away" : "towards");
const sectorFrom = (b) => (b > 0 ? "away from" : "towards");
const polTag = (b) => `<span class="pol ${b > 0 ? "out" : "in"}">${b > 0 ? "away" : "towards"}</span>`;
const noon = (day) => Date.parse(day + "T12:00:00Z");

// ------------------------------------------------------------- loading
function grey(url) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
      for (let i = 0; i < out.length; i++) out[i] = px[4 * i];
      ok(out);
    };
    img.onerror = () => fail(new Error(`${url} not found`));
    img.src = url;
  });
}
const getMeta = (day) => {
  if (!metaCache.has(day)) metaCache.set(day, fetch(`data/${day}/meta.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return metaCache.get(day);
};

async function load(day) {
  const meta = await getMeta(day);
  if (!meta) throw new Error(`no product for ${day}`);
  const base = `data/${day}/`, wsa = meta.wsa || {};
  const [sp, ss, op] = await Promise.all([wsa.map ? grey(base + wsa.map).catch(() => null) : null, grey(base + "ss.png"), grey(base + "open.png").catch(() => null)]);
  const speed = sp && Float64Array.from(sp, (k) => (k ? wsa.vmin + (k - 1) / 254 * (wsa.vmax - wsa.vmin) : NaN));
  const bss = Float64Array.from(ss, (k) => k / 127.5 - 1);           // source-surface B_r / ss_scale
  const cls = op && Int8Array.from(op, (k) => (k === 255 ? 1 : k === 128 ? -1 : 0));
  return { day, meta, speed, bss, cls, t0: Date.parse(meta.obstime), L0: meta.L0, rss: meta.model.rss };
}

// ------------------------------------------------------------- DOM helpers
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
// Status levels: colour, a distinct shape and a word, never colour alone.
const { LEVEL_NAME } = M;
const ICON = {
  good: '<circle cx="8" cy="8" r="6.5"/><path d="m5 8.2 2 2 4-4.4" fill="none" stroke="var(--card)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  watch: '<path d="M8 1.5 15 14H1z"/><path d="M8 6v3.6M8 11.6v.2" stroke="var(--card)" stroke-width="1.7" stroke-linecap="round"/>',
  high: '<path d="M8 .8 15.2 8 8 15.2.8 8z"/><path d="M8 4.6v4M8 10.9v.2" stroke="var(--card)" stroke-width="1.7" stroke-linecap="round"/>',
  severe: '<path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z"/><path d="M8 4.4v4.2M8 11v.2" stroke="var(--card)" stroke-width="1.7" stroke-linecap="round"/>',
};
const icon = (lv) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">${ICON[lv]}</svg>`;
const chip = (lv, text = LEVEL_NAME[lv]) => `<span class="st st-${lv}">${icon(lv)}${text}</span>`;
const { worst, windLevel } = M;
function tile(box, label, value, note, href, lv) {
  const t = document.createElement(href ? "a" : "div");
  t.className = "tile" + (lv ? ` st-${lv}` : "");
  if (href) { t.href = href; t.style.textDecoration = "none"; }
  t.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>${lv ? chip(lv) : ""}<div class="note">${note}</div>`;
  box.append(t);
}
function showTip(html, px, py) {
  const box = $("tip");
  box.innerHTML = html; box.hidden = false;
  const tw = box.offsetWidth, th = box.offsetHeight;
  let left = px + 16 + tw > innerWidth - 8 ? px - 16 - tw : px + 16;
  const top = Math.min(Math.max(8, py - th / 2), innerHeight - th - 8);
  box.style.left = `${Math.max(8, left)}px`; box.style.top = `${top}px`;
}
const hideTip = () => { $("tip").hidden = true; };
// Each cell carries its column's name, so on a phone a row can become a
// stacked card (css: @media max-width 640px) instead of scrolling sideways.
function labelTables() {
  for (const t of document.querySelectorAll(".scroll table")) {
    const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    for (const tr of t.querySelectorAll("tbody tr")) [...tr.children].forEach((td, i) => {
      if (!heads[i] || td.dataset.label) return;
      td.dataset.label = heads[i];
      td.innerHTML = `<span class="cv">${td.innerHTML}</span>`;          // one flex item, however many parts
    });
  }
}

// ------------------------------------------------------------- assessment
function assess() {
  const a = D.a, m = D.meta, box = $("tiles");
  box.replaceChildren();
  const paras = [];
  if (a.now) {
    const cls = M.windClass(a.now.v), up = a.peak && a.peak.v >= 500 && a.peak.v - a.now.v > 60;
    const hole = up && a.holes?.find((h) => h.arrive[0] - DAY <= a.peak.t && a.peak.t <= h.arrive[1] + DAY && h.pol === Math.sign(a.peak.b));
    paras.push(`Ambient solar wind at Earth: <b>${cls}</b>, about <b>${Math.round(a.now.v)} km/s</b>` +
      (up ? `, rising to about <b>${Math.round(a.peak.v)} km/s</b> around <b>${fmtDay(a.peak.t)}</b>${hole ? ` as wind from coronal hole ${hole.n} arrives` : ""}.`
        : a.peak?.v >= 500 ? `, staying fast through the week.` : `; no high-speed stream in the next seven days.`));
    const fav = a.rm.day.mean <= -0.15 ? "favours" : a.rm.day.mean >= 0.15 ? "works against" : "neither favours nor hinders";
    paras.push(`Earth is in a sector pointing <b>${sectorFrom(a.now.b)}</b> the Sun` + (a.next ? `, with the next sector boundary around <b>${fmtDay(a.next.t)}</b>` : "") +
      `. At this time of year that ${fav} a southward interplanetary field, which is what drives geomagnetic activity (Russell–McPherron).`);
  } else {
    paras.push("This day's product has no source-surface speed map, so the outlook cannot be computed.");
  }
  const ev = D.ev;
  if (ev) {
    const hits = ev.cmes.filter((c) => c.targets.earth && c.targets.earth.hit !== "miss");
    const cmeTxt = ev.cmes.length ? `${plural(ev.cmes.length, "fast CME")} (1000 km/s or more) in the last seven days` + (hits.length
      ? `; ${hits.map((c) => `the one of ${fmtHour(c.t)} ${c.targets.earth.arrival > D.t0 ? "may reach" : "may have reached"} Earth around ${fmtHour(c.targets.earth.arrival)}`).join(", and ")}.`
      : `, none aimed at Earth.`) : "No CME of 1000 km/s or more in the last seven days.";
    const fl = ev.flares.length ? ` ${plural(ev.flares.length, "large flare")} (M5 or above)` + (ev.flares.some((f) => f.conn.earth === "good") ? ", at least one well connected to Earth." : ".") : "";
    const st = ev.storms.length ? ` ${plural(ev.storms.length, "strong geomagnetic storm")} (G3 or above) observed.` : "";
    paras.push(cmeTxt + fl + st);
  }
  const up = upstreamRows().find((u) => u.key !== "earth" && u.lead > 0.3 && u.lead < 10 && Math.abs(u.dlat) < 8 && u.b.r > 0.7);
  if (up) paras.push(`${up.name} sees now the wind Earth should meet in about <b>${up.lead.toFixed(1)} days</b> (${Math.round(up.v)} km/s, ${sector(up.pol)}).`);
  // One overall level: the worst of the wind now, the week ahead and the events.
  const { level: overall, reasons, lvNow, lvPeak, evl } = M.overall(D, a, ev);
  const say = { good: "Quiet: nominal ambient solar wind and no large events.", watch: "Watch", high: "Elevated", severe: "Severe" }[overall];
  $("narrative").innerHTML = `<div class="overall st-${overall}">${chip(overall)}<span>${overall === "good" ? say : `${say}: ${reasons.join("; ")}.`}</span></div>` + paras.map((p) => `<p>${p}</p>`).join("");

  if (a.now) {
    tile(box, "Solar wind at Earth", `${Math.round(a.now.v)} km/s`, `${M.windClass(a.now.v)}; ambient wind from the model`, null, lvNow);
    tile(box, "Peak in the next 7 days", a.peak ? `${Math.round(a.peak.v)} km/s` : "–", a.peak ? `${fmtDay(a.peak.t)}${a.peak.v < 500 ? "; no high-speed stream" : ""}` : "", null, lvPeak);
    const soon = a.next && a.next.t - D.t0 < 2 * DAY;
    tile(box, "Magnetic sector", sector(a.now.b), a.next ? `next boundary ${fmtDay(a.next.t)}, in ${((a.next.t - D.t0) / DAY).toFixed(1)} days${soon ? "; crossings often bring compressed, disturbed wind" : ""}` : "no boundary in the next two weeks", null, soon ? "watch" : null);
    const r = a.rm.day.mean;
    tile(box, "Season (Russell–McPherron)", r <= -0.15 ? "favourable" : r >= 0.15 ? "unfavourable" : "neutral",
      `this sector's field is ${Math.abs(Math.round(100 * r))}% ${r < 0 ? "southward" : "northward"} on the daily mean${r <= -0.15 ? ": streams couple more strongly" : ""}`, "#sec-season", r <= -0.15 ? "watch" : null);
    tile(box, "Interplanetary field at 1 au", `${a.imf.b.toFixed(1)} nT`, `from the model's open flux; measured fields run about twice this`);
  }
  if (a.holes) {
    const facing = a.holes.filter((h) => Math.abs(h.cmd) <= 30);
    tile(box, "Coronal holes facing Earth", String(facing.length), facing.length ? facing.map((h) => `${h.n} (${h.pol > 0 ? "away" : "towards"}) ${h.cmd >= 0 ? "W" : "E"}${Math.abs(Math.round(h.cmd))}°`).join(", ") : "within 30° of central meridian", "#sec-holes", facing.length ? "watch" : "good");
  }
  const north = a.rc.lat >= 0;
  const pf = series ? series[north ? "polar_n" : "polar_s"].at(-1) : null;
  tile(box, "Sector bias at Earth's latitude", `${Math.round(100 * a.rc.away)}% away`,
    `Earth at ${a.rc.lat.toFixed(1)}° heliographic${pf != null && Math.abs(a.rc.lat) >= 2 ? `; the ${north ? "north" : "south"} polar field (${pf > 0 ? "+" : ""}${pf.toFixed(1)} G) favours ${pf > 0 ? "away" : "towards"}` : ""}`, "#sec-season");
  if (ev) tile(box, "DONKI, last 7 days", `${ev.flares.length} · ${ev.cmes.length} · ${ev.storms.length}`, "flares ≥ M5 · CMEs ≥ 1000 km/s · storms ≥ G3", "#sec-cme", evl?.lv);
}

// ------------------------------------------------------------- outlook chart
function drawOutlook() {
  const fig = $("outlook"), a = D.a, th = T(), c = ink();
  fig.replaceChildren();
  if (!a.ser) { fig.innerHTML = `<p class="empty">No speed map for this day.</p>`; return; }
  const ser = a.ser, W = Math.max(320, fig.clientWidth), narrow = W < 600, H = EMBED ? 170 : narrow ? 300 : 340;
  const m = { l: 50, r: 14, t: 14, b: EMBED ? 46 : 66 }, stripH = 16, plotB = H - m.b - stripH - 10;
  const t0 = ser[0].t, t1 = ser[ser.length - 1].t;
  const vmax = Math.max(700, Math.ceil(Math.max(...ser.map((p) => p.v)) / 100) * 100), vmin = 250;
  const X = (t) => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r), Y = (v) => m.t + (1 - (v - vmin) / (vmax - vmin)) * (plotB - m.t);
  const leg = document.createElement("div"); leg.className = "legend";
  leg.innerHTML = `<span><i style="background:${th.chart.a}"></i>speed at Earth, km/s</span><span><i class="box" style="background:${th.pos}"></i>away</span><span><i class="box" style="background:${th.neg}"></i>towards</span><span><i class="box" style="background:${c.shade};border:1px solid ${c.grid}"></i>far-side data, over ${STALE_DAYS} days old</span><span><i class="dash"></i>${fmtDay(D.t0)}, the map</span>`;
  fig.append(leg);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "chartsvg", role: "img", tabindex: 0,
    "aria-label": `Model solar-wind speed and sector at Earth, ${fmtDay(t0)} to ${fmtDay(t1)}. Arrow keys read values; the data table lists them.` });
  fig.append(svg);
  // Stale stretches first, under everything.
  let run = null;
  for (const p of ser.concat([{ t: Infinity, age: 0 }])) {
    if (p.age > STALE_DAYS) run ??= p.t;
    else if (run != null) { el("rect", { x: X(run), y: m.t, width: X(Math.min(p.t, t1)) - X(run), height: plotB - m.t + stripH + 10, fill: c.shade }, svg); run = null; }
  }
  for (const v of [300, 400, 500, 600, 700, 800, 900].filter((v) => v <= vmax)) {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: c.grid }, svg);
    el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", fill: c.muted, class: "tick" }, svg).textContent = v;
  }
  // Speed bands, tinted by status and named at the right edge.
  const cs = getComputedStyle(root);
  for (const [lo, hi, lv] of [[500, 600, "watch"], [600, 750, "high"], [750, vmax, "severe"]]) {
    if (lo >= vmax) continue;
    const col = cs.getPropertyValue(`--st-${lv}`).trim();
    el("rect", { x: m.l, y: Y(Math.min(hi, vmax)), width: W - m.l - m.r, height: Y(lo) - Y(Math.min(hi, vmax)), fill: col, "fill-opacity": 0.1 }, svg);
    el("line", { x1: m.l, x2: W - m.r, y1: Y(lo), y2: Y(lo), stroke: col, "stroke-opacity": 0.6, "stroke-dasharray": "3 4" }, svg);
    el("text", { x: W - m.r - 4, y: Y(lo) - 5, "text-anchor": "end", fill: c.muted, class: "note" }, svg).textContent = `${LEVEL_NAME[lv].toLowerCase()}, ${lo}+ km/s`;
  }
  // Days.
  const every = Math.max(1, Math.ceil(52 / ((W - m.l - m.r) / ((t1 - t0) / DAY))));
  for (let t = Date.parse(new Date(t0).toISOString().slice(0, 10) + "T00:00:00Z") + DAY, k = 0; t <= t1; t += DAY, k++) {
    el("line", { x1: X(t), x2: X(t), y1: plotB + stripH + 10, y2: plotB + stripH + 14, stroke: c.grid }, svg);
    if (k % every === 0) el("text", { x: X(t), y: H - 30, "text-anchor": "middle", fill: c.muted, class: "tick" }, svg).textContent = fmtDay(t);
  }
  // Sector strip.
  for (let k = 1; k < ser.length; k++) {
    const p = ser[k - 1], q = ser[k];
    el("rect", { x: X(p.t), y: plotB + 10, width: Math.max(0.5, X(q.t) - X(p.t) + 0.3), height: stripH, fill: p.b > 0 ? th.pos : th.neg }, svg);
  }
  for (const x of a.cross) el("line", { x1: X(x.t), x2: X(x.t), y1: plotB + 6, y2: plotB + stripH + 14, stroke: c.text, "stroke-width": 1.5 }, svg);
  // The speed.
  el("path", { d: ser.map((p, k) => `${k ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(""), fill: "none", stroke: th.chart.a, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
  // Map time, and the peaks of the streams, directly labelled.
  el("line", { x1: X(D.t0), x2: X(D.t0), y1: m.t, y2: plotB + stripH + 10, stroke: c.text, "stroke-width": 1.5, "stroke-dasharray": "4 3" }, svg);
  for (const s of a.streams) {
    el("circle", { cx: X(s.peak.t), cy: Y(s.peak.v), r: 4.5, fill: th.chart.a, stroke: th.bg, "stroke-width": 2 }, svg);
    el("text", { x: X(s.peak.t), y: Y(s.peak.v) - 10, "text-anchor": "middle", fill: c.text, stroke: th.bg, "stroke-width": 4, "paint-order": "stroke", "stroke-linejoin": "round", class: "lab" }, svg).textContent = `${Math.round(s.peak.v)}`;
  }
  if (!EMBED) el("text", { x: m.l, y: H - 8, fill: c.muted, class: "note" }, svg).textContent = narrow ? "Past days: what today's map implies." : "Past days show what today's map implies, not what was forecast then.";
  // Hover layer.
  const cross = el("g", { visibility: "hidden" }, svg);
  const vl = el("line", { y1: m.t, y2: plotB + stripH + 10, stroke: c.muted }, cross);
  const dot = el("circle", { r: 4.5, fill: th.chart.a, stroke: th.bg, "stroke-width": 2 }, cross);
  const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
  let cur = ser.findIndex((p) => p === a.now);
  const show = (k, px, py) => {
    cur = Math.max(0, Math.min(ser.length - 1, k));
    const p = ser[cur], x = X(p.t);
    cross.setAttribute("visibility", "visible"); vl.setAttribute("x1", x); vl.setAttribute("x2", x);
    dot.setAttribute("cx", x); dot.setAttribute("cy", Y(p.v));
    const b = svg.getBoundingClientRect();
    showTip(`<div class="head">${fmtHour(p.t)}</div><div class="row"><b>${Math.round(p.v)} km/s</b>${chip(windLevel(p.v), M.windClass(p.v))}</div>
      <div class="row">${polTag(p.b)}<span>sector</span></div><div class="row"><span>source ${p.src.toFixed(0)}° Carrington, data ${p.age.toFixed(0)} d old</span></div>`,
    px ?? b.left + x / W * b.width, py ?? b.top + 40);
  };
  const nearest = (cx) => { const b = svg.getBoundingClientRect(), x = (cx - b.left) / b.width * W; return Math.round((x - m.l) / (W - m.l - m.r) * (ser.length - 1)); };
  hit.addEventListener("pointermove", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerdown", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  svg.addEventListener("blur", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  svg.addEventListener("focus", () => show(cur));
  svg.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -12, PageDown: 12, Home: -1e6, End: 1e6 }[e.key];
    if (step != null) { e.preventDefault(); show(cur + step); }
    if (e.key === "Escape") { cross.setAttribute("visibility", "hidden"); hideTip(); }
  });
  // Table: every six hours.
  const det = $("outlookTable");
  det.querySelector(".scroll")?.remove();
  const rows = ser.filter((p) => new Date(p.t).getUTCHours() % 6 === 0);
  const wrap = document.createElement("div"); wrap.className = "scroll";
  wrap.innerHTML = `<table><thead><tr><th>Time (UTC)</th><th>Speed</th><th>Sector</th><th>Source (Carrington)</th><th>Data age</th></tr></thead><tbody>${
    rows.map((p) => `<tr><td>${fmtT(p.t)}</td><td>${Math.round(p.v)} km/s ${p.v >= 500 ? chip(windLevel(p.v), "") : ""}</td><td>${sector(p.b)}</td><td>${p.src.toFixed(1)}°</td><td>${p.age.toFixed(1)} d</td></tr>`).join("")}</tbody></table>`;
  det.append(wrap);
  labelTables();
}

// ------------------------------------------------------------- track record
// Pairs of (model daily mean made `lead` days before, measured daily mean)
// by target day, from data/spaceweather/daily.json.
function pairs(lead) {
  const rows = new Map((track?.rows || []).map((r) => [r.date, r]));
  const out = [];
  for (const r of rows.values()) {
    const src = rows.get(new Date(Date.parse(r.date) - lead * DAY).toISOString().slice(0, 10));
    const fv = src?.model?.fc_v?.[lead + 1], fb = src?.model?.fc_b?.[lead + 1];
    out.push({ day: r.date, t: Date.parse(r.date + "T12:00:00Z"), model: fv ?? null, sector: fb ?? null, meas: r.measured || null });
  }
  return out.sort((a, b) => a.t - b.t);
}
function skill(lead) {
  const p = pairs(lead).filter((x) => x.model != null && x.meas?.v != null);
  if (!p.length) return { n: 0 };
  const e = p.map((x) => x.model - x.meas.v), mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const mx = mean(p.map((x) => x.model)), my = mean(p.map((x) => x.meas.v));
  const cov = mean(p.map((x) => (x.model - mx) * (x.meas.v - my))), sx = Math.sqrt(mean(p.map((x) => (x.model - mx) ** 2))), sy = Math.sqrt(mean(p.map((x) => (x.meas.v - my) ** 2)));
  const sec = p.filter((x) => x.sector != null && x.meas.away != null && Math.abs(x.meas.away - 0.5) >= 0.2);
  return { n: p.length, mae: mean(e.map(Math.abs)), bias: mean(e), r: p.length > 2 && sx > 0 && sy > 0 ? cov / sx / sy : null,
    sector: sec.length ? sec.filter((x) => (x.sector > 0) === (x.meas.away > 0.5)).length / sec.length : null, nsec: sec.length };
}
function drawRecord() {
  const fig = $("record"), th = T(), c = ink();
  fig.replaceChildren();
  $("leads").innerHTML = LEADS.map((k) => `<button type="button" data-lead="${k}" class="${k === S.lead ? "on" : ""}" aria-pressed="${k === S.lead}">${k === 0 ? "Same day" : k === 1 ? "1 day ahead" : `${k} days ahead`}</button>`).join("");
  for (const b of $("leads").querySelectorAll("button")) b.onclick = () => { S.lead = +b.dataset.lead; syncUrl(); drawRecord(); };
  const all = pairs(S.lead).filter((x) => x.model != null || x.meas?.v != null);
  if (!track || !all.length) { fig.innerHTML = `<p class="empty">The series starts with the first daily run that records it.</p>`; $("skill").innerHTML = ""; return; }
  const W = Math.max(320, fig.clientWidth), H = W < 600 ? 240 : 280, m = { l: 50, r: 14, t: 14, b: 30 };
  const t0 = all[0].t - DAY / 2, t1 = Math.max(all.at(-1).t, D.t0) + DAY / 2;
  const vals = all.flatMap((x) => [x.model, x.meas?.v_min, x.meas?.v_max]).filter((v) => v != null);
  const vmin = Math.min(250, Math.floor(Math.min(...vals) / 100) * 100), vmax = Math.max(600, Math.ceil(Math.max(...vals) / 100) * 100);
  const X = (t) => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r), Y = (v) => m.t + (1 - (v - vmin) / (vmax - vmin)) * (H - m.t - m.b);
  const leg = document.createElement("div"); leg.className = "legend";
  leg.innerHTML = `<span><i style="background:${th.chart.b}"></i>measured at L1, daily mean (bar: range)</span><span><i style="background:${th.chart.a}"></i>model, ${S.lead === 0 ? "same day" : `${S.lead} day${S.lead > 1 ? "s" : ""} ahead`}</span><span>km/s</span>`;
  fig.append(leg);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "chartsvg", role: "img", tabindex: 0, "aria-label": "Model and measured daily solar-wind speed at Earth" });
  fig.append(svg);
  for (let v = Math.ceil(vmin / 100) * 100; v <= vmax; v += 100) {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: c.grid }, svg);
    el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", fill: c.muted, class: "tick" }, svg).textContent = v;
  }
  const every = Math.max(1, Math.ceil(56 / ((W - m.l - m.r) / ((t1 - t0) / DAY))));
  for (let t = Date.parse(new Date(t0 + DAY / 2).toISOString().slice(0, 10) + "T12:00:00Z"), k = 0; t <= t1; t += DAY, k++)
    if (k % every === 0) el("text", { x: X(t), y: H - 10, "text-anchor": "middle", fill: c.muted, class: "tick" }, svg).textContent = fmtDay(t);
  for (const x of all) if (x.meas?.v_min != null) el("line", { x1: X(x.t), x2: X(x.t), y1: Y(x.meas.v_min), y2: Y(x.meas.v_max), stroke: th.chart.b, "stroke-opacity": 0.35, "stroke-width": 3, "stroke-linecap": "round" }, svg);
  const line = (key, col) => {
    let d = "", pen = false;
    for (const x of all) { const v = key(x); if (v == null) { pen = false; continue; } d += `${pen ? "L" : "M"}${X(x.t).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; }
    el("path", { d, fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
    for (const x of all) { const v = key(x); if (v != null) el("circle", { cx: X(x.t), cy: Y(v), r: 3.5, fill: col, stroke: th.bg, "stroke-width": 1.5 }, svg); }
  };
  line((x) => x.meas?.v ?? null, th.chart.b);
  line((x) => x.model, th.chart.a);
  el("line", { x1: X(D.t0), x2: X(D.t0), y1: m.t, y2: H - m.b, stroke: c.text, "stroke-width": 1.5, "stroke-dasharray": "4 3" }, svg);
  const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
  const show = (e) => {
    const b = svg.getBoundingClientRect(), t = t0 + ((e.clientX - b.left) / b.width * W - m.l) / (W - m.l - m.r) * (t1 - t0);
    const x = all.reduce((a, y) => (Math.abs(y.t - t) < Math.abs(a.t - t) ? y : a));
    showTip(`<div class="head">${fmtDay(x.t)}</div><div class="row"><i style="display:inline-block;width:14px;height:3px;background:${th.chart.b}"></i><b>${x.meas?.v != null ? Math.round(x.meas.v) + " km/s" : "–"}</b><span>measured${x.meas ? ` (${x.meas.src}${x.meas.kp_max != null ? `, Kp max ${x.meas.kp_max}` : ""})` : ""}</span></div>
      <div class="row"><i style="display:inline-block;width:14px;height:3px;background:${th.chart.a}"></i><b>${x.model != null ? Math.round(x.model) + " km/s" : "–"}</b><span>model</span></div>`, e.clientX, e.clientY);
  };
  hit.addEventListener("pointermove", show); hit.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hideTip);
  const f = (x, n = 0) => (x == null ? "–" : x.toFixed(n));
  $("skill").innerHTML = `<thead><tr><th>Made ahead</th><th>Days compared</th><th>Mean absolute error</th><th>Bias (model − measured)</th><th>Correlation</th><th>Sector right</th></tr></thead><tbody>` +
    LEADS.map((k) => { const s = skill(k); return `<tr${k === S.lead ? ' style="font-weight:600"' : ""}><td>${k === 0 ? "same day" : `${k} d`}</td><td>${s.n}</td><td>${s.n ? f(s.mae) + " km/s" : "–"}</td><td>${s.n ? (s.bias > 0 ? "+" : "") + f(s.bias) + " km/s" : "–"}</td><td>${f(s.r, 2)}</td><td>${s.sector != null ? `${Math.round(100 * s.sector)}% <span class="faint">of ${s.nsec}</span>` : "–"}</td></tr>`; }).join("") + "</tbody>";
  labelTables();
}

// ------------------------------------------------------------- map
// Sequential ramp for speed, one hue (violet), light to dark in the light
// theme and dark to light in the dark one, so fast wind always stands out.
function speedLUT(dark) {
  const out = [];
  for (let i = 0; i < 256; i++) {
    const s = i / 255, L = dark ? 0.24 + 0.68 * s : 0.95 - 0.6 * s, C = 0.02 + 0.13 * Math.sin(Math.PI * Math.min(1, s * 0.9 + 0.1) / 1.15), h = 295 * Math.PI / 180;
    const a = C * Math.cos(h), b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, mm = m_ ** 3, q = s_ ** 3;
    out.push([4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * q, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * q, -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * q]
      .map((v) => { v = Math.min(1, Math.max(0, v)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)); }));
  }
  return out;
}
const MAP = { x0: 64, y0: 18, w: 1352, h: 676 };
function drawMap() {
  const cv = $("map"), g = cv.getContext("2d"), th = T(), c = ink(), a = D.a, dark = currentTheme() === "dark";
  const { x0, y0, w, h } = MAP, X = (lon) => x0 + M.wrap(lon) / 360 * w, Y = (lat) => y0 + (90 - lat) / 180 * h;
  g.fillStyle = c.card; g.fillRect(0, 0, cv.width, cv.height);
  const img = g.createImageData(360, 180), lut = speedLUT(dark), hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const cp = hex(th.pos), cn = hex(th.neg), cc = hex(th.occluder);
  const useSpeed = S.bg === "speed" && D.speed;
  for (let i = 0; i < 64800; i++) {
    let col;
    if (useSpeed) { const v = D.speed[i]; col = Number.isFinite(v) ? lut[Math.round(Math.max(0, Math.min(1, (v - 250) / 550)) * 255)] : cc; }
    else { const k = D.cls ? D.cls[i] : 0; col = k > 0 ? cp : k < 0 ? cn : cc; }
    img.data.set([col[0], col[1], col[2], 255], 4 * i);
  }
  const off = new OffscreenCanvas(360, 180); off.getContext("2d").putImageData(img, 0, 0);
  g.imageSmoothingEnabled = !!useSpeed; g.drawImage(off, x0, y0, w, h);
  // Far side from Earth, dimmed.
  g.fillStyle = c.card; g.globalAlpha = 0.45;
  const fa = M.wrap(D.L0 + 90), fb = fa + 180;          // the far side, in one or two pieces
  for (const [p, q] of fb <= 360 ? [[fa, fb]] : [[fa, 360], [0, fb - 360]]) g.fillRect(x0 + p / 360 * w, y0, (q - p) / 360 * w, h);
  g.globalAlpha = 1;
  g.strokeStyle = c.muted; g.lineWidth = 1; g.strokeRect(x0, y0, w, h);
  g.font = "15px system-ui, sans-serif"; g.fillStyle = c.muted; g.textAlign = "center";
  for (let lon = 0; lon <= 360; lon += 30) g.fillText(String(lon), lon === 360 ? x0 + w : X(lon), y0 + h + 22);
  g.fillText("Carrington longitude [°]", x0 + w / 2, y0 + h + 46);
  g.textAlign = "right";
  for (let lat = -90; lat <= 90; lat += 30) g.fillText(String(lat), x0 - 8, Y(lat) + 5);
  // Neutral line, central meridian, Earth's latitude.
  const poly = (pts) => { g.beginPath(); for (let k = 0; k < pts.length; k += 2) { const x = X(pts[k]), y = Y(pts[k + 1]); (k && Math.abs(pts[k] - pts[k - 2]) < 180) ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); };
  g.strokeStyle = th.hcs; g.lineWidth = 2.5; for (const p of D.meta.hcs || []) poly(p);
  g.strokeStyle = c.text; g.lineWidth = 1.5; g.setLineDash([7, 5]);
  g.beginPath(); g.moveTo(X(D.L0), y0); g.lineTo(X(D.L0), y0 + h); g.stroke();
  g.setLineDash([2, 5]); g.beginPath(); g.moveTo(x0, Y(D.meta.B0)); g.lineTo(x0 + w, Y(D.meta.B0)); g.stroke(); g.setLineDash([]);
  g.fillStyle = c.text; g.textAlign = "left"; g.font = "600 14px system-ui, sans-serif";
  g.fillText("central meridian", X(D.L0) + 6, y0 + 16);
  // Coronal holes, numbered as in the table.
  for (const hl of a.holes || []) {
    const x = X(hl.lon), y = Y(hl.lat);
    g.beginPath(); g.arc(x, y, 13, 0, 2 * Math.PI); g.fillStyle = c.card; g.fill(); g.lineWidth = 2; g.strokeStyle = c.text; g.stroke();
    g.fillStyle = c.text; g.textAlign = "center"; g.font = "700 14px system-ui, sans-serif"; g.fillText(String(hl.n), x, y + 5);
  }
  // Footpoints.
  const placed = [];
  for (const f of D.feet) {
    const x = X(f.foot[0]), y = Y(f.foot[1]);
    g.beginPath(); g.arc(x, y, 7, 0, 2 * Math.PI); g.fillStyle = color(f.key); g.fill(); g.lineWidth = 2.5; g.strokeStyle = th.bg; g.stroke();
    g.font = "15px system-ui, sans-serif"; const tw = g.measureText(f.name).width;
    let lx = x + 11, ly = y - 9;
    for (const dy of [0, 22, -22, 44, -44]) { const bx = [lx, ly + dy - 14, lx + tw, ly + dy + 4]; if (!placed.some((p) => bx[0] < p[2] && p[0] < bx[2] && bx[1] < p[3] && p[1] < bx[3])) { ly += dy; placed.push(bx); break; } }
    g.fillStyle = c.card; g.globalAlpha = 0.78; g.fillRect(lx - 3, ly - 15, tw + 6, 20); g.globalAlpha = 1;
    g.fillStyle = c.text; g.textAlign = "left"; g.fillText(f.name, lx, ly);
  }
  // Colour bar for the speed.
  if (useSpeed) {
    const bx = x0, by = y0 + h + 62, bw = 260;
    for (let i = 0; i < bw; i++) { const col = lut[Math.round(i / (bw - 1) * 255)]; g.fillStyle = `rgb(${col})`; g.fillRect(bx + i, by, 1.5, 12); }
    g.fillStyle = c.muted; g.font = "15px system-ui, sans-serif"; g.textAlign = "left";
    g.fillText("250", bx, by + 32); g.textAlign = "right"; g.fillText("800+ km/s", bx + bw, by + 32);
    g.textAlign = "left"; g.fillStyle = `rgb(${hex(th.occluder)})`; g.fillRect(bx + bw + 30, by, 12, 12);
    g.fillStyle = c.muted; g.fillText("field closes below the source surface", bx + bw + 50, by + 12);
  }
  $("mapLegend").innerHTML = [
    useSpeed ? "<span>WSA-type speed traced from each point of the source surface (2.5 R☉)</span>" : `<span><i class="box" style="background:${th.pos}"></i>open, away <i class="box" style="background:${th.neg}"></i>open, towards (photosphere)</span>`,
    `<span><i style="background:${th.hcs}"></i>current sheet at 2.5 R☉</span>`,
    `<span><i class="dash"></i>central meridian; dotted: Earth's latitude; dimmed: the far side</span>`,
    "<span>numbers: coronal holes in the table · dots: footpoints</span>",
  ].join("");
}
function drawHoles() {
  const a = D.a, t = $("holes");
  if (!a.holes) { t.innerHTML = `<tbody><tr><td class="empty">No open-field map for this day.</td></tr></tbody>`; return; }
  if (!a.holes.length) { t.innerHTML = `<tbody><tr><td class="empty">No coronal hole reaches within 35° of the equator.</td></tr></tbody>`; return; }
  t.innerHTML = `<thead><tr><th>#</th><th>Polarity</th><th>Centre (low-latitude part)</th><th>Area</th><th>From central meridian</th><th>Central meridian</th><th>Fast wind at Earth (700–500 km/s)</th></tr></thead><tbody>` +
    a.holes.map((h) => `<tr><td><b>${h.n}</b></td><td>${polTag(h.pol)}</td><td>${M.stonyhurst(h.lon - D.L0, h.lat)} <span class="faint">${h.lon.toFixed(0)}° Carr.</span></td>
      <td>${(100 * h.lowArea).toFixed(2)}%<span class="faint"> of the Sun${h.area > h.lowArea * 1.3 ? `; ${(100 * h.area).toFixed(1)}% with its polar part` : ""}</span></td>
      <td>${h.cmd >= 0 ? "W" : "E"}${Math.abs(Math.round(h.cmd))}°</td><td>${fmtDay(h.cmT)}</td>
      <td>${Math.abs(h.cmd) > 100 ? '<span class="faint">on the far side</span>' : `${fmtDay(h.arrive[0])} – ${fmtDay(h.arrive[1])}`}</td></tr>`).join("") + "</tbody>";
}

// ------------------------------------------------------------- season
function drawSeason() {
  const fig = $("season"), th = T(), c = ink(), a = D.a;
  fig.replaceChildren();
  const y = +D.day.slice(0, 4), start = Date.UTC(y, 0, 1), n = (Date.UTC(y + 1, 0, 1) - start) / DAY, v = a.now?.v || 400;
  const pts = [1, -1].map((pol) => Array.from({ length: Math.ceil(n / 2) }, (_, k) => { const t = start + 2 * k * DAY; return { t, s: M.bzDay(t, pol, v).mean }; }));
  const W = Math.max(320, fig.clientWidth), H = W < 600 ? 230 : 260, m = { l: 50, r: 14, t: 22, b: 30 };
  const X = (t) => m.l + (t - start) / (n * DAY) * (W - m.l - m.r), Y = (s) => m.t + (0.45 - s) / 0.9 * (H - m.t - m.b);
  const leg = document.createElement("div"); leg.className = "legend";
  leg.innerHTML = `<span><i style="background:${th.pos}"></i>sector away from the Sun</span><span><i style="background:${th.neg}"></i>sector towards the Sun</span><span><em style="font-style:normal">daily mean of B<sub>z</sub>/|B| in GSM; below zero is southward</em></span>`;
  fig.append(leg);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "chartsvg", role: "img", tabindex: 0, "aria-label": `Southward share of the spiral field through ${y}, for both sectors` });
  fig.append(svg);
  for (const s of [-0.4, -0.2, 0, 0.2, 0.4]) {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(s), y2: Y(s), stroke: c.grid, "stroke-width": s === 0 ? 1.5 : 1 }, svg);
    el("text", { x: m.l - 6, y: Y(s) + 4, "text-anchor": "end", fill: c.muted, class: "tick" }, svg).textContent = `${s > 0 ? "+" : ""}${Math.round(s * 100)}%`;
  }
  for (let mo = 0; mo < 12; mo++) {
    const t = Date.UTC(y, mo, 1);
    el("line", { x1: X(t), x2: X(t), y1: H - m.b, y2: H - m.b + 4, stroke: c.grid }, svg);
    if (W >= 600 || mo % 2 === 0) el("text", { x: X(t + 15 * DAY), y: H - 10, "text-anchor": "middle", fill: c.muted, class: "tick" }, svg).textContent = new Date(t).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  }
  [th.pos, th.neg].forEach((col, k) => {
    el("path", { d: pts[k].map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.s).toFixed(1)}`).join(""), fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
    const top = pts[k].reduce((a, p) => (p.s > a.s ? p : a));       // label each line at its crest
    el("text", { x: X(top.t), y: Y(top.s) - 8, "text-anchor": "middle", fill: c.text, class: "lab" }, svg).textContent = k ? "towards" : "away";
  });
  const td = Date.parse(D.day + "T00:00:00Z");
  el("line", { x1: X(td), x2: X(td), y1: m.t, y2: H - m.b, stroke: c.text, "stroke-width": 1.5, "stroke-dasharray": "4 3" }, svg);
  el("circle", { cx: X(td), cy: Y(a.rm.day.mean), r: 6, fill: a.rm.pol > 0 ? th.pos : th.neg, stroke: c.text, "stroke-width": 2 }, svg);
  const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
  const show = (e) => {
    const b = svg.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * W, k = Math.max(0, Math.min(pts[0].length - 1, Math.round((x - m.l) / (W - m.l - m.r) * (pts[0].length - 1))));
    showTip(`<div class="head">${fmtDay(pts[0][k].t)}</div><div class="row"><i class="lkey" style="display:inline-block;width:14px;height:3px;background:${th.pos}"></i><b>${Math.round(100 * pts[0][k].s)}%</b><span>away</span></div><div class="row"><i style="display:inline-block;width:14px;height:3px;background:${th.neg}"></i><b>${Math.round(100 * pts[1][k].s)}%</b><span>towards</span></div>`, e.clientX, e.clientY);
  };
  hit.addEventListener("pointermove", show); hit.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hideTip);

  const r = a.rm.day, north = a.rc.lat >= 0, pf = series ? series[north ? "polar_n" : "polar_s"].at(-1) : null;
  const exp = pf == null || Math.abs(a.rc.lat) < 2 ? null : pf > 0 ? 1 : -1;
  $("latitude").innerHTML = `
    <div>Today's sector, ${polTag(a.rm.pol)}<b class="big">${r.mean <= -0.15 ? "Favourable" : r.mean >= 0.15 ? "Unfavourable" : "Neutral"} season</b>
      Daily mean ${Math.round(100 * r.mean)}%; most southward at ${String(r.minHour).padStart(2, "0")}–${String(r.minHour + 1).padStart(2, "0")} UT (${Math.round(100 * r.min)}%), when Earth's dipole tilts furthest.
      The other sector would be ${Math.round(100 * a.rm.other.mean)}%.</div>
    <div>Earth at ${a.rc.lat >= 0 ? "+" : ""}${a.rc.lat.toFixed(1)}° heliographic latitude<b class="big">${Math.round(100 * a.rc.away)}% of longitudes point away</b>
      On the source surface at Earth's latitude, around the whole Sun. ${exp == null ? "Earth is too close to the solar equator to favour either sector." :
      `North of the equator in ${north ? "June–December" : "December–June"}, Earth samples the ${north ? "north" : "south"}ern polar field (${pf > 0 ? "+" : ""}${pf.toFixed(1)} G), which favours <b>${exp > 0 ? "away" : "towards"}</b> sectors (Rosenberg–Coleman effect)${(a.rc.away > 0.5) === exp > 0 ? "; the model agrees." : "; the model does not show it this rotation."}`}</div>`;
}

// ------------------------------------------------------------- upstream
function upstreamRows() {
  const e = D.a.bodies.earth;
  if (!e) return [];
  return Object.values(D.a.bodies).map((u) => ({ ...u, lead: M.wrap180(e.src - u.src) / M.RATE, dlat: u.b.lat - e.b.lat }));
}
function drawUpstream() {
  const rows = upstreamRows(), t = $("upstream");
  if (!rows.length) { t.innerHTML = `<tbody><tr><td class="empty">No speed map for this day.</td></tr></tbody>`; return; }
  t.innerHTML = `<thead><tr><th>Spacecraft</th><th>Distance</th><th>Latitude</th><th>Model wind there now</th><th>Sector</th><th>Source (Carrington)</th><th>Relative to Earth</th></tr></thead><tbody>` +
    rows.map((u) => {
      const rel = u.key === "earth" ? '<span class="faint">reference</span>'
        : `${u.lead >= 0 ? `Earth meets this wind in <b>${u.lead.toFixed(1)} d</b>` : `Earth met this wind ${(-u.lead).toFixed(1)} d ago`}${Math.abs(u.dlat) > 8 || u.b.r < 0.5 ? ' <span class="faint">(loose: far in latitude or distance)</span>' : ""}`;
      return `<tr><td><span class="dot" style="background:${color(u.key)}"></span>${u.name}</td><td>${u.b.r.toFixed(3)} au</td><td>${u.b.lat >= 0 ? "+" : ""}${u.b.lat.toFixed(1)}°</td>
        <td>${Math.round(u.v)} km/s ${chip(windLevel(u.v), M.windClass(u.v))}</td><td>${polTag(u.pol)}</td><td>${u.src.toFixed(0)}°</td><td>${rel}</td></tr>`;
    }).join("") + "</tbody>";
}

// ------------------------------------------------------------- particles, CMEs
// DONKI's events in the week, analysed by the model once the products of
// the flare days and the positions of the CME days are at hand.
async function eventsFor() {
  if (!events) return null;
  const days = M.eventDays(events, D.t0);
  const metas = new Map(), fleets = new Map();
  await Promise.all(days.flares.filter((d) => dates.includes(d)).map(async (d) => metas.set(d, await getMeta(d))));
  await Promise.all(days.cmes.map(async (d) => { try { fleets.set(d, await fleetFor(d)); } catch (e) { /* none that day */ } }));
  return M.eventsAnalysis(events, D, D.a, { metaFor: (d) => metas.get(d) || null, fleetAt: (d) => fleets.get(d) || null });
}
function drawEvents() {
  const ev = D.ev;
  $("feet").innerHTML = `<thead><tr><th>Spacecraft</th><th>Spiral speed</th><th>Footpoint, seen from Earth</th><th>Carrington</th><th>On the Earth-facing disk</th></tr></thead><tbody>` +
    D.feet.map((f) => `<tr><td><span class="dot" style="background:${color(f.key)}"></span>${f.name}</td><td>${f.v} km/s</td><td><b>${M.stonyhurst(f.ston.lon, f.ston.lat)}</b></td>
      <td>${f.foot[0].toFixed(1)}°, ${f.foot[1] >= 0 ? "+" : ""}${f.foot[1].toFixed(1)}°</td><td>${Math.abs(f.ston.lon) <= 90 ? (Math.abs(f.ston.lon) > 70 ? "near the west limb" : "yes") : "no, behind the limb"}</td></tr>`).join("") + "</tbody>";
  if (!ev) {
    for (const id of ["flares", "cmes", "storms"]) $(id).innerHTML = `<tbody><tr><td class="empty">HelioFleet's event list could not be loaded.</td></tr></tbody>`;
    return;
  }
  const names = D.feet.map((f) => f.key);
  $("flares").innerHTML = ev.flares.length ? `<thead><tr><th>Peak (UTC)</th><th>Class</th><th>Location</th>${D.feet.map((f) => `<th>${f.name.replace(" / L1", "")}</th>`).join("")}<th></th></tr></thead><tbody>` +
    ev.flares.map((f) => `<tr><td>${fmtT(f.tm)}</td><td><b>${esc(f.cls)}</b>${f.ar ? `<br><span class="faint">AR&nbsp;${f.ar}</span>` : ""}</td><td>${esc(f.loc || "–")}</td>${
      names.map((k) => (f.conn[k] ? `<td>${chip({ good: "high", partial: "watch", poor: "good" }[f.conn[k]], f.conn[k])} <span class="faint">${Math.round(f.dist[k])}°</span></td>` : "<td>–</td>")).join("")}
      <td><a href="${f.link}" target="_blank" rel="noopener">DONKI</a></td></tr>`).join("") + "</tbody>"
    : `<tbody><tr><td class="empty">None in DONKI for the seven days to ${fmtDay(D.t0)}.</td></tr></tbody>`;
  const tgt = (g) => (!g ? "–" : g.hit === "miss" ? `${chip("good", "misses")} <span class="faint">${Math.round(g.deg)}°</span>`
    : `${chip(g.hit === "inside" ? "high" : "watch", g.hit === "inside" ? "in the cone" : "flank")} ${fmtHour(g.arrival)} <span class="faint">${Math.round(g.vArr)} km/s</span>`);
  $("cmes").innerHTML = ev.cmes.length ? `<thead><tr><th>Time (UTC)</th><th>Speed</th><th>Direction</th><th>Half-width</th>${BODIES.filter(([k]) => D.meta.fleet[k]).map(([, n]) => `<th>${n.replace(" / L1", "")}</th>`).join("")}<th></th></tr></thead><tbody>` +
    ev.cmes.map((c) => `<tr><td>${fmtT(c.tm)}</td><td><b>${c.speed} km/s</b></td><td>${M.stonyhurst(c.lon, c.lat)}</td><td>${c.half ?? "–"}°</td>${
      BODIES.filter(([k]) => D.meta.fleet[k]).map(([k]) => `<td>${tgt(c.targets[k])}</td>`).join("")}<td><a href="${c.link}" target="_blank" rel="noopener">DONKI</a></td></tr>`).join("") + "</tbody>"
    : `<tbody><tr><td class="empty">None in DONKI for the seven days to ${fmtDay(D.t0)}.</td></tr></tbody>`;
  $("storms").innerHTML = ev.storms.length ? `<thead><tr><th>Start (UTC)</th><th>Kp</th><th>Scale</th><th></th></tr></thead><tbody>` +
    ev.storms.map((s) => `<tr><td>${fmtT(Date.parse(s.t))}</td><td>${s.kp}</td><td>G${s.g}</td><td><a href="${s.link}" target="_blank" rel="noopener">DONKI</a></td></tr>`).join("") + "</tbody>"
    : `<tbody><tr><td class="empty">None in DONKI for the seven days to ${fmtDay(D.t0)}.</td></tr></tbody>`;
}

// ------------------------------------------------------------- solar cycle
function drawCycle() {
  const box = $("cycle");
  box.replaceChildren();
  if (!series) { box.textContent = "The solar-cycle series could not be loaded."; return; }
  const s = series, i = s.cr.length - 1, when = `CR ${s.cr[i]}, centred on ${s.mid[i]}`;
  const mean = (k, j) => { const a = s[k].slice(Math.max(0, j - 6), j + 7).filter(Number.isFinite); return a.reduce((x, y) => x + y, 0) / a.length; };
  // The latest sign change of each polar field's 13-rotation mean.
  const reversal = (k) => { for (let j = i - 6; j > 6; j--) if (Math.sign(mean(k, j)) !== Math.sign(mean(k, j - 1))) return s.mid[j]; return null; };
  const near = (day) => s.mid.reduce((b, m, j) => (Math.abs(Date.parse(m) - Date.parse(day)) < Math.abs(Date.parse(s.mid[b]) - Date.parse(day)) ? j : b), 0);
  const jMin = near("2019-12-15"), now = Math.abs(mean("polar_n", i - 6)) + Math.abs(mean("polar_s", i - 6)), then = Math.abs(mean("polar_n", jMin)) + Math.abs(mean("polar_s", jMin));
  const tilt = (s.tilt_n[i] + s.tilt_s[i]) / 2;
  tile(box, "Current-sheet tilt", `${s.tilt_n[i].toFixed(0)}° N · ${s.tilt_s[i].toFixed(0)}° S`,
    `${tilt > 60 ? "highly warped: near solar maximum" : tilt > 35 ? "warped: rising or declining phase" : "flat: near solar minimum"} · ${when}`, "series.html");
  tile(box, "Polar field", `${s.polar_n[i] > 0 ? "+" : ""}${s.polar_n[i].toFixed(1)} N · ${s.polar_s[i] > 0 ? "+" : ""}${s.polar_s[i].toFixed(1)} S G`,
    `last sign change of the mean: north ${reversal("polar_n")?.slice(0, 7) ?? "–"}, south ${reversal("polar_s")?.slice(0, 7) ?? "–"}`, "series.html");
  tile(box, "Polar-field build-up", `${Math.round(100 * now / then)}%`, `of the strength at the 2019 minimum; at the next minimum it predicts the following cycle's size`, "series.html");
  tile(box, "Open flux", `${s.flux[i].toFixed(2)} × 10²² Mx`, `open area ${(100 * s.area[i]).toFixed(1)}% · ${when}`, "series.html");
}

// ------------------------------------------------------------- sharing
function shareText() {
  const a = D?.day === S.date ? D.a : null;
  const when = fmtDay(Date.parse(S.date + "T12:00:00Z")) + " " + S.date.slice(0, 4);
  if (!a?.now) return `Space weather ${when} from HelioField's coronal model`;
  const up = a.peak && a.peak.v >= 500 && a.peak.v - a.now.v > 60 ? `, fast wind ~${Math.round(a.peak.v)} km/s around ${fmtDay(a.peak.t)}` : "";
  return `Space weather ${when} from HelioField's coronal model: ${M.windClass(a.now.v)} solar wind ~${Math.round(a.now.v)} km/s at Earth, sector pointing ${sectorFrom(a.now.b)} the Sun${up}.`;
}
// Set as soon as the date is known (and again with the day's summary once it
// has loaded), so the buttons work even while the assessment is loading.
function setupShare() {
  // Days in the record have a share page whose card shows the day's
  // assessment in the post (sw/<date>.html, written nightly); others link here.
  const carded = track?.rows?.some((r) => r.date === S.date && r.model);
  const url = carded ? `${SITE.replace("spaceweather.html", "")}sw/${S.date}.html` : `${SITE}?date=${S.date}`;
  const text = shareText(), tags = " #SpaceWeather #SolarWind", u = encodeURIComponent(url), tx = encodeURIComponent(text);
  const links = {
    x: `https://x.com/intent/post?text=${encodeURIComponent(text + tags)}&url=${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    bluesky: `https://bsky.app/intent/compose?text=${encodeURIComponent(text + tags + " " + url)}`,
    reddit: `https://www.reddit.com/submit?url=${u}&title=${tx}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text + " " + url)}`,
    email: `mailto:?subject=${encodeURIComponent("HelioField space weather, " + S.date)}&body=${encodeURIComponent(text + "\n\n" + url)}`,
  };
  for (const a of document.querySelectorAll(".share-btn[data-net]")) {
    a.href = links[a.dataset.net];
    if (a.dataset.net === "email") continue;
    // A new tab where the browser allows one; in-app and embedded browsers
    // that block new windows get the share page in this tab instead.
    a.onclick = (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      const w = window.open(a.href, "_blank");
      if (w) w.opener = null; else location.assign(a.href);
    };
  }
  const nat = $("shareNative");
  nat.hidden = !navigator.share;
  nat.onclick = () => navigator.share({ title: "HelioField space weather", text, url }).catch(() => {});
  $("copyLink").onclick = async (e) => {
    const b = e.currentTarget;
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch (err) {
      // No clipboard API (older or embedded browsers): copy through a selection.
      const t = Object.assign(document.createElement("textarea"), { value: url });
      t.style.cssText = "position:fixed;opacity:0"; document.body.append(t); t.select();
      try { ok = document.execCommand("copy"); } catch (err2) { ok = false; }
      t.remove();
    }
    if (!ok) { prompt("Copy this link", url); return; }
    b.classList.add("done"); b.title = "Link copied";
    setTimeout(() => { b.classList.remove("done"); b.title = "Copy link"; }, 1600);
  };
}

// ------------------------------------------------------------- page
function syncUrl() {
  const q = new URLSearchParams({ date: S.date });
  if (S.bg !== "speed") q.set("bg", S.bg);
  if (S.lead !== 1) q.set("lead", S.lead);
  if (EMBED) q.set("embed", 1);
  if (params.get("theme")) q.set("theme", params.get("theme"));
  history.replaceState(null, "", "?" + q);
  $("back").href = `./?date=${S.date}`;
  $("fleetLink").href = `${FLEET_URL}?${new URLSearchParams({ t: `${S.date}T12:00Z`, spirals: 1 })}`;
  const k = dates.indexOf(S.date);
  $("prev").disabled = k <= 0; $("next").disabled = k < 0 || k >= dates.length - 1;
}
function render() {
  if (!D) return;
  if (EMBED) {
    const f = $("embedFoot"), full = `${SITE}?date=${D.day}`;
    f.innerHTML = `${fmtDay(D.t0)} ${D.day.slice(0, 4)} · HelioField model wind · <a href="${full}" target="_blank" rel="noopener">Full assessment ↗</a>`;
  }
  root.style.setProperty("--pos", T().pos); root.style.setProperty("--neg", T().neg);
  assess(); drawOutlook(); drawRecord(); drawMap(); drawHoles(); drawSeason(); drawUpstream(); drawEvents(); drawCycle(); setupShare();
  labelTables();
}
async function run() {
  const status = $("status");
  status.className = "status"; status.textContent = `Loading ${S.date}…`;
  try {
    const d = await load(S.date);
    d.a = M.analyse(d);
    d.feet = M.footpoints(d.meta);
    D = d;
    D.ev = await eventsFor();
    const src = d.meta.source;
    status.textContent = `Map: ${src.name}, ${fmtT(d.t0)} UTC (CR ${d.meta.carrington_rotation}) · PFSS, source surface ${d.rss} R☉ · WSA-type speeds with illustrative coefficients.`;
    render();
  } catch (err) {
    console.error(err);
    status.className = "status warn"; status.textContent = "Could not load this day: " + err.message;
  }
}
function setupControls() {
  const inp = $("date");
  inp.min = dates[0]; inp.max = dates.at(-1); inp.value = S.date;
  const go = (day) => { S.date = day; inp.value = day; syncUrl(); setupShare(); run(); };
  // Days without a product (a missed night) snap to the nearest one.
  const nearest = (day) => dates.reduce((b, x) => (Math.abs(Date.parse(x) - Date.parse(day)) < Math.abs(Date.parse(b) - Date.parse(day)) ? x : b), dates.at(-1));
  datePicker(inp, { label: "Date", marked: (d) => dates.includes(d) });       // days with a daily product
  inp.onchange = (e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) go(nearest(e.target.value)); };
  $("prev").onclick = () => { const k = dates.indexOf(S.date); if (k > 0) go(dates[k - 1]); };
  $("next").onclick = () => { const k = dates.indexOf(S.date); if (k < dates.length - 1) go(dates[k + 1]); };
  for (const b of document.querySelectorAll("[data-bg]")) b.onclick = () => {
    S.bg = b.dataset.bg;
    for (const x of document.querySelectorAll("[data-bg]")) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); }
    syncUrl(); if (D) drawMap();
  };
  for (const x of document.querySelectorAll("[data-bg]")) { x.classList.toggle("on", x.dataset.bg === S.bg); x.setAttribute("aria-pressed", x.dataset.bg === S.bg); }
}

const themeBtn = $("theme");
const themeLabel = () => { const l = root.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"; themeBtn.setAttribute("aria-label", l); themeBtn.title = l; };
themeBtn.onclick = () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("hf.theme", root.dataset.theme); } catch (e) {}
  themeLabel(); render();
};
themeLabel();
let lastW = 0;
new ResizeObserver(() => {
  const w = document.querySelector(".page").clientWidth;
  if (D && Math.abs(w - lastW) > 4) { lastW = w; drawOutlook(); drawRecord(); drawSeason(); }
}).observe(document.querySelector(".page"));

(async () => {
  try {
    const idx = await fetch("data/index.json").then((r) => r.json());
    dates = idx.dates;
    const want = params.get("date");
    S.date = dates.includes(want) ? want : dates.at(-1);
    setupControls(); syncUrl(); setupShare();
    [events, series, track] = await Promise.all([
      fetch(`${FLEET_URL}data/events.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("data/series/rotations.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("data/spaceweather/daily.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    await run();
  } catch (err) {
    console.error(err);
    $("status").textContent = "The daily products could not be loaded.";
  }
})();
