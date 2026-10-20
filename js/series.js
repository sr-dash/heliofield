// Solar-cycle series page: one SVG line chart per quantity, sharing one time
// range. Each series is drawn twice: every rotation as a thin faint line, and
// its 13-rotation running mean as the 2 px line the eye follows. Colours come
// from theme.js (validated there); text always wears the page's text tokens.

import { THEMES, currentTheme } from "./theme.js";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const DAY = 86400000;
const RANGES = {
  all: () => [Date.UTC(2010, 0, 1), Infinity],
  c24: () => [Date.UTC(2010, 0, 1), Date.UTC(2019, 11, 15)],
  c25: () => [Date.UTC(2019, 11, 15), Infinity],
  "3y": (last) => [last - 3 * 365.25 * DAY, Infinity],
};
const params = new URLSearchParams(location.search);
// Embed mode (?embed=1): the charts alone, for an iframe. compact=1 makes
// them small enough for a side panel; charts= picks which; mark= draws the
// date a host page (such as the 3D viewer) is showing.
const EMBED = params.get("embed") === "1", COMPACT = EMBED && params.get("compact") === "1";
const parseDay = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v || "") ? Date.parse(v.slice(0, 10) + "T12:00:00Z") : null);
const state = { range: "all", data: null, mark: parseDay(params.get("mark")) };

const CHARTS = [
  { id: "flux", unit: "× 10²² Mx", fmt: (v) => v.toFixed(2), zero: true,
    series: [{ key: "flux", label: "Open flux", slot: "a" }] },
  { id: "area", unit: "%", fmt: (v) => v.toFixed(1), zero: true, scale: 100,
    series: [{ key: "area", label: "Open area", slot: "a" }] },
  { id: "tilt", unit: "°", fmt: (v) => v.toFixed(0), zero: true, max: 90,
    series: [{ key: "tilt_n", label: "North", slot: "a" }, { key: "tilt_s", label: "South", slot: "b" }] },
  { id: "polar", unit: "G", fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(2), zero: true, symmetric: true,
    series: [{ key: "polar_n", label: "North", slot: "a" }, { key: "polar_s", label: "South", slot: "b" }] },
];

// Charts shown: all, or the ones named in ?charts=flux,tilt,...
const WANT = (params.get("charts") || "").split(",").filter((c) => CHARTS.some((x) => x.id === c));
const SHOWN = WANT.length ? CHARTS.filter((c) => WANT.includes(c.id)) : CHARTS;
for (const c of CHARTS) if (!SHOWN.includes(c)) $(c.id)?.remove();

// The rotation nearest a time, if one lies within half a rotation of it.
function rotationAt(tm) {
  const t = state.data.t;
  let best = -1, gap = Infinity;
  t.forEach((x, i) => { const g = Math.abs(x - tm); if (g < gap) { gap = g; best = i; } });
  return gap <= 14 * DAY ? best : -1;
}

// Centred running mean; a value needs at least `need` of its `n` neighbours.
function runningMean(v, n = 13, need = 7) {
  const h = (n - 1) >> 1;
  return v.map((_, i) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(v.length - 1, i + h); k++) if (Number.isFinite(v[k])) { s += v[k]; c++; }
    return c >= need ? s / c : null;
  });
}

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};

// ------------------------------------------------------------------ tiles
function tiles() {
  const d = state.data, i = d.cr.length - 1, box = $("tiles");
  box.replaceChildren();
  const add = (label, value, note) => {
    const t = document.createElement("div"); t.className = "tile";
    const l = document.createElement("div"); l.className = "label"; l.textContent = label;
    const v = document.createElement("div"); v.className = "value"; v.textContent = value;
    const n = document.createElement("div"); n.className = "note"; n.textContent = note;
    t.append(l, v, n); box.append(t);
  };
  const when = `CR ${d.cr[i]}, centred on ${d.mid[i]}`;
  add("Open flux", `${d.flux[i].toFixed(2)} × 10²² Mx`, when);
  add("Open area", `${(d.area[i] * 100).toFixed(1)} %`, when);
  add("Current-sheet tilt", `${d.tilt_n[i].toFixed(0)}° N · ${d.tilt_s[i].toFixed(0)}° S`, when);
  add("Polar field", `${d.polar_n[i] > 0 ? "+" : ""}${d.polar_n[i].toFixed(1)} N · ${d.polar_s[i] > 0 ? "+" : ""}${d.polar_s[i].toFixed(1)} S G`, when);
}

// ------------------------------------------------------------------ charts
function draw(cfg) {
  const sec = $(cfg.id), d = state.data, th = THEMES[currentTheme()];
  const cs = getComputedStyle(document.documentElement);
  const ink = { text: cs.getPropertyValue("--text").trim(), muted: cs.getPropertyValue("--muted").trim(), grid: cs.getPropertyValue("--grid").trim() };
  let fig = sec.querySelector("figure");
  if (!fig) {
    fig = document.createElement("figure");
    sec.append(fig);
    if (!COMPACT) sec.append(tableView(cfg));
  }
  fig.replaceChildren();

  // Legend first: identity never rests on colour alone.
  const leg = document.createElement("div"); leg.className = "legend";
  const unit = document.createElement("span"); unit.className = "unit"; unit.textContent = cfg.unit;
  leg.append(unit);
  if (cfg.series.length > 1) for (const s of cfg.series) {
    const it = document.createElement("span"), k = document.createElement("i");
    k.className = "lkey"; k.style.background = th.chart[s.slot];
    const t = document.createElement("span"); t.textContent = s.label;
    it.append(k, t); leg.append(it);
  }
  const how = document.createElement("span"); how.className = "how";
  const thin = document.createElement("i"); thin.className = "lkey thin";
  const thick = document.createElement("i"); thick.className = "lkey";
  how.append(thin, document.createTextNode("each rotation"), thick, document.createTextNode("13-rotation mean"));
  if (!COMPACT) leg.append(how);
  const mi = state.mark != null ? rotationAt(state.mark) : -1;
  if (state.mark != null) {
    const mk = document.createElement("span"); mk.className = "mark";
    const k = document.createElement("i"); k.className = "lkey dash";
    mk.append(k, document.createTextNode(new Date(state.mark).toISOString().slice(0, 10) + (mi >= 0 ? ` · CR ${d.cr[mi]}` : " · after the latest rotation map")));
    leg.append(mk);
  }
  fig.append(leg);

  const t = d.t, [r0, r1] = RANGES[state.range](t[t.length - 1]);
  const idx = t.map((x, i) => i).filter((i) => t[i] >= r0 && t[i] <= r1);
  const W = Math.max(COMPACT ? 200 : 280, fig.clientWidth), H = COMPACT ? 96 : W < 560 ? 200 : 240;
  const m = COMPACT ? { l: 40, r: 10, t: 8, b: 22 } : { l: 46, r: W < 560 ? 12 : 58, t: 10, b: 26 };
  const scale = cfg.scale || 1;
  const vals = cfg.series.map((s) => d[s.key].map((v) => (v == null ? null : v * scale)));
  const means = vals.map((v) => runningMean(v));
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) for (const i of idx) if (v[i] != null) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  if (cfg.zero) lo = Math.min(lo, 0);
  if (cfg.symmetric) { const a = Math.max(Math.abs(lo), Math.abs(hi)); lo = -a; hi = a; }
  if (cfg.max) hi = cfg.max;
  const yt = niceTicks(lo, hi);
  lo = Math.min(lo, yt[0]); hi = Math.max(hi, yt[yt.length - 1]);
  const xa = t[idx[0]];
  // A marked date newer than the latest rotation still gets its line.
  const xb = Math.max(t[idx[idx.length - 1]], state.mark != null && state.mark >= xa && state.mark <= r1 ? state.mark : -Infinity);
  const X = (x) => m.l + ((x - xa) / (xb - xa || 1)) * (W - m.l - m.r);
  const Y = (y) => m.t + (1 - (y - lo) / (hi - lo || 1)) * (H - m.t - m.b);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: 0,
    "aria-label": `${sec.querySelector("h2").textContent}, ${d.mid[idx[0]]} to ${d.mid[idx[idx.length - 1]]}. Use the arrow keys to read values; the table below lists them all.` });
  fig.append(svg);

  // Grid and axes: solid hairlines, recessive.
  for (const v of yt) {
    el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: ink.grid, "stroke-width": v === 0 && lo < 0 ? 1.5 : 1 }, svg);
    const tx = el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", fill: ink.muted, class: "tick" }, svg);
    tx.textContent = cfg.fmt(v).replace(/\.0+$/, "");
  }
  const y0 = new Date(xa).getUTCFullYear(), y1 = new Date(xb).getUTCFullYear();
  const every = Math.max(1, Math.ceil((y1 - y0 + 1) / Math.floor((W - m.l - m.r) / 46)));
  for (let y = y0; y <= y1 + 1; y++) {
    const x = Date.UTC(y, 0, 1);
    if (x < xa || x > xb || (y - y0) % every) continue;
    el("line", { x1: X(x), x2: X(x), y1: H - m.b, y2: H - m.b + 4, stroke: ink.grid }, svg);
    const tx = el("text", { x: X(x), y: H - 8, "text-anchor": "middle", fill: ink.muted, class: "tick" }, svg);
    tx.textContent = y;
  }

  const path = (v) => {
    let s = "", pen = false;
    for (const i of idx) {
      if (v[i] == null) { pen = false; continue; }
      s += `${pen ? "L" : "M"}${X(t[i]).toFixed(1)},${Y(v[i]).toFixed(1)}`; pen = true;
    }
    return s;
  };
  cfg.series.forEach((s, k) => {
    const c = th.chart[s.slot];
    el("path", { d: path(vals[k]), fill: "none", stroke: c, "stroke-width": 1.2, "stroke-opacity": 0.4, "stroke-linejoin": "round" }, svg);
  });
  cfg.series.forEach((s, k) => {
    const c = th.chart[s.slot];
    el("path", { d: path(means[k]), fill: "none", stroke: c, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
  });
  // The marked date: a dashed line, and a ring on each series at the
  // rotation that covers it.
  if (state.mark != null && state.mark >= xa && state.mark <= xb) {
    el("line", { x1: X(state.mark), x2: X(state.mark), y1: m.t, y2: H - m.b, stroke: ink.text, "stroke-width": 1.5, "stroke-dasharray": "4 3" }, svg);
    if (mi >= 0 && idx.includes(mi)) cfg.series.forEach((s, k) => {
      if (vals[k][mi] == null) return;
      el("circle", { cx: X(t[mi]), cy: Y(vals[k][mi]), r: 5, fill: th.chart[s.slot], stroke: ink.text, "stroke-width": 2 }, svg);
    });
  }

  // Direct end labels on the mean lines, when there is room and they don't collide.
  if (m.r > 40 && cfg.series.length > 1) {
    const ends = cfg.series.map((s, k) => {
      const i = [...idx].reverse().find((j) => means[k][j] != null);
      return i == null ? null : { s, y: Y(means[k][i]), x: X(t[i]) };
    });
    if (ends.every(Boolean) && Math.abs(ends[0].y - ends[1].y) > 14) for (const e of ends) {
      const tx = el("text", { x: e.x + 6, y: e.y + 4, fill: ink.text, class: "end" }, svg);
      tx.textContent = e.s.label;
    }
  }

  // Hover layer: crosshair snapped to the nearest rotation.
  const cross = el("g", { visibility: "hidden" }, svg);
  const vline = el("line", { y1: m.t, y2: H - m.b, stroke: ink.muted, "stroke-width": 1 }, cross);
  const dots = cfg.series.map((s) => el("circle", { r: 4, fill: th.chart[s.slot], stroke: th.bg, "stroke-width": 2 }, cross));
  const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
  let cur = idx.length - 1;
  const show = (j, px, py) => {
    cur = Math.max(0, Math.min(idx.length - 1, j));
    const i = idx[cur], x = X(t[i]);
    cross.setAttribute("visibility", "visible");
    vline.setAttribute("x1", x); vline.setAttribute("x2", x);
    cfg.series.forEach((s, k) => {
      const v = vals[k][i];
      dots[k].setAttribute("visibility", v == null ? "hidden" : "visible");
      if (v != null) { dots[k].setAttribute("cx", x); dots[k].setAttribute("cy", Y(v)); }
    });
    tip(cfg, i, vals, means, th, px, py, svg, x);
  };
  const nearest = (clientX) => {
    const b = svg.getBoundingClientRect(), x = ((clientX - b.left) / b.width) * W;
    let best = 0, gap = Infinity;
    idx.forEach((i, j) => { const g = Math.abs(X(t[i]) - x); if (g < gap) { gap = g; best = j; } });
    return best;
  };
  hit.addEventListener("pointermove", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener("pointerdown", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  // In an embed, a click hands the rotation to the host page (the viewer
  // opens that date).
  if (EMBED && window.parent !== window) {
    hit.style.cursor = "pointer";
    hit.addEventListener("click", (e) => {
      const i = idx[nearest(e.clientX)];
      window.parent.postMessage({ type: "heliofield-series:pick", date: d.mid[i], cr: d.cr[i] }, "*");
    });
  }
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  svg.addEventListener("focus", () => show(cur));
  svg.addEventListener("blur", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  svg.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -13, PageDown: 13, Home: -1e6, End: 1e6 }[e.key];
    if (step != null) { e.preventDefault(); show(cur + step); }
    if (e.key === "Escape") { cross.setAttribute("visibility", "hidden"); hideTip(); }
  });
}

function tip(cfg, i, vals, means, th, px, py, svg, x) {
  const d = state.data, box = $("tip");
  box.replaceChildren();
  const h = document.createElement("div"); h.className = "head";
  h.textContent = `CR ${d.cr[i]} · ${d.mid[i]}`;
  box.append(h);
  cfg.series.forEach((s, k) => {
    const row = document.createElement("div"); row.className = "row";
    const key = document.createElement("i"); key.className = "lkey"; key.style.background = th.chart[s.slot];
    const v = document.createElement("b");
    v.textContent = vals[k][i] == null ? "–" : `${cfg.fmt(vals[k][i])} ${cfg.unit}`;
    const l = document.createElement("span");
    l.textContent = `${s.label}${means[k][i] == null ? "" : ` · mean ${cfg.fmt(means[k][i])}`}`;
    row.append(key, v, l); box.append(row);
  });
  box.hidden = false;
  // Pointer: beside it. Keyboard: above the crosshair.
  const b = svg.getBoundingClientRect(), tw = box.offsetWidth, tht = box.offsetHeight;
  let left = px ?? b.left + (x / svg.viewBox.baseVal.width) * b.width, top = py ?? b.top + 10;
  left = left + 16 + tw > innerWidth - 8 ? left - 16 - tw : left + 16;
  top = Math.min(Math.max(8, top - tht / 2), innerHeight - tht - 8);
  box.style.left = `${Math.max(8, left)}px`; box.style.top = `${top}px`;
}
const hideTip = () => { $("tip").hidden = true; };

// Every value without hovering: a table, built when first opened.
function tableView(cfg) {
  const det = document.createElement("details"); det.className = "table";
  const sum = document.createElement("summary"); sum.textContent = "Data table";
  det.append(sum);
  det.addEventListener("toggle", () => {
    if (!det.open || det.querySelector("table")) return;
    const d = state.data, tb = document.createElement("table"), hr = document.createElement("tr");
    for (const h of ["CR", "Centred on", ...cfg.series.map((s) => `${s.label} (${cfg.unit})`)]) {
      const th = document.createElement("th"); th.textContent = h; hr.append(th);
    }
    tb.append(hr);
    for (let i = d.cr.length - 1; i >= 0; i--) {
      const tr = document.createElement("tr");
      for (const v of [d.cr[i], d.mid[i], ...cfg.series.map((s) => (d[s.key][i] == null ? "–" : cfg.fmt(d[s.key][i] * (cfg.scale || 1))))]) {
        const td = document.createElement("td"); td.textContent = v; tr.append(td);
      }
      tb.append(tr);
    }
    const wrap = document.createElement("div"); wrap.className = "scroll"; wrap.append(tb);
    det.append(wrap);
  });
  return det;
}

function render() { if (state.data) { if (!COMPACT) tiles(); SHOWN.forEach(draw); } }

// ------------------------------------------------------------------ controls
for (const b of document.querySelectorAll(".filters button[data-range]")) {
  b.onclick = () => {
    state.range = b.dataset.range;
    for (const o of document.querySelectorAll(".filters button[data-range]")) {
      o.classList.toggle("on", o === b); o.setAttribute("aria-pressed", o === b);
    }
    const u = new URL(location.href);
    if (state.range === "all") u.searchParams.delete("range"); else u.searchParams.set("range", state.range);
    history.replaceState(null, "", u);
    render();
  };
}
const themeBtn = $("theme"), root = document.documentElement;
const themeLabel = () => { themeBtn.textContent = root.dataset.theme === "dark" ? "Light theme" : "Dark theme"; };
themeBtn.onclick = () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("hf.theme", root.dataset.theme); } catch (e) {}
  themeLabel(); render();
};
themeLabel();
let lastW = 0;
new ResizeObserver(() => {
  const w = document.querySelector(".page").clientWidth;
  if (Math.abs(w - lastW) > 4) { lastW = w; render(); }
}).observe(document.querySelector(".page"));

// Host pages drive an embed with
//   frame.contentWindow.postMessage({ type: "heliofield-series:set", mark: "2014-03-12", theme: "light", range: "c24" }, "*")
// and hear { type: "heliofield-series:pick", date, cr } when a rotation is clicked.
addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.type !== "heliofield-series:set") return;
  if ("mark" in m) state.mark = parseDay(m.mark);
  if (m.theme === "light" || m.theme === "dark") { root.dataset.theme = m.theme; themeLabel(); }
  if (m.range && RANGES[m.range]) { document.querySelector(`.filters button[data-range="${m.range}"]`)?.click(); return; }
  render();
});

// Embed code for the current range (and charts, if a subset is shown).
$("copyEmbed")?.addEventListener("click", async (e) => {
  const u = new URL("series.html", location.href);
  u.searchParams.set("embed", "1");
  if (state.range !== "all") u.searchParams.set("range", state.range);
  if (WANT.length) u.searchParams.set("charts", WANT.join(","));
  const code = `<iframe src="${u.href}" title="HelioField solar-cycle series: PFSS open flux, open area, current-sheet tilt and polar field since 2010" `
    + `width="100%" height="900" style="border:0;border-radius:12px" loading="lazy"></iframe>`;
  const out = $("embedOut");
  out.hidden = false; out.value = code; out.select();
  try { await navigator.clipboard.writeText(code); e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy embed code"; }, 1400); } catch (err) { /* the text is selected for copying */ }
});

(async () => {
  try {
    const d = await fetch("data/series/rotations.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    d.t = d.mid.map((s) => Date.parse(s + "T00:00:00Z"));
    state.data = d;
    const r = new URLSearchParams(location.search).get("range");
    if (r && RANGES[r]) document.querySelector(`.filters button[data-range="${r}"]`)?.click();
    else render();
    if (EMBED && window.parent !== window) window.parent.postMessage({ type: "heliofield-series:ready" }, "*");
  } catch (e) {
    console.error(e);
    $("tiles").textContent = "The series could not be loaded.";
  }
})();
