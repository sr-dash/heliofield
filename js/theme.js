// Colours for the scene, in both themes.
//
// Every value here was validated (OKLab, Machado 2009 colour-vision
// simulation) against the scene background of its theme:
//  - field classes (open +, open -, closed, current sheet) as an all-pairs
//    set: worst protan/deutan separation 9.8 dark / 15.6 light (target 8),
//    worst normal-vision separation 17 / 21 (floor 15), every colour >= 3:1
//    against the background (WCAG 2.1 SC 1.4.11);
//  - spacecraft in a fixed categorical order, >= 3:1 in both themes, always
//    with a text label beside the marker.
// One hue per role in both themes; only lightness changes between them.
// If a value changes, re-run the validation, not a visual check.

export const THEMES = {
  dark: {
    bg: "#080b14", occluder: "#141a26", planet: "#a3abbb",
    pos: "#c28412",     // open field, outward (gold)
    neg: "#1687a9",     // open field, inward (cerulean)
    closed: "#6b50c2",  // closed field (violet)
    hcs: "#d7506e",     // neutral line and current sheet (rose)
    fleet: { earth: "#3987e5", psp: "#d95926", solo: "#199e70", sta: "#c98500", bepi: "#d55181", l1: "#008300", stb: "#9085e9" },
    // Series page (series.html), in this order: one series takes `a`; north
    // and south hemispheres take `a` and `b`. Checked as a categorical pair
    // against bg: protan/deutan dE 26.8, normal 31.8, both >= 3:1.
    chart: { a: "#3987e5", b: "#d95926" },
  },
  light: {
    bg: "#f6f3ec", occluder: "#d9d5cc", planet: "#545c6c",
    pos: "#a67110",
    neg: "#0a8aae",
    closed: "#583bab",
    hcs: "#9c113f",
    fleet: { earth: "#2a78d6", psp: "#e4622d", solo: "#2b9c6f", sta: "#b87f1d", bepi: "#d26790", l1: "#008300", stb: "#6250d6" },
    // protan/deutan dE 25.0, normal 33.1, both >= 3:1 against bg.
    chart: { a: "#2a78d6", b: "#e4622d" },
  },
};

// Surface B_r: a diverging map shared by both themes, so the Sun reads the
// same in either. Gold (outward) and cerulean (inward) poles at equal OKLab
// lightness around a cool silver midpoint, interpolated in OKLab. It is
// lighter and less saturated than the line colours so lines stay visible
// where they cross a region of their own polarity.
const POLE_L = 0.62, POLE_C = 0.13, MID = [0.93, 0.006, 250];
function oklchToLab(L, C, h) { return [L, C * Math.cos(h * Math.PI / 180), C * Math.sin(h * Math.PI / 180)]; }
function labToSrgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
    .map((v) => { v = Math.min(1, Math.max(0, v)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)); });
}
export function divergingLUT(n = 256) {
  const neg = oklchToLab(POLE_L, POLE_C, 225), pos = oklchToLab(POLE_L, POLE_C, 75), mid = oklchToLab(...MID);
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    // A gentle response curve so the weak network field still shows colour.
    const s = (i / (n - 1)) * 2 - 1, t = Math.pow(Math.abs(s), 0.75), end = s < 0 ? neg : pos;
    const rgb = labToSrgb(mid.map((v, k) => v + t * (end[k] - v)));
    out.set([...rgb, 255], i * 4);
  }
  return out;
}
export const css = (n) => `rgb(${n.join(",")})`;
export const lutColor = (lut, s) => { const i = Math.round(((s + 1) / 2) * 255) * 4; return css([lut[i], lut[i + 1], lut[i + 2]]); };

export function currentTheme() { return document.documentElement.dataset.theme === "light" ? "light" : "dark"; }
