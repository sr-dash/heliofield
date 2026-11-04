// An accessible calendar for the date fields of HelioField and HelioFleet
// (the same file in both). Browsers do not let a page style their own date
// popups, so this one replaces the popup while keeping the native field: its
// value, min, max, typing and change events stay as they were.
//
//   enhance(input, { marked: (iso) => boolean, label: "Date" })
//
// - Day cells 44 px with 16 px numbers (WCAG 2.5.5 target size); colours
//   from the page's own tokens, with a 3 px focus ring.
// - A grid with a roving focus: arrows move a day or a week, Page Up/Down a
//   month (with Shift, a year), Home/End the week's ends, Enter or Space
//   picks, Escape closes and returns focus to the field.
// - Month and year menus for long jumps (HelioField reaches back to 2010).
// - marked: days with data (images, a daily product) get a dot, and screen
//   readers hear "data available".
// - On a phone the calendar opens as a sheet along the bottom of the screen.
// - Month and day names in the page's language (HelioFleet: English, Hindi,
//   Spanish).

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s || "") ? new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))) : null);
const lang = () => document.documentElement.lang || "en";
const TEXT = {
  en: { open: "Choose a date", prev: "Previous month", next: "Next month", month: "Month", year: "Year", today: "Today", close: "Close", data: "data available", none: "no data" },
  hi: { open: "तिथि चुनें", prev: "पिछला महीना", next: "अगला महीना", month: "महीना", year: "वर्ष", today: "आज", close: "बंद करें", data: "डेटा उपलब्ध", none: "डेटा नहीं" },
  es: { open: "Elegir una fecha", prev: "Mes anterior", next: "Mes siguiente", month: "Mes", year: "Año", today: "Hoy", close: "Cerrar", data: "con datos", none: "sin datos" },
};
const t = (k) => (TEXT[lang().slice(0, 2)] || TEXT.en)[k];

const CSS = `
.dp-wrap { display: inline-flex; align-items: stretch; gap: 0; position: relative; }
.dp-wrap > input { flex: 1 1 auto; min-width: 0; border-top-right-radius: 0 !important; border-bottom-right-radius: 0 !important; }
.dp-wrap > input::-webkit-calendar-picker-indicator { display: none; }
.dp-btn { --dp-a: var(--accent, #9cc0ff); display: inline-flex; align-items: center; justify-content: center; min-width: 40px; min-height: 36px;
  border: 1px solid var(--line, rgba(127,127,127,.4)); border-left: 0; border-radius: 0 8px 8px 0; cursor: pointer;
  background: var(--card, var(--surface, var(--panel, #141a26))); color: var(--text, var(--ink, #e8eaf0)); padding: 0 9px; }
.dp-btn:hover { color: var(--dp-a); }
.dp-btn:focus-visible { outline: 3px solid var(--dp-a); outline-offset: 2px; }
.dp-btn svg { width: 19px; height: 19px; }
.dp { --dp-a: var(--accent, #9cc0ff); --dp-bg: var(--card, var(--surface, var(--panel, #141a26))); --dp-ink: var(--text, var(--ink, #e8eaf0));
  --dp-mut: var(--muted, #a3abbb); --dp-line: var(--line, rgba(127,127,127,.35));
  position: fixed; z-index: 100000; width: 352px; padding: 14px; border-radius: 14px; background: var(--dp-bg); color: var(--dp-ink);
  border: 1px solid var(--dp-line); box-shadow: 0 16px 48px rgba(0,0,0,.45); font: 16px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.dp[hidden] { display: none; }
.dp-head { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; }
.dp-head select { flex: 1; min-height: 40px; font-weight: 600; font-size: 16px; line-height: 1; font-family: inherit; color: var(--dp-ink); background: var(--dp-bg);
  border: 1px solid var(--dp-line); border-radius: 8px; padding: 0 8px; cursor: pointer; }
.dp-nav { width: 40px; height: 40px; flex: none; border: 1px solid var(--dp-line); border-radius: 8px; background: none; color: var(--dp-ink); cursor: pointer; font-weight: 600; font-size: 20px; line-height: 1; font-family: inherit; }
.dp-nav:hover { border-color: var(--dp-a); }
.dp-nav:disabled { opacity: .35; cursor: default; }
.dp table { border-collapse: collapse; width: 100%; table-layout: fixed; margin: 0; }
.dp th { font-weight: 600; font-size: 13px; line-height: 1; font-family: inherit; color: var(--dp-mut); text-transform: none; letter-spacing: 0; padding: 0 0 8px; text-align: center; border: 0; }
.dp td { padding: 2px; text-align: center; border: 0; }
.dp-day { position: relative; width: 44px; height: 44px; border-radius: 10px; border: 1px solid transparent; background: none;
  color: var(--dp-ink); font-weight: 500; font-size: 16px; line-height: 1; font-family: inherit; cursor: pointer; font-variant-numeric: tabular-nums; }
.dp-day:hover:not([aria-disabled="true"]) { border-color: var(--dp-a); }
.dp-day.out { color: var(--dp-mut); opacity: .6; }
.dp-day[aria-disabled="true"] { color: var(--dp-mut); opacity: .38; cursor: not-allowed; text-decoration: line-through; text-decoration-thickness: 1px; }
.dp-day.today { border-color: var(--dp-mut); }
.dp-day[aria-selected="true"] { background: var(--dp-a); color: var(--accent-ink, var(--bg, #0b1026)); font-weight: 700; }
.dp-day.mark::after { content: ""; position: absolute; left: 50%; bottom: 6px; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; background: var(--dp-a); }
.dp-day[aria-selected="true"].mark::after { background: var(--accent-ink, var(--bg, #0b1026)); }
.dp-day:focus-visible, .dp-head select:focus-visible, .dp-nav:focus-visible, .dp-foot button:focus-visible { outline: 3px solid var(--dp-a); outline-offset: 2px; }
.dp-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; }
.dp-foot button { min-height: 40px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--dp-line); background: none; color: var(--dp-ink); font-weight: 600; font-size: 15px; line-height: 1; font-family: inherit; cursor: pointer; }
.dp-foot button:hover { border-color: var(--dp-a); color: var(--dp-a); }
.dp-key { font-size: 13px; color: var(--dp-mut); display: inline-flex; align-items: center; gap: 6px; }
.dp-key i { width: 6px; height: 6px; border-radius: 50%; background: var(--dp-a); display: inline-block; }
@media (max-width: 520px) {
  .dp { left: 0 !important; right: 0; bottom: 0; top: auto !important; width: auto; border-radius: 16px 16px 0 0; padding: 16px 12px calc(16px + env(safe-area-inset-bottom)); }
  .dp-day { width: 100%; max-width: 52px; height: 48px; font-size: 17px; }
}
@media (prefers-reduced-motion: no-preference) { .dp { animation: dp-in .12s ease-out; } }
@keyframes dp-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
`;
let styled = false, open = null;
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';

export function enhance(input, opts = {}) {
  if (!input || input.dataset.dp) return;
  if (!styled) { const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); styled = true; }
  input.dataset.dp = "1";
  const wrap = document.createElement("span"); wrap.className = "dp-wrap";
  input.replaceWith(wrap); wrap.append(input);
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "dp-btn"; btn.innerHTML = ICON;
  btn.setAttribute("aria-label", t("open")); btn.setAttribute("aria-haspopup", "dialog"); btn.setAttribute("aria-expanded", "false");
  wrap.append(btn);
  const state = { input, btn, opts };
  btn.addEventListener("click", () => (open?.state === state ? close() : show(state)));
  // A click on the field opens the calendar too; typing still edits it.
  input.addEventListener("click", (e) => { e.preventDefault(); if (open?.state !== state) show(state); });
  input.addEventListener("keydown", (e) => { if ((e.altKey && e.key === "ArrowDown") || e.key === "F4") { e.preventDefault(); show(state); } });
  return { refresh: () => open?.state === state && render(open) };
}
// Change what counts as a day with data (for example once an index loads).
export function setMarked(input, fn) {
  if (!input) return;
  input._dpMarked = fn;
  if (open?.state.input === input) render(open);
}

const isDT = (input) => input.type === "datetime-local";
const valueDate = (input) => parse(input.value) || parse(input.max) || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const bounds = (input) => [parse(input.min), parse(input.max)];

function show(state) {
  close(false);
  const box = document.createElement("div");
  box.className = "dp"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "false");
  box.setAttribute("aria-label", state.opts.label || state.input.getAttribute("aria-label") || state.input.closest("label")?.textContent.trim() || t("open"));
  document.body.append(box);
  open = { state, box, focus: valueDate(state.input), view: null };
  open.view = new Date(Date.UTC(open.focus.getUTCFullYear(), open.focus.getUTCMonth(), 1));
  state.btn.setAttribute("aria-expanded", "true");
  render(open, true);
  place(open);
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  window.addEventListener("resize", reposition); window.addEventListener("scroll", reposition, true);
}
function close(refocus = true) {
  if (!open) return;
  const { state, box } = open;
  box.remove(); state.btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true);
  open = null;
  if (refocus) state.input.focus();
}
const outside = (e) => { if (open && !open.box.contains(e.target) && !open.state.btn.contains(e.target) && e.target !== open.state.input) close(false); };
const reposition = () => open && place(open);
function place(o) {
  const r = o.state.input.closest(".dp-wrap").getBoundingClientRect(), w = o.box.offsetWidth, h = o.box.offsetHeight;
  let left = Math.min(Math.max(8, r.left), innerWidth - w - 8), top = r.bottom + 6;
  if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
  o.box.style.left = `${left}px`; o.box.style.top = `${Math.max(8, top)}px`;
}

function render(o, focusDay = false) {
  const { state, box } = o, [min, max] = bounds(state.input), sel = parse(state.input.value);
  const marked = state.input._dpMarked || state.opts.marked;
  const fmtM = new Intl.DateTimeFormat(lang(), { month: "long", timeZone: "UTC" });
  const fmtW = new Intl.DateTimeFormat(lang(), { weekday: "short", timeZone: "UTC" });
  const fmtL = new Intl.DateTimeFormat(lang(), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const y = o.view.getUTCFullYear(), m = o.view.getUTCMonth();
  const y0 = min ? min.getUTCFullYear() : y - 20, y1 = max ? max.getUTCFullYear() : y + 5;
  const today = iso(new Date());
  const monthOpts = Array.from({ length: 12 }, (_, k) => `<option value="${k}"${k === m ? " selected" : ""}>${fmtM.format(new Date(Date.UTC(2000, k, 1)))}</option>`).join("");
  const yearOpts = Array.from({ length: y1 - y0 + 1 }, (_, k) => y0 + k).map((v) => `<option value="${v}"${v === y ? " selected" : ""}>${v}</option>`).join("");
  // Weeks start on Monday, as in ISO 8601.
  const first = new Date(Date.UTC(y, m, 1)), lead = (first.getUTCDay() + 6) % 7, start = new Date(first - lead * DAY);
  let rows = "";
  for (let w = 0; w < 6; w++) {
    rows += "<tr>";
    for (let k = 0; k < 7; k++) {
      const d = new Date(+start + (7 * w + k) * DAY), s = iso(d);
      const off = (min && d < min) || (max && d > max), mk = !off && marked ? marked(s) : null;
      const cls = ["dp-day", d.getUTCMonth() !== m ? "out" : "", s === today ? "today" : "", mk ? "mark" : ""].join(" ").trim();
      const lab = `${fmtL.format(d)}${mk === true ? `, ${t("data")}` : mk === false ? `, ${t("none")}` : ""}`;
      rows += `<td><button type="button" class="${cls}" data-d="${s}" tabindex="-1" aria-label="${lab}"${off ? ' aria-disabled="true"' : ""}${sel && iso(sel) === s ? ' aria-selected="true"' : ""}${s === today ? ' aria-current="date"' : ""}>${d.getUTCDate()}</button></td>`;
    }
    rows += "</tr>";
  }
  const heads = Array.from({ length: 7 }, (_, k) => `<th scope="col" abbr="${fmtW.format(new Date(Date.UTC(2024, 0, 1 + k)))}">${fmtW.format(new Date(Date.UTC(2024, 0, 1 + k))).slice(0, 2)}</th>`).join("");
  const prevOk = !min || new Date(Date.UTC(y, m, 0)) >= min, nextOk = !max || new Date(Date.UTC(y, m + 1, 1)) <= max;
  box.innerHTML = `<div class="dp-head">
      <button type="button" class="dp-nav" data-nav="-1" aria-label="${t("prev")}"${prevOk ? "" : " disabled"}>‹</button>
      <select aria-label="${t("month")}" data-sel="m">${monthOpts}</select>
      <select aria-label="${t("year")}" data-sel="y">${yearOpts}</select>
      <button type="button" class="dp-nav" data-nav="1" aria-label="${t("next")}"${nextOk ? "" : " disabled"}>›</button>
    </div>
    <table role="grid" aria-label="${fmtM.format(o.view)} ${y}"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>
    <div class="dp-foot">${marked ? `<span class="dp-key"><i></i>${t("data")}</span>` : "<span></span>"}
      <span><button type="button" data-act="today">${t("today")}</button> <button type="button" data-act="close">${t("close")}</button></span></div>`;
  // Roving focus: one day is tabbable.
  const want = iso(o.focus), btn = box.querySelector(`.dp-day[data-d="${want}"]`) || box.querySelector(".dp-day:not(.out)");
  btn.tabIndex = 0;
  if (focusDay) btn.focus();
  box.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.nav) return go(o, 0, +b.dataset.nav);
    if (b.dataset.act === "close") return close();
    if (b.dataset.act === "today") { const d = parse(today); if (!((min && d < min) || (max && d > max))) pick(o, today); else { o.focus = clamp(d, min, max); o.view = monthOf(o.focus); render(o, true); } return; }
    if (b.dataset.d && b.getAttribute("aria-disabled") !== "true") pick(o, b.dataset.d);
  };
  box.onchange = (e) => {
    const s = e.target.dataset.sel;
    if (!s) return;
    const ny = s === "y" ? +e.target.value : y, nm = s === "m" ? +e.target.value : m;
    o.view = new Date(Date.UTC(ny, nm, 1));
    o.focus = clamp(new Date(Date.UTC(ny, nm, Math.min(o.focus.getUTCDate(), 28))), min, max);
    render(o); box.querySelector(`[data-sel="${s}"]`).focus();
  };
  box.onkeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); return close(); }
    if (e.key === "Tab") {                                           // keep focus inside while it is open
      const f = [...box.querySelectorAll("button:not([disabled]):not([tabindex='-1']), select")];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i === 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (!e.target.classList.contains("dp-day")) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step != null) { e.preventDefault(); return move(o, step); }
    if (e.key === "PageUp" || e.key === "PageDown") { e.preventDefault(); return go(o, 0, (e.key === "PageUp" ? -1 : 1) * (e.shiftKey ? 12 : 1), true); }
    if (e.key === "Home" || e.key === "End") { e.preventDefault(); const wd = (o.focus.getUTCDay() + 6) % 7; return move(o, e.key === "Home" ? -wd : 6 - wd); }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (e.target.getAttribute("aria-disabled") !== "true") pick(o, e.target.dataset.d); }
  };
}
const monthOf = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const clamp = (d, min, max) => (min && d < min ? min : max && d > max ? max : d);
function move(o, days) {
  const [min, max] = bounds(o.state.input);
  o.focus = clamp(new Date(+o.focus + days * DAY), min, max);
  o.view = monthOf(o.focus); render(o, true);
}
function go(o, _, months, keepFocus = false) {
  const [min, max] = bounds(o.state.input), d = o.focus;
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0)).getUTCDate();
  o.focus = clamp(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(d.getUTCDate(), last))), min, max);
  o.view = monthOf(o.focus); render(o, keepFocus);
  if (!keepFocus) o.box.querySelector(`[data-nav="${months < 0 ? -1 : 1}"]`)?.focus();
}
function pick(o, s) {
  const input = o.state.input;
  // A date and time field keeps its time of day.
  input.value = isDT(input) ? `${s}T${(input.value.split("T")[1] || "12:00").slice(0, 5)}` : s;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  close();
}
