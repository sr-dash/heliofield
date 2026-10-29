// HelioField: the coronal magnetic field in 3D.
// Every position is in the Carrington frame (z = solar rotation axis,
// x = Carrington longitude 0), in solar radii, so the scene uses that frame
// directly with z up. A "product" is one date's field: either a daily product
// from data/<date>/ or one computed in the browser from an HMI rotation map.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { THEMES, divergingLUT, lutColor, currentTheme } from "./theme.js";
import { historyIndex, rotationFor, sourceUrl, fleetFor, compute, cancel, unflatten, exportResults } from "./history.js";
import { compose, savePNG, savePDF } from "./snapshot.js";

const RSUN_KM = 695700, AU_RS = 149597870.7 / RSUN_KM;
const OMEGA = 2 * Math.PI / (25.38 * 86400);          // Carrington sidereal [rad/s]
const DEG = Math.PI / 180;
const L1 = ["soho", "ace", "wind", "dscovr", "aditya", "imap", "swfo"];
const VSW = [300, 400, 500, 600, 700, 800];

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const params = new URLSearchParams(location.search);
const EMBED = root.classList.contains("embed");
const state = {
  dates: [], day: null, product: null,
  vsw: 400, rmaxAu: 1.2, logScale: true, rss: 2.5, nLines: 250, extMode: "spiral",
  connMode: "fixed",
  rssWant: 2.5,   // source surface for dates computed in the browser
  routWant: 0,    // outer edge of the SCS model [R_sun], 0 for PFSS alone
  rIn: 2.5,       // PFSS outer boundary drawn (cusp surface with SCS)
  rTop: 2.5,      // where the heliosphere starts (source surface, or SCS edge)

};
const T = () => THEMES[currentTheme()];

// ---------------------------------------------------------------- renderer
const stage = $("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
stage.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(T().bg);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
camera.up.set(0, 0, 1);
camera.position.set(9, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 1.3;
controls.maxDistance = 2000;

// WebGL draws ordinary lines one pixel wide whatever the material says, so
// lines with a width use three's screen-space "fat" lines. Their materials
// need the viewport size, kept current here.
const lineMats = new Set();
const WIDTH = { field: 1.6, ext: 1.3, spiral: 2.2, pil: 2.4 };
function resize() {
  const w = innerWidth, h = innerHeight;
  // A hidden tab or a collapsed iframe reports a zero size; an aspect of
  // 0/0 would turn the camera, and the shared link, into NaN.
  if (!w || !h) return;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  for (const m of lineMats) m.resolution.set(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const G = {};
for (const k of ["photo", "foot", "closed", "open", "ext", "ss", "pil", "hcs", "fleet", "spiral", "cloud"]) {
  G[k] = new THREE.Group();
  scene.add(G[k]);
}

// ------------------------------------------------------------- distance
// Log mode keeps the corona at true size and compresses the heliosphere so
// 1 au lands near 25 R_sun; spirals and the sheet are computed in true r and
// mapped afterwards, so their shape in longitude is unchanged. The mapping
// starts with slope 1 at the source surface, so lines that cross it (SCS)
// do not bend there on screen.
const mapR = (r) => {
  if (!state.logScale || r <= state.rss) return r;
  const k = 2.5 * state.rss;
  return state.rss + k * Math.log(1 + (r - state.rss) / k);
};
// The same mapping for a traced point given in true Cartesian R_sun (SCS
// lines run beyond the source surface).
function warp(q) {
  const r = Math.hypot(q[0], q[1], q[2]);
  if (!state.logScale || r <= state.rss) return q;
  const f = mapR(r) / r;
  return [q[0] * f, q[1] * f, q[2] * f];
}
const warpLine = (p) => (Math.hypot(...p[p.length - 1]) > state.rss || Math.hypot(...p[0]) > state.rss ? p.map(warp) : p);
function sph(r, lonDeg, latDeg) {
  const R = mapR(r), lo = lonDeg * DEG, la = latDeg * DEG;
  return new THREE.Vector3(R * Math.cos(la) * Math.cos(lo), R * Math.cos(la) * Math.sin(lo), R * Math.sin(la));
}

// ------------------------------------------------------------- Br shader
// The data texture holds B_r as 0..255 for -scale..+scale; the colour map is
// a 256-entry lookup (theme.js) so both themes share one validated scale.
const LUT_DATA = divergingLUT();
const LUT = new THREE.DataTexture(LUT_DATA, 256, 1, THREE.RGBAFormat);
LUT.minFilter = LUT.magFilter = THREE.LinearFilter;
LUT.needsUpdate = true;
const brShader = (tex, alpha) => new THREE.ShaderMaterial({
  uniforms: { map: { value: tex }, lut: { value: LUT }, alpha: { value: alpha } },
  transparent: alpha < 1, depthWrite: alpha >= 1,
  vertexShader: `
    varying vec3 vPos; varying float vMu;
    void main() {
      vPos = position;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vMu = max(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)), 0.0);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform sampler2D map; uniform sampler2D lut; uniform float alpha;
    varying vec3 vPos; varying float vMu;
    void main() {
      float lon = atan(vPos.y, vPos.x);
      float lat = asin(clamp(vPos.z / length(vPos), -1.0, 1.0));
      float s = texture2D(map, vec2(fract(lon / 6.2831853), lat / 3.1415927 + 0.5)).r;
      vec3 c = texture2D(lut, vec2(s, 0.5)).rgb;
      gl_FragColor = vec4(c * mix(0.55, 1.0, sqrt(vMu)), alpha);
    }`,
});
// Open-field footprints: a three-class texture (0 closed, 128 open inward,
// 255 open outward). Open cells take the open-line colours; closed cells get
// a light veil of the occluder colour so the holes stand out. Colours go in
// as raw sRGB, as the B_r lookup does, so they match the lines exactly.
const rgb = (hex) => new THREE.Vector3(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));
const footShader = (tex, th) => new THREE.ShaderMaterial({
  uniforms: { map: { value: tex }, pos: { value: rgb(th.pos) }, neg: { value: rgb(th.neg) }, veil: { value: rgb(th.occluder) } },
  transparent: true, depthWrite: false,
  vertexShader: `
    varying vec3 vPos;
    void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D map; uniform vec3 pos; uniform vec3 neg; uniform vec3 veil;
    varying vec3 vPos;
    void main() {
      float lon = atan(vPos.y, vPos.x);
      float lat = asin(clamp(vPos.z / length(vPos), -1.0, 1.0));
      float s = texture2D(map, vec2(fract(lon / 6.2831853), lat / 3.1415927 + 0.5)).r;
      gl_FragColor = s > 0.75 ? vec4(pos, 0.9) : s > 0.25 ? vec4(neg, 0.9) : vec4(veil, 0.45);
    }`,
});
const texLoader = new THREE.TextureLoader();
function prepTex(t) {
  t.wrapS = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
const loadTex = (url) => new Promise((ok, bad) => texLoader.load(url, (t) => ok(prepTex(t)), undefined, bad));
// Computed textures arrive south row first, which is a DataTexture's v = 0.
const dataTex = (u8) => prepTex(new THREE.DataTexture(u8, 360, 180, THREE.RedFormat));

// ------------------------------------------------------------- helpers
function clear(g) {
  for (const o of [...g.children]) {
    g.remove(o);
    o.traverse((c) => {
      c.geometry?.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => { lineMats.delete(m); m.dispose(); });
      if (c.isCSS2DObject) c.element.remove();
    });
  }
}
function lineMaterial(width, opacity, extra = {}) {
  const m = new LineMaterial({ linewidth: width, transparent: opacity < 1, opacity, ...extra });
  m.resolution.set(innerWidth, innerHeight);
  lineMats.add(m);
  return m;
}
function segments(polys, colorOf, opacity, width = WIDTH.field) {
  const pos = [], col = [], c = new THREE.Color();
  polys.forEach((p, i) => {
    c.set(colorOf(i));
    for (let k = 0; k + 1 < p.length; k++) {
      pos.push(...p[k], ...p[k + 1]);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  });
  const g = new LineSegmentsGeometry();
  if (!pos.length) return new THREE.Group();
  g.setPositions(pos);
  g.setColors(col);
  return new LineSegments2(g, lineMaterial(width, opacity, { vertexColors: true }));
}
function line(points, color, opacity = 1, width = WIDTH.spiral) {
  const g = new LineGeometry();
  g.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
  return new Line2(g, lineMaterial(width, opacity, { color }));
}
// A fixed shuffle of a day's field lines, so the count control adds and
// removes lines without the rest jumping about, and closed and open lines
// keep their proportions at any count.
function lineOrder(n) {
  const idx = Array.from({ length: n }, (_, i) => i);
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx;
}
function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.beginPath(); g.arc(32, 32, 26, 0, 2 * Math.PI); g.fill();
  return new THREE.CanvasTexture(c);
}
const DOT = dotTexture();
const fleetColor = (key) => T().fleet[key] || T().planet;

// ------------------------------------------------------------- products
async function fetchDaily(day) {
  const base = `data/${day}/`;
  const [meta, buf, brTex, ssTex] = await Promise.all([
    fetch(base + "meta.json").then((r) => r.json()),
    fetch(base + "lines.bin").then((r) => r.arrayBuffer()),
    loadTex(base + "br.png"), loadTex(base + "ss.png"),
  ]);
  const q = new Int16Array(buf), s = 1 / meta.qscale, polys = [];
  let o = 0;
  for (const n of meta.counts) {
    const p = new Array(n);
    for (let k = 0; k < n; k++, o += 3) p[k] = [q[o] * s, q[o + 1] * s, q[o + 2] * s];
    polys.push(p);
  }
  return { day, meta, polys, brTex, ssTex, computed: false };
}

function disposeProduct(p) {
  p?.brTex?.dispose(); p?.ssTex?.dispose(); p?.foot?.tex?.dispose();
}

// Footprints load on demand: the day's own map when the server made one,
// otherwise the rotation map covering the date (as for a computed date).
async function loadFoot(p) {
  if (p.foot) return p.foot;
  const nearest = (t) => { t.magFilter = t.minFilter = THREE.NearestFilter; return t; };
  // The archived footprints are for 2.5 R_sun; at any other height the
  // browser's own open/closed map is used.
  if (p.footTex && (p.meta.model.rss !== DEFAULTS.rss || p.meta.model.rout)) return (p.foot = { tex: nearest(dataTex(p.footTex)), cr: null, browser: true });
  if (!p.computed) {
    try { return (p.foot = { tex: nearest(await loadTex(`data/${p.day}/open.png`)), cr: null }); } catch (e) { /* none for this day */ }
  }
  const cr = p.computed ? p.meta.map_cr : rotationFor(await historyIndex(), p.day).rot.cr;
  return (p.foot = { tex: nearest(await loadTex(`data/history/open/${cr}.png`)), cr });
}
async function buildFoot() {
  clear(G.foot);
  const p = state.product;
  if (!p || !$("lyrFoot").checked) return;
  try {
    const f = await loadFoot(p);
    if (state.product !== p) return;
    clear(G.foot);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.002, 128, 64), footShader(f.tex, T()));
    mesh.renderOrder = 1;
    G.foot.add(mesh);
  } catch (e) {
    $("status").textContent = "No open-field map for this date yet.";
    setTimeout(() => { $("status").textContent = ""; }, 4000);
  }
  if (state.product === p) info();
}

function showProduct(p) {
  if (state.product && state.product !== p && state.product.brTex !== p.brTex) disposeProduct(state.product);
  state.product = p; state.day = p.day; state.rss = p.meta.model.rss;
  state.rIn = p.meta.model.rcp || state.rss; state.rTop = p.meta.model.rout || state.rss;
  rssControl();
  buildSun(); buildHelio(); info();
  $("status").textContent = "";
  $("day").value = p.day;
  $("src").textContent = p.meta.source.short || "GONG";
  $("src").title = p.meta.source.name;
  $("src").classList.toggle("computed", !!p.computed);
  syncUrl(); postState();
  seriesPost({ mark: p.day });
}

function buildSun() {
  const p = state.product, m = p.meta, nf = m.lines.count, kind = m.lines.kind, th = T();
  for (const k of ["photo", "foot", "closed", "open", "ss", "pil"]) clear(G[k]);
  G.photo.add(new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), brShader(p.brTex, 1)));
  // Without the photosphere, keep an occluding Sun so lines behind it hide.
  if (G.photo.userData.dark) scene.remove(G.photo.userData.dark);
  G.photo.userData.dark = new THREE.Mesh(new THREE.SphereGeometry(0.998, 64, 32),
    new THREE.MeshBasicMaterial({ color: th.occluder }));
  scene.add(G.photo.userData.dark);

  buildLines();
  buildFoot();

  const ss = new THREE.Mesh(new THREE.SphereGeometry(state.rIn, 96, 48), brShader(p.ssTex, +$("ssAlpha").value));
  ss.renderOrder = 2;
  G.ss.add(ss);
  for (const h of m.hcs) {
    const pts = [];
    for (let k = 0; k < h.length; k += 2) pts.push(sph(state.rIn * 1.004, h[k], h[k + 1]));
    G.pil.add(line(pts, th.hcs, 1, WIDTH.pil));
  }
  applyVisibility();
}

// Field lines alone, so the count control does not rebuild anything else.
function buildLines() {
  const p = state.product, kind = p.meta.lines.kind, nf = p.meta.lines.count, th = T();
  clear(G.closed); clear(G.open);
  p.order ??= lineOrder(nf);
  const keep = p.order.slice(0, Math.min(state.nLines, nf));
  const closed = [], open = [], openKind = [];
  for (const i of keep) (kind[i] ? (open.push(warpLine(p.polys[i])), openKind.push(kind[i])) : closed.push(p.polys[i]));
  G.closed.add(segments(closed, () => th.closed, 0.85));
  G.open.add(segments(open, (i) => (openKind[i] > 0 ? th.pos : th.neg), 1));
  $("nlOut").textContent = keep.length;
  $("nLines").max = nf;
  buildExt();
}

// Open lines carried beyond the source surface. PFSS makes the field radial
// there, so no further solve is needed: each line's source-surface end is
// continued outward either straight (radial) or as a Parker spiral, where
// plasma moving out at the wind speed v carries the radial field while the
// Sun turns beneath it -- the same continuation as the current sheet and
// the spacecraft spirals, so all three stay consistent.
function buildExt() {
  clear(G.ext);
  const p = state.product;
  if (!p || !$("lyrExt").checked) return applyVisibility();
  const kind = p.meta.lines.kind, nf = p.meta.lines.count, th = T(), v = state.vsw;
  const rOut = Math.max(state.rmaxAu * AU_RS, state.rTop * 1.01), N = 64;
  const wind = state.extMode === "spiral";
  const polys = [], pol = [];
  for (const i of p.order.slice(0, Math.min(state.nLines, nf))) {
    if (!kind[i]) continue;
    const q = p.polys[i], a = q[0], b = q[q.length - 1];
    const e = Math.hypot(...a) > Math.hypot(...b) ? a : b, r0 = Math.hypot(...e);
    // Server-traced lines end at 0.98 R_ss (their seeds), browser-traced
    // ones at R_ss, or at the SCS edge; the field is already all but radial
    // there, so continue from wherever the line ends.
    if (r0 < state.rTop * 0.95) continue;
    const lon0 = Math.atan2(e[1], e[0]) / DEG, lat0 = Math.asin(e[2] / r0) / DEG, pts = [];
    for (let j = 0; j < N; j++) {
      const r = r0 * Math.pow(rOut / r0, j / (N - 1));
      const lon = wind ? lon0 - (OMEGA * Math.max(0, r - state.rTop) * RSUN_KM / v) / DEG : lon0;
      const s = sph(r, lon, lat0);
      pts.push([s.x, s.y, s.z]);
    }
    polys.push(pts); pol.push(kind[i]);
  }
  G.ext.add(segments(polys, (k) => (pol[k] > 0 ? th.pos : th.neg), 0.75, WIDTH.ext));
  applyVisibility();
}

// Fleet entries: L1 monitors collapse into one marker.
function fleetEntries() {
  const f = state.product.meta.fleet, out = [];
  for (const [k, b] of Object.entries(f)) if (!L1.includes(k)) out.push({ key: k, ...b });
  const l1 = L1.filter((k) => f[k]);
  if (l1.length) out.push({ key: "l1", ref: l1[0], ...f[l1[0]], name: `L1 monitors (${l1.length})`, members: l1, planet: false });
  return out;
}

// ------------------------------------------------------------- sources
// Each body's connection is mapped at every speed of meta.vgrid (25 km/s
// steps) on the model source surface (meta.connect, with drawn lines) and on
// the other source surfaces of meta.ensemble (footpoints only). Products
// made before the diagnostics have only the slider speeds and no ensemble.
function sources(m) {
  if (m._src) return m._src;
  const vgrid = m.vgrid || m.vsw, nv = vgrid.length, out = {};
  m.connect.forEach((c, i) => {
    const vi = vgrid.indexOf(c.v);
    if (vi < 0) return;
    const b = (out[c.body] ??= { idx: [], rows: [[]] });
    b.idx[vi] = i;
    b.rows[0][vi] = c.foot ? { foot: c.foot, fs: c.fs, dchb: c.dchb, vwsa: c.vwsa } : null;
    (m.ensemble?.foot || []).forEach((list, k) => {
      const e = list[i];
      (b.rows[k + 1] ??= [])[vi] = e ? { foot: e.slice(0, 2), fs: e[2], dchb: e[3], vwsa: e[4] } : null;
    });
  });
  m._src = { vgrid, nv, body: out, diag: m.connect.some((c) => c.vwsa != null) };
  return m._src;
}
const snap = (vgrid, v) => vgrid.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

// The speed a body's connection is drawn at. Fixed: the slider. Self-
// consistent: start at the slider speed, map to the footpoint, take the WSA
// speed there, and repeat until the speed (to the 25 km/s grid) stops
// changing. A cycle between two footpoints is reported as unconverged and
// settles on the member whose own WSA speed is closest to it.
function speedFor(key) {
  const S = sources(state.product.meta), b = S.body[key], v0 = state.vsw;
  if (state.connMode !== "sc" || !S.diag || !b) return { v: v0, ok: true };
  let v = v0;
  const seen = [];
  for (let k = 0; k < 30; k++) {
    const e = b.rows[0][S.vgrid.indexOf(v)];
    if (!e) return { v, ok: false };
    const next = snap(S.vgrid, e.vwsa);
    if (next === v) return { v, ok: true };
    const j = seen.indexOf(next);
    if (j >= 0) {
      const cyc = seen.slice(j).concat(v);
      const best = cyc.reduce((a, c) => {
        const d = (x) => Math.abs(b.rows[0][S.vgrid.indexOf(x)].vwsa - x);
        return d(c) < d(a) ? c : a;
      });
      return { v: best, ok: false };
    }
    seen.push(v);
    v = next;
  }
  return { v, ok: false };
}

// Footpoints over wind speed v +- 100 km/s and every source surface.
function spread(key, v) {
  const S = sources(state.product.meta), b = S.body[key], out = [];
  if (!b) return out;
  b.rows.forEach((row) => S.vgrid.forEach((vv, i) => { if (Math.abs(vv - v) <= 100 && row[i]) out.push(row[i]); }));
  return out;
}

function buildCloud() {
  clear(G.cloud);
  const p = state.product;
  if (!p || !$("lyrCloud").checked) return;
  for (const b of fleetEntries()) {
    if (b.planet) continue;
    const key = b.ref || b.key, pts = spread(key, speedFor(key).v);
    if (!pts.length) continue;
    const pos = pts.flatMap((e) => { const q = sph(1.004, e.foot[0], e.foot[1]); return [q.x, q.y, q.z]; });
    // Each dot sits on a slightly larger one in the background colour, so it
    // stays visible over surface field of a similar hue.
    for (const [color, size, order] of [[T().bg, 11, 4], [fleetColor(b.key), 8, 5]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const pt = new THREE.Points(g, new THREE.PointsMaterial({ map: DOT, color, size,
        sizeAttenuation: false, transparent: true, alphaTest: 0.3, depthWrite: false }));
      pt.renderOrder = order;
      G.cloud.add(pt);
    }
  }
}

function buildHelio() {
  for (const k of ["hcs", "fleet", "spiral"]) clear(G[k]);
  const p = state.product, m = p.meta, v = state.vsw, th = T();

  // Heliospheric current sheet: the source-surface neutral line carried
  // outward radially and wound back by rotation at speed v. With SCS, the
  // sheet first follows the traced ribs from the cusp surface to the SCS
  // edge, and is wound up beyond that.
  const rOut = Math.max(state.rmaxAu * AU_RS, state.rTop * 1.01), NR = 90;
  const radii = Array.from({ length: NR }, (_, j) => state.rTop * Math.pow(rOut / state.rTop, j / (NR - 1)));
  const wound = (lon, lat) => radii.map((r) => sph(r, lon - (OMEGA * (r - state.rTop) * RSUN_KM / v) / DEG, lat));
  const sheets = m.hcs_ribs
    ? m.hcs_ribs.map((ribs) => ribs.map((rib) => {
      const inner = [];
      for (let k = 0; k < rib.length - 3; k += 3) inner.push(sph(rib[k + 2], rib[k], rib[k + 1]));
      return inner.concat(wound(rib[rib.length - 3], rib[rib.length - 2]));
    }))
    : m.hcs.map((h) => {
      const n = h.length / 2, step = Math.max(1, Math.floor(n / 260)), cols = [];
      for (let i = 0; i < n; i += step) cols.push(wound(h[2 * i], h[2 * i + 1]));
      if ((n - 1) % step) cols.push(wound(h[2 * n - 2], h[2 * n - 1]));
      return cols;
    });
  for (const cols of sheets) {
    if (cols.length < 2) continue;
    const H = cols[0].length, pos = [], tri = [];
    for (const col of cols) for (const q of col) pos.push(q.x, q.y, q.z);
    for (let a = 0; a + 1 < cols.length; a++) for (let j = 0; j + 1 < H; j++) {
      const s0 = a * H + j, s1 = (a + 1) * H + j;
      tri.push(s0, s1, s0 + 1, s0 + 1, s1, s1 + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(tri);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: th.hcs, transparent: true, opacity: currentTheme() === "light" ? 0.08 : 0.1, side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.renderOrder = 3;
    G.hcs.add(mesh);
  }

  // Bodies and their magnetic connection.
  const nf = m.lines.count, labelled = [];
  for (const b of fleetEntries()) {
    const color = b.planet ? th.planet : fleetColor(b.key), rRs = b.r * AU_RS;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: DOT, color, sizeAttenuation: false, depthTest: false }));
    sp.scale.setScalar(b.planet ? 0.012 : 0.018);
    sp.position.copy(sph(rRs, b.lon, b.lat));
    sp.renderOrder = 5;
    G.fleet.add(sp);
    // Bodies sitting together (Earth and L1, Mercury and BepiColombo) share
    // one label; spacecraft names lead.
    const near = labelled.find((o) => o.pos.distanceTo(sp.position) < 0.02 * o.pos.length() + 0.05);
    if (near) {
      near.names[b.planet ? "push" : "unshift"](b.name);
      if (!b.planet) near.colors.unshift(color);
    } else {
      labelled.push({ pos: sp.position, sprite: sp, names: [b.name], colors: b.planet ? [] : [color] });
    }
    if (b.planet) continue;

    const vb = speedFor(b.ref || b.key).v;
    const ci = m.connect.findIndex((c) => c.body === (b.ref || b.key) && c.v === vb);
    if (ci < 0) continue;
    const c = m.connect[ci], pts = [];
    for (let j = 0; j <= 160; j++) {
      const r = state.rTop * Math.pow(rRs / state.rTop, j / 160);
      pts.push(sph(r, c.ss[0] - (OMEGA * (r - state.rTop) * RSUN_KM / vb) / DEG, c.ss[1]));
    }
    G.spiral.add(line(pts, color, 0.95));
    const cor = p.polys[nf + ci];
    if (cor?.length > 1) G.spiral.add(line(warpLine(cor).map((q) => new THREE.Vector3(...q)), color));
  }
  // Labels wear text colours; the marker colour sits in a dot beside them.
  for (const o of labelled) {
    const el = document.createElement("div");
    el.className = "label" + (o.colors.length ? "" : " planet");
    el.textContent = o.names.join(" · ");
    if (o.colors.length) { el.style.setProperty("--dot", o.colors[0]); el.dataset.color = o.colors[0]; }
    o.sprite.add(new CSS2DObject(el));
  }
  buildExt();
  buildCloud();
  feet();
}

// ------------------------------------------------------------- theme
function paintLegend() {
  const th = T();
  for (const [k, c] of Object.entries({ pos: th.pos, neg: th.neg, closed: th.closed, hcs: th.hcs })) root.style.setProperty(`--line-${k}`, c);
  root.style.setProperty("--surf-pos", lutColor(LUT_DATA, 1));
  root.style.setProperty("--surf-neg", lutColor(LUT_DATA, -1));
  root.style.setProperty("--surf-mid", lutColor(LUT_DATA, 0));
}
function setTheme(name, remember = true) {
  root.dataset.theme = name;
  if (remember && !params.has("theme")) try { localStorage.setItem("hf.theme", name); } catch (e) {}
  const btn = $("themeToggle");
  btn.setAttribute("aria-label", name === "dark" ? "Switch to light theme" : "Switch to dark theme");
  btn.title = btn.getAttribute("aria-label") + " (T)";
  btn.dataset.theme = name;
  scene.background.set(T().bg);
  paintLegend();
  if (state.product) { buildSun(); buildHelio(); }
  seriesPost({ theme: name });
  syncUrl();
}
$("themeToggle").onclick = () => setTheme(currentTheme() === "dark" ? "light" : "dark");

// ------------------------------------------------------------- solar cycle
// The series page's compact embed, floating at the left. It marks the date
// shown here, follows the theme, and a click on a rotation opens that date.
// On by default on wide screens; ?series=0|1 forces it; C toggles it.
let seriesReady = false;
function seriesPost(msg) {
  const f = $("seriesFrame");
  if (seriesReady && f.contentWindow) f.contentWindow.postMessage({ type: "heliofield-series:set", ...msg }, "*");
}
function setSeries(on, remember = true) {
  $("seriesPanel").hidden = !on;
  $("seriesToggle").checked = on;
  if (on && !$("seriesFrame").getAttribute("src")) {
    seriesReady = false;
    $("seriesFrame").src = `series.html?embed=1&compact=1&theme=${currentTheme()}${state.day ? `&mark=${state.day}` : ""}`;
  }
  if (remember && !EMBED) try { localStorage.setItem("hf.series", on ? "on" : "off"); } catch (e) {}
}
$("seriesToggle").addEventListener("change", (e) => setSeries(e.target.checked));
$("spClose").onclick = () => setSeries(false);
addEventListener("message", (e) => {
  if (e.source !== $("seriesFrame").contentWindow) return;   // only our own panel
  const d = e.data;
  if (d?.type === "heliofield-series:ready") { seriesReady = true; seriesPost({ mark: state.day, theme: currentTheme() }); }
  else if (d?.type === "heliofield-series:pick" && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) openDate(d.date);
});

// ------------------------------------------------------------- panel
const DEFAULTS = { v: 400, rmax: 1.2, ss: 0.25, lines: 250, rss: 2.5, rout: 21.5 };
const ROUTS = [5, 10, 21.5];
const LAYERS = { photo: "lyrPhoto", foot: "lyrFoot", closed: "lyrClosed", open: "lyrOpen", ext: "lyrExt", ss: "lyrSS",
  pil: "lyrPIL", hcs: "lyrHCS", fleet: "lyrFleet", spiral: "lyrSpiral", cloud: "lyrCloud" };
// Layers shown on a first visit; links list layers only when they differ.
const DEFAULT_ON = ["photo", "closed", "open", "pil", "fleet", "spiral"];

function applyVisibility() {
  for (const [g, id] of Object.entries(LAYERS)) G[g].visible = $(id).checked;
  if (G.photo.userData.dark) G.photo.userData.dark.visible = !G.photo.visible;
  // Spirals start at the spacecraft, so they go when the fleet goes; their
  // own switch is a sub-option, disabled meanwhile.
  G.spiral.visible = G.fleet.visible && $("lyrSpiral").checked;
  $("lyrSpiral").disabled = !G.fleet.visible;
  G.cloud.visible = G.fleet.visible && $("lyrCloud").checked;
  $("lyrCloud").disabled = !G.fleet.visible;
  // Extensions belong to the open lines in the same way.
  G.ext.visible = G.open.visible && $("lyrExt").checked;
  $("lyrExt").disabled = !G.open.visible;
  for (const b of $("extMode").querySelectorAll("button")) b.disabled = !G.ext.visible;
  // The label renderer reads each label's own visible flag every frame and
  // ignores its parents', so the flag has to be set on the labels themselves.
  G.fleet.traverse((o) => { if (o.isCSS2DObject) o.visible = G.fleet.visible; });
}
function setLayers(list) {
  const on = new Set(String(list).split(",").map((s) => s.trim()));
  for (const [g, id] of Object.entries(LAYERS)) $(id).checked = on.has(g);
  if (state.product) { buildExt(); buildCloud(); buildFoot(); } else applyVisibility();
}
for (const id of Object.values(LAYERS)) $(id).addEventListener("change", () => { applyVisibility(); syncUrl(); });
$("lyrExt").addEventListener("change", () => { if (state.product) buildExt(); });
$("lyrFoot").addEventListener("change", () => { if (state.product) buildFoot(); });
$("lyrCloud").addEventListener("change", () => { if (state.product) buildCloud(); });
function setConnMode(mode) {
  state.connMode = mode === "sc" ? "sc" : "fixed";
  for (const [id, on] of [["connFixed", state.connMode === "fixed"], ["connSC", state.connMode === "sc"]]) {
    $(id).classList.toggle("on", on); $(id).setAttribute("aria-pressed", on);
  }
  if (state.product) buildHelio();
}
$("connFixed").onclick = () => { setConnMode("fixed"); syncUrl(); postState(); };
$("connSC").onclick = () => { setConnMode("sc"); syncUrl(); postState(); };
function setExtMode(mode) {
  state.extMode = mode === "radial" ? "radial" : "spiral";
  for (const [id, on] of [["extSpiral", state.extMode === "spiral"], ["extRadial", state.extMode === "radial"]]) {
    $(id).classList.toggle("on", on); $(id).setAttribute("aria-pressed", on);
  }
  if (state.product) buildExt();
}
$("extSpiral").onclick = () => { setExtMode("spiral"); syncUrl(); };
$("extRadial").onclick = () => { setExtMode("radial"); syncUrl(); };

function setAlpha(a) {
  $("ssAlpha").value = a;
  G.ss.children.forEach((m) => { m.material.uniforms.alpha.value = +a; });
}
$("ssAlpha").addEventListener("input", (e) => { setAlpha(e.target.value); syncUrl(); });
function setNLines(n) {
  state.nLines = n; $("nLines").value = n;
  if (state.product) buildLines(); else $("nlOut").textContent = n;
}
$("nLines").addEventListener("input", (e) => { setNLines(+e.target.value); });
$("nLines").addEventListener("change", () => syncUrl());
function setV(v) {
  state.vsw = v; $("vsw").value = v; $("vOut").textContent = v;
  if (state.product) buildHelio();
}
$("vsw").addEventListener("input", (e) => { setV(+e.target.value); syncUrl(); postState(); });
function setRmax(r) {
  state.rmaxAu = r; $("rmax").value = r; $("rOut").textContent = r.toFixed(1);
  if (state.product) buildHelio();
}
$("rmax").addEventListener("input", (e) => { setRmax(+e.target.value); syncUrl(); });
// Source-surface height. Only a date computed in the browser can be
// re-solved; daily products are solved on the server at 2.5 R_sun. The
// value is kept for the next computed date either way.
const RSS_MIN = 1.5, RSS_MAX = 3.5;
function rssControl() {
  const daily = !!state.product && !state.product.computed;
  const rout = daily ? 0 : state.routWant;
  for (const [id, on] of [["modelPfss", !rout], ["modelScs", !!rout]]) {
    $(id).classList.toggle("on", on); $(id).setAttribute("aria-pressed", on); $(id).disabled = daily;
  }
  $("routSeg").hidden = !rout;
  for (const b of $("routSeg").querySelectorAll("button")) {
    const on = +b.dataset.rout === rout;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
  }
  $("rss").disabled = daily;
  const r = daily ? state.rss : state.rssWant;
  $("rss").value = r; $("rssOut").textContent = r.toFixed(1);
  $("rssNote").innerHTML = daily
    ? `This daily product is PFSS at 2.5 R<sub>☉</sub>, solved on the server. Pick a date with the HMI badge to change the model. <a href="guide.html#model">More</a>`
    : rout
      ? `PFSS to the cusp surface at ${(0.92 * state.rssWant).toFixed(2)} R<sub>☉</sub>, then the current-sheet model to ${rout} R<sub>☉</sub>. Changes re-solve this rotation in your browser. <a href="guide.html#scs">More</a>`
      : `Changes re-solve this rotation in your browser. <a href="guide.html#rss">What the height changes</a>`;
}
// The coronal model for computed dates: PFSS alone (rout 0) or coupled to
// the Schatten current-sheet model out to rout.
async function setModel(rout) {
  state.routWant = ROUTS.includes(+rout) ? +rout : 0;
  rssControl();
  if (state.product?.computed && (state.product.meta.model.rout || 0) !== state.routWant) await openDate(state.day, { ask: false });
  else { syncUrl(); postState(); }
}
$("modelPfss").onclick = () => setModel(0);
$("modelScs").onclick = () => setModel(state.routWant || DEFAULTS.rout);
for (const b of $("routSeg").querySelectorAll("button")) b.onclick = () => setModel(+b.dataset.rout);
async function setRss(r) {
  r = +Math.min(RSS_MAX, Math.max(RSS_MIN, r)).toFixed(1);
  state.rssWant = r; rssControl();
  if (state.product?.computed && state.product.meta.model.rss !== r) await openDate(state.day, { ask: false });
}
$("rss").addEventListener("input", (e) => { $("rssOut").textContent = (+e.target.value).toFixed(1); });
$("rss").addEventListener("change", (e) => { setRss(+e.target.value); });
function setScale(log) {
  state.logScale = log;
  for (const [id, on] of [["scaleLog", log], ["scaleTrue", !log]]) {
    $(id).classList.toggle("on", on); $(id).setAttribute("aria-pressed", on);
  }
  if (state.product) { buildLines(); buildHelio(); }
}
$("scaleLog").onclick = () => { setScale(true); syncUrl(); };
$("scaleTrue").onclick = () => { setScale(false); syncUrl(); };

function info() {
  const m = state.product.meta, src = m.source;
  const flux = (m.open_flux_Mx / 1e22).toFixed(2);
  const rows = [
    ["Field for", state.product.computed ? `${state.day} (12:00 UTC)` : m.obstime.replace("T", " ").replace("Z", " UTC")],
    ["Magnetogram", `<a href="${src.url}" title="${src.file}">${src.name}</a>`],
  ];
  if (state.product.computed) rows.push(["Map covers", `${m.map_start.slice(0, 10)} – ${m.map_stop.slice(0, 10)}`]);
  rows.push(
    ["Carrington rotation", m.carrington_rotation],
    ["Earth L<sub>0</sub>, B<sub>0</sub>", `${m.L0.toFixed(1)}°, ${m.B0.toFixed(1)}°`],
    ...(m.model.rout
      ? [["Model", "PFSS + Schatten current sheet"], ["Cusp surface", `${m.model.rcp.toFixed(2)} R<sub>☉</sub> (PFSS to ${state.rss.toFixed(1)})`],
        ["SCS out to", `${m.model.rout} R<sub>☉</sub>`]]
      : [["Model", "PFSS"], ["Source surface", `${state.rss.toFixed(1)} R<sub>☉</sub>`]]),
    ...(m.model.taper_l0 ? [["Map smoothing", `harmonics to degree ${m.model.lmax}, Gaussian taper (FWHM 3.8°) <a href="guide.html#smoothing">?</a>`]] : []),
    ["Open flux", `${flux} × 10<sup>22</sup> Mx`],
    ...(state.product.foot && $("lyrFoot").checked
      ? [["Footprints from", state.product.foot.browser ? "this solution"
        : state.product.foot.cr ? `rotation map CR ${state.product.foot.cr}` : "this map"]] : []),
    ["Field lines", m.lines.count],
    ["Computed", state.product.computed ? "in your browser" : "daily, on the server"],
  );
  $("info").innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`
    + (state.product.computed && !m.exact ? `<p class="note warn">No rotation map covers this date, so the nearest one (CR ${m.map_cr}) is used.</p>` : "");
}
function feet() {
  const m = state.product.meta, S = sources(m), sc = state.connMode === "sc";
  const num = (x, d = 0) => (x == null ? "–" : x.toFixed(d));
  const fsTxt = (x) => (x == null ? "–" : x < 10 ? x.toFixed(1) : x.toFixed(0));
  const rows = fleetEntries().filter((b) => !b.planet).map((b) => {
    const key = b.ref || b.key, sp = speedFor(key), vi = S.vgrid.indexOf(sp.v);
    const e = S.body[key]?.rows[0][vi], f = e?.foot;
    // Spread over +-100 km/s and the source surfaces, in the row's tooltip.
    const ens = S.diag ? spread(key, sp.v) : [];
    let tip = `${b.name}, ${b.r.toFixed(2)} au, mapped at ${sp.v} km/s`;
    if (ens.length > 1 && f) {
      const u = (q) => [Math.cos(q[1] * DEG) * Math.cos(q[0] * DEG), Math.cos(q[1] * DEG) * Math.sin(q[0] * DEG), Math.sin(q[1] * DEG)];
      const c = u(f), far = Math.max(...ens.map((x) => { const w = u(x.foot); return Math.acos(Math.min(1, c[0] * w[0] + c[1] * w[1] + c[2] * w[2])) / DEG; }));
      const vs = ens.map((x) => x.vwsa);
      tip += `. Over ${Math.max(S.vgrid[0], sp.v - 100)}–${Math.min(S.vgrid[S.nv - 1], sp.v + 100)} km/s and source surfaces ${[state.rss, ...(m.ensemble?.rss || [])].sort((a, b) => a - b).map((r) => r.toFixed(1)).join(", ")} R☉: `
        + `footpoints within ${far.toFixed(0)}°, estimated speed ${Math.min(...vs).toFixed(0)}–${Math.max(...vs).toFixed(0)} km/s`;
    }
    const flag = sc && !sp.ok ? "*" : "";
    return `<tr title="${tip}"><td><span class="dot" style="background:${fleetColor(b.key)}"></span>${b.name}<small>${b.r.toFixed(2)} au${sc ? ` · ${sp.v} km/s` : ""}</small></td>
      <td>${f ? f[0].toFixed(0) + "°" : "–"}</td><td>${f ? f[1].toFixed(0) + "°" : "–"}</td>
      <td>${fsTxt(e?.fs)}</td><td>${e?.dchb == null ? "–" : num(e.dchb, 1) + "°"}</td><td>${num(e?.vwsa)}${flag}</td></tr>`;
  }).join("");
  const how = sc ? `each body's own self-consistent speed, iterated from ${state.vsw} km/s`
    : `${state.vsw} km/s wind`;
  $("feet").innerHTML = `<p class="note">Carrington longitude and latitude where each body's field line
    meets the photosphere, for ${how}; the expansion factor <i>f</i><sub>s</sub>, the distance to the
    coronal-hole boundary, and the WSA-type speed estimate there (illustrative coefficients).
    Hover a row for the spread.</p>
    <table><tr><th></th><th>Lon</th><th>Lat</th><th title="Expansion factor">f<sub>s</sub></th><th title="Distance to the coronal-hole boundary">DCHB</th><th title="Estimated wind speed [km/s]">v</th></tr>${rows}</table>`
    + (S.diag ? "" : `<p class="note">This product was made before the source diagnostics.</p>`)
    + (sc && /\*/.test(rows) ? `<p class="note">* The iteration did not settle: the footpoint jumps between sources.</p>` : "");
}

// The menu: a dropdown under the hamburger button. Remembered on wide
// screens; ?panel=0|1 forces it; L and Escape work from the keyboard.
const narrow = matchMedia("(max-width: 760px)");
function setPanel(open) {
  root.classList.toggle("panel-closed", !open);
  $("menuBtn").setAttribute("aria-expanded", open);
  $("menuBtn").setAttribute("aria-label", open ? "Close the menu" : "Open the menu");
  if (!EMBED && !narrow.matches) try { localStorage.setItem("hf.panel", open ? "open" : "closed"); } catch (e) {}
}
setPanel(!root.classList.contains("panel-closed"));
$("menuBtn").onclick = () => setPanel(root.classList.contains("panel-closed"));
// The menu sits just below (or, in an embed, above) the bar, whose height
// changes when it wraps on a phone.
const bar = document.querySelector(".bar");
const barHeight = () => root.style.setProperty("--bar-h", bar.offsetHeight + "px");
new ResizeObserver(barHeight).observe(bar);
barHeight();
// The legend wraps on phones; the reset button sits just above it.
const legend = $("legend");
new ResizeObserver(() => root.style.setProperty("--legend-h", legend.offsetHeight + "px")).observe(legend);

// ------------------------------------------------------------- views
let tween = null, view = null;
function flyTo(pos, instant) {
  // Aim at once: otherwise the camera only turns to the Sun on the next
  // animation frame, which a background tab may not run before a snapshot.
  if (instant) { camera.position.copy(pos); controls.target.set(0, 0, 0); controls.update(); return; }
  const from = camera.position.clone(), t0 = performance.now();
  tween = (now) => {
    const t = Math.min((now - t0) / 700, 1), e = t * t * (3 - 2 * t);
    camera.position.lerpVectors(from, pos, e);
    controls.target.multiplyScalar(1 - e);
    if (t === 1) tween = null;
  };
}
const dir = (lon, lat, d) => new THREE.Vector3(
  d * Math.cos(lat * DEG) * Math.cos(lon * DEG), d * Math.cos(lat * DEG) * Math.sin(lon * DEG), d * Math.sin(lat * DEG));
// Back off on portrait screens so the source surface still fits across.
const near = () => 9 / Math.min(1, (camera.aspect || 1) * 1.6);
const VIEWS = {
  earth: () => dir(state.product.meta.L0, state.product.meta.B0, near()),
  north: () => dir(state.product.meta.L0 + 180, 89.5, near() * 1.2),
  fleet: () => {
    const far = Math.max(...Object.values(state.product.meta.fleet).map((b) => mapR(b.r * AU_RS)));
    return dir(state.product.meta.L0 + 200, 55, far / Math.tan(17.5 * DEG) * 1.15);
  },
};
// The opening view, which Reset view returns to: from Earth's side, a little
// ahead in longitude and above the ecliptic.
const home = () => dir(state.product.meta.L0 - 35, state.product.meta.B0 + 20, near());
function resetView() {
  if (!state.product) return;
  view = null;
  flyTo(home());
}
$("resetView").onclick = resetView;
// Named views follow the date (Earth moves); anything else is a fixed
// Carrington camera, which a shared link reproduces with ?cam=lon,lat,dist.
function setView(name, instant) {
  if (!VIEWS[name] || !state.product) return;
  view = name;
  flyTo(VIEWS[name](), instant);
  syncUrl();
}
$("viewEarth").onclick = () => setView("earth");
$("viewNorth").onclick = () => setView("north");
$("viewFleet").onclick = () => setView("fleet");
controls.addEventListener("start", () => { view = null; tween = null; });
// Record the camera once it has settled: with damping the view keeps gliding
// after the pointer is released, so the release moment is not where it stops.
let settle = null;
controls.addEventListener("change", () => { clearTimeout(settle); settle = setTimeout(syncUrl, 250); });
function camParam() {
  const p = camera.position, r = p.length();
  return [((Math.atan2(p.y, p.x) / DEG) + 360) % 360, Math.asin(p.z / r) / DEG, r].map((x) => x.toFixed(1)).join(",");
}
function setSpin(on) { $("spin").checked = on; controls.autoRotate = on; }
controls.autoRotateSpeed = 0.5;
$("spin").addEventListener("change", (e) => { setSpin(e.target.checked); syncUrl(); });

// ------------------------------------------------------------- URL state
function stateParams() {
  const p = new URLSearchParams({ date: state.day });
  if (state.vsw !== DEFAULTS.v) p.set("v", state.vsw);
  const on = Object.keys(LAYERS).filter((g) => $(LAYERS[g]).checked);
  if (on.length !== DEFAULT_ON.length || on.some((g) => !DEFAULT_ON.includes(g))) p.set("layers", on.join(","));
  if (state.extMode === "radial") p.set("ext", "radial");
  if (state.connMode === "sc") p.set("conn", "sc");
  if (state.rmaxAu !== DEFAULTS.rmax) p.set("rmax", state.rmaxAu);
  if (!state.logScale) p.set("scale", "true");
  if (+$("ssAlpha").value !== DEFAULTS.ss) p.set("ss", $("ssAlpha").value);
  if (state.nLines !== DEFAULTS.lines) p.set("lines", state.nLines);
  if (state.product?.computed && state.rssWant !== DEFAULTS.rss) p.set("rss", state.rssWant);
  if (state.product?.computed && state.routWant) p.set("scs", state.routWant);
  if (view) p.set("view", view); else p.set("cam", camParam());
  if (controls.autoRotate) p.set("rotate", "1");
  return p;
}
const base = () => location.origin + location.pathname.replace(/index\.html$/, "");
function syncUrl() {
  if (!state.day) return;
  const p = stateParams();
  $("embedOpen").href = base() + "?" + p;
  for (const k of ["embed", "controls", "panel", "series"]) if (params.has(k)) p.set(k, params.get(k));
  if (params.has("theme")) p.set("theme", currentTheme());     // a linked theme follows later switches
  history.replaceState(null, "", "?" + p);
}

async function share(text, btn) {
  const out = $("shareOut");
  out.hidden = false; out.value = text; out.select();
  try { await navigator.clipboard.writeText(text); } catch (e) { return; }
  flash(btn, "Copied");
}
function flash(btn, text) {
  const label = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = label; }, 1400);
}
$("copyLink").onclick = (e) => share(base() + "?" + stateParams(), e.target);
$("copyEmbed").onclick = (e) => {
  const p = stateParams(); p.set("embed", "1");
  share(`<iframe src="${base()}?${p}" title="HelioField: the Sun's coronal magnetic field in 3D" ` +
    `width="100%" height="560" style="border:0;border-radius:12px" loading="lazy" allowfullscreen></iframe>`, e.target);
};

// ------------------------------------------------------------- snapshots
// Where the saved view looks from: the camera's Carrington longitude and
// latitude seen from Sun centre and its Stonyhurst longitude (angle from the
// Earth view). A distance is given only at true scale: in log-distance mode
// the camera is not on the compressed scale, only the objects are.
const VIEW_NAMES = { earth: "From Earth", north: "From north", fleet: "Whole fleet" };
function viewCaption() {
  const p = camera.position, d = p.length(), m = state.product.meta;
  const lon = ((Math.atan2(p.y, p.x) / DEG) + 360) % 360, lat = Math.asin(p.z / d) / DEG;
  const ston = ((lon - m.L0 + 540) % 360) - 180;
  const dist = state.logScale ? "log distance scale"
    : `${d < 100 ? `${d.toFixed(1)} R☉` : `${(d / AU_RS).toFixed(2)} au`} from Sun centre`;
  const sgn = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1) + "°";
  return `View: ${VIEW_NAMES[view] || "Custom view"} · from Carrington longitude ${lon.toFixed(1)}°, latitude ${sgn(lat)} `
    + `(Stonyhurst longitude ${sgn(ston)}) · ${dist}`;
}
function snapshotCanvas() {
  // Bring the camera and the label layer up to date first: right after a
  // load or a jump, no animation frame may have placed the labels yet.
  controls.update();
  labels.render(scene, camera);
  const m = state.product.meta, th = T(), cs = getComputedStyle(root);
  const legend = [
    { label: "Br > 0", color: lutColor(LUT_DATA, 1), kind: "swatch" },
    { label: "Br < 0", color: lutColor(LUT_DATA, -1), kind: "swatch" },
    { label: "open +", color: th.pos }, { label: "open −", color: th.neg },
    { label: "closed", color: th.closed }, { label: "current sheet", color: th.hcs },
  ];
  return compose({
    renderer, scene, camera, stage, legend,
    title: `HelioField · ${state.day}`,
    lines: [
      `${m.source.name}${state.product.computed ? ` (CR ${m.map_cr})` : ""} · ${m.model.rout ? `PFSS + SCS, cusp ${m.model.rcp.toFixed(2)} R☉, to ${m.model.rout} R☉` : `PFSS, source surface ${state.rss.toFixed(1)} R☉`} · ${state.connMode === "sc" ? `self-consistent WSA-type wind (from ${state.vsw} km/s)` : `solar wind ${state.vsw} km/s`} · open flux ${(m.open_flux_Mx / 1e22).toFixed(2)} × 10²² Mx`,
      viewCaption(),
      `Earth: L0 ${m.L0.toFixed(1)}°, B0 ${m.B0.toFixed(1)}° (Carrington longitude and latitude of the Sun–Earth line)`,
    ],
    ink: { bg: th.bg, text: cs.getPropertyValue("--text").trim(), muted: cs.getPropertyValue("--muted").trim(),
      labelBg: cs.getPropertyValue("--label-bg").trim() },
  });
}
const fileBase = () => `heliofield_${state.day}_${state.vsw}kms`;
$("savePNG").onclick = async (e) => {
  if (!state.product) return;
  try { await savePNG(snapshotCanvas(), fileBase()); flash(e.target, "Saved"); }
  catch (err) { $("status").textContent = err.message; }
};
$("savePDF").onclick = async (e) => {
  if (!state.product) return;
  e.target.disabled = true;
  try { await savePDF(snapshotCanvas(), fileBase(), `HelioField ${state.day}`); flash(e.target, "Saved"); }
  catch (err) { $("status").textContent = err.message; setTimeout(() => { $("status").textContent = ""; }, 4000); }
  finally { e.target.disabled = false; }
};

// ------------------------------------------------------------- download
// The results of a date computed in the browser, zipped with Python scripts
// that plot them (and, for the surface maps, recompute the 3D field). The
// model is the one asked for: the view switches to it first if needed.
// The browser's own calendar date, for the "saved" stamp in file names.
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const KIND_ROUT = (kind) => (kind === "scs" ? state.routWant || DEFAULTS.rout : kind === "pfss" ? 0 : null);
function dlNote() {
  const p = state.product, kind = document.querySelector('input[name="dlKind"]:checked')?.value;
  if (!p?.computed) { $("dlNote").textContent = ""; return; }
  const want = KIND_ROUT(kind), now = p.meta.model.rout || 0;
  $("dlRout").textContent = state.routWant || DEFAULTS.rout;
  $("dlNote").textContent = want !== null && want !== now
    ? `The view will switch to ${want ? `PFSS + SCS (to ${want} R☉)` : "PFSS"} first, which takes a few seconds.`
    : kind === "surface" ? `The maps are from the model on screen: ${now ? `PFSS + SCS to ${now} R☉` : "PFSS"}, source surface ${state.rss.toFixed(1)} R☉.` : "";
}
$("dlResults").onclick = () => {
  const p = state.product;
  if (!p) return;
  $("dlDate").textContent = p.day;
  $("dlOpts").hidden = !p.computed;
  $("dlGo").disabled = !p.computed;
  $("dlIntro").innerHTML = p.computed
    ? "A zip with the results (a NetCDF file), a header file that describes them, and Python scripts that draw the same pictures as PNG and PDF."
    : "Results can be downloaded for dates computed in your browser, whose source badge reads <b>HMI CR …</b>. This daily product was solved on the server. Pick an earlier date to compute its rotation map; the download then becomes available.";
  dlNote();
  $("dlDlg").showModal();
};
for (const r of document.querySelectorAll('input[name="dlKind"]')) r.addEventListener("change", dlNote);
$("dlCancel").onclick = () => $("dlDlg").close();
$("dlGo").onclick = async () => {
  const kind = document.querySelector('input[name="dlKind"]:checked').value, btn = $("dlGo");
  btn.disabled = true; btn.textContent = "Preparing…";
  try {
    const want = KIND_ROUT(kind);
    if (want !== null && (state.product.meta.model.rout || 0) !== want) {
      $("dlNote").textContent = "Switching the model…";
      await setModel(want);
    }
    const p = state.product, m = p.meta, nf = m.lines.count;
    if (!p.computed) throw new Error("this date is no longer a computed one");
    $("dlNote").textContent = "Writing the files…";
    let n = 0;
    for (const q of p.polys) n += q.length;
    const xyz = new Float32Array(3 * n), counts = new Int32Array(p.polys.length);
    let o = 0;
    p.polys.forEach((q, i) => { counts[i] = q.length; for (const v of q) { xyz[o++] = v[0]; xyz[o++] = v[1]; xyz[o++] = v[2]; } });
    const connIdx = Object.entries(m.fleet || {}).filter(([, b]) => !b.planet).map(([key]) => {
      const v = speedFor(key).v, i = m.connect.findIndex((c) => c.body === key && c.v === v);
      return i >= 0 ? { body: key, v, i } : null;
    }).filter(Boolean);
    const [lon, lat, dist] = camParam().split(",").map(Number);
    const viewPng = await new Promise((ok) => snapshotCanvas().toBlob((b) => ok(b ? b.arrayBuffer() : null), "image/png"));
    const ld = document.querySelector('script[type="application/ld+json"]');
    let version = "";
    try { version = JSON.parse(ld.textContent).softwareVersion || ""; } catch (e) {}
    const res = await exportResults({
      kind, meta: JSON.parse(JSON.stringify(m)), xyz, counts, shape: (await historyIndex()).shape,
      drawn: (p.order ?? []).slice(0, Math.min(state.nLines, nf)), connIdx, version, saved: localDate(), viewPng: await viewPng,
      view: { lon, lat, dist, fov: camera.fov, logScale: state.logScale, theme: currentTheme(), vsw: state.vsw, connMode: state.connMode, nLines: state.nLines },
    });
    const url = URL.createObjectURL(new Blob([res.zip], { type: "application/zip" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: res.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    $("dlDlg").close();
    $("status").textContent = `Saved ${res.name}`;
    setTimeout(() => { $("status").textContent = ""; }, 3000);
  } catch (err) {
    $("dlNote").textContent = "Could not prepare the download: " + err.message;
  } finally {
    btn.disabled = false; btn.textContent = "Download";
  }
};

// ------------------------------------------------------------- dates
const TODAY = new Date().toISOString().slice(0, 10);
const FIRST = "2010-05-01";
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (day, k) => iso(new Date(Date.parse(day) + k * 86400000));

let askAgain = true;
try { askAgain = sessionStorage.getItem("hf.noask") !== "1"; } catch (e) {}

// Ask before a computation that replaces the scene. Resolves true to go on.
function confirmCompute(day, rot, exact) {
  return new Promise((resolve) => {
    const dlg = $("computeDlg");
    const fmt = (s) => new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    $("dlgDate").textContent = new Date(day + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    $("dlgRot").textContent = `Carrington rotation ${rot.cr} (${fmt(rot.start)} – ${fmt(rot.stop)})`;
    $("dlgInexact").hidden = exact;
    $("dlgNoAsk").checked = false;
    const done = (ok) => {
      if (ok && $("dlgNoAsk").checked) { askAgain = false; try { sessionStorage.setItem("hf.noask", "1"); } catch (e) {} }
      dlg.close(); resolve(ok);
    };
    $("dlgGo").onclick = () => done(true);
    $("dlgCancel").onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
    $("dlgGo").focus();
  });
}

const STAGES = { download: "Downloading the HMI map", harmonics: "Expanding the map in harmonics",
  field: "Solving the field", lines: "Tracing field lines", surface: "Finding the current sheet",
  holes: "Mapping coronal holes", connect: "Mapping the spacecraft", done: "Drawing" };
function showProgress(on, day) {
  $("busy").hidden = !on;
  if (on) { $("busyTitle").textContent = `Computing ${day}`; $("busyStage").textContent = "Preparing"; $("busyBar").value = 0; }
}

let loading = 0, fallbackDay = null;
// Free the current field before computing another, as the dialog promises:
// geometry, textures and the worker's previous rotation all go.
function clearScene() {
  for (const g of Object.values(G)) clear(g);
  if (G.photo.userData.dark) { scene.remove(G.photo.userData.dark); G.photo.userData.dark = null; }
  disposeProduct(state.product);
  state.product = null;
}
// After a cancelled or failed computation, show a daily product again.
function recover() {
  showProgress(false);
  if (!state.product && fallbackDay) goDaily(fallbackDay);
  else $("day").value = state.day || "";
}
// Open any date. Daily products load directly; any other date since 2010 is
// computed in the browser from the HMI rotation map that covers it.
async function openDate(day, { ask = true } = {}) {
  day = String(day).slice(0, 10);
  if (day === "latest") day = state.dates[state.dates.length - 1];
  if (state.dates.includes(day)) return goDaily(day);
  if (day < FIRST || day > TODAY) { $("day").value = state.day || ""; return false; }
  const ticket = ++loading;
  try {
    const idx = await historyIndex();
    const { rot, exact } = rotationFor(idx, day);
    const sameRot = state.product?.computed && state.product.meta.map_cr === rot.cr && state.product.meta.model.rss === state.rssWant
      && (state.product.meta.model.rout || 0) === state.routWant;
    if (ask && askAgain && !sameRot && !(await confirmCompute(day, rot, exact))) { $("day").value = state.day || ""; return false; }
    if (!sameRot) {
      fallbackDay = state.product && !state.product.computed ? state.day : state.dates[state.dates.length - 1];
      clearScene();
      showProgress(true, day);
    }
    const pos = await fleetFor(day);
    const res = await compute({ url: `data/history/${rot.file}`, key: rot.cr, scale: idx.scale_G, shape: idx.shape, fleet: pos.fleet, reuse: sameRot, rss: state.rssWant, rout: state.routWant },
      (stage, f) => { $("busyStage").textContent = STAGES[stage] || stage; $("busyBar").value = f; });
    if (ticket !== loading) return false;
    let product;
    const sourceMeta = {
      date: day, obstime: `${day}T12:00:00Z`, L0: pos.L0, B0: pos.B0, carrington_rotation: pos.CR,
      map_cr: rot.cr, map_start: rot.start, map_stop: rot.stop, exact, fleet: pos.fleet,
      source: { name: "SDO/HMI rotation map", short: `HMI CR ${rot.cr}`, file: `hmi.Synoptic_Mr_small.${rot.cr}`, url: sourceUrl(rot.cr) },
    };
    if (res.type === "connect") {
      // Same rotation: keep the field, replace the connectivity.
      const old = state.product, nf = old.meta.lines.count;
      const conn = unflatten(res.xyz, res.counts);
      const polys = old.polys.slice(0, nf).concat(conn);
      product = { ...old, day, polys, meta: { ...old.meta, ...sourceMeta, connect: res.connect, ensemble: res.ensemble,
        counts: polys.map((q) => q.length), _src: undefined } };
    } else {
      product = { day, computed: true, polys: unflatten(res.xyz, res.counts),
        brTex: dataTex(res.brTex), ssTex: dataTex(res.ssTex), footTex: res.footTex, meta: { ...res.meta, ...sourceMeta } };
    }
    showProgress(false);
    showProduct(product);
    if (view) setView(view, true);
    return true;
  } catch (err) {
    if (err.message !== "cancelled") {
      $("status").textContent = "Could not compute this date: " + err.message;
      setTimeout(() => { $("status").textContent = ""; }, 5000);
      if (ticket === loading) recover();
    }
    return false;
  }
}
$("busyCancel").onclick = () => { loading++; cancel(); recover(); };

async function goDaily(day) {
  // Supersedes any computation in progress, overlay included.
  ++loading; cancel(); showProgress(false);
  $("status").textContent = "Loading " + day + "…";
  showProduct(await fetchDaily(day));
  if (view) setView(view, true);
  return true;
}
// Arrows step through daily products where they exist and day by day before
// them; a step inside a computed rotation only re-traces connectivity.
function step(k) {
  if (!state.day) return;
  const i = state.dates.indexOf(state.day);
  if (i >= 0 && i + k >= 0 && i + k < state.dates.length) return goDaily(state.dates[i + k]);
  const next = addDays(state.day, k);
  if (next > TODAY || next < FIRST) return;
  if (k > 0 && state.dates.length && next >= state.dates[0] && !state.dates.includes(next)) {
    return openDate(state.dates.find((d) => d >= next) || state.dates[state.dates.length - 1]);
  }
  return openDate(next);
}
$("prev").onclick = () => step(-1);
$("next").onclick = () => step(1);
$("day").min = FIRST; $("day").max = TODAY;
$("day").addEventListener("change", (e) => { if (e.target.value && e.target.value !== state.day) openDate(e.target.value); });
$("latest").onclick = () => goDaily(state.dates[state.dates.length - 1]);

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input,select,textarea,dialog")) return;
  const k = e.key.toLowerCase();
  if (k === "arrowleft") step(-1);
  else if (k === "arrowright") step(1);
  else if (k === "l") setPanel(root.classList.contains("panel-closed"));
  else if (k === "escape" && !root.classList.contains("panel-closed")) { setPanel(false); $("menuBtn").focus(); }
  else if (k === "t") setTheme(currentTheme() === "dark" ? "light" : "dark");
  else if (k === "c") setSeries($("seriesPanel").hidden);
  else if (k === "e") setView("earth");
  else if (k === "n") setView("north");
  else if (k === "f") setView("fleet");
  else if (k === "h" || k === "home") resetView();
  else if (k === "r") { setSpin(!controls.autoRotate); syncUrl(); }
});

// ------------------------------------------------------------- embedding
// A host page can drive an embedded copy:
//   frame.contentWindow.postMessage({ type: "heliofield:set", date: "2014-03-12", v: 500, rss: 2.0, scs: 21.5, view: "earth" }, "*")
// and hears { type: "heliofield:state", date, v, rss, scs, source, computed } after every change.
function postState() {
  if (window.parent === window || !state.product) return;
  window.parent.postMessage({ type: "heliofield:state", date: state.day, v: state.vsw, rss: state.rss, scs: state.product.meta.model.rout || 0, conn: state.connMode,
    source: state.product.meta.source.short || "GONG", computed: !!state.product.computed,
    obstime: state.product.meta.obstime }, "*");
}
addEventListener("message", async (e) => {
  const d = e.data;
  if (!d || d.type !== "heliofield:set" || !state.dates.length) return;
  if (VSW.includes(+d.v)) setV(+d.v);
  if (d.conn) setConnMode(d.conn);
  if (d.layers) setLayers(d.layers);
  if (d.view) view = d.view;
  if (d.rss != null && Number.isFinite(+d.rss)) {
    state.rssWant = +Math.min(RSS_MAX, Math.max(RSS_MIN, +d.rss)).toFixed(1);
    if (!d.date && state.product?.computed) d.date = state.day;
  }
  if (d.scs != null) {
    state.routWant = ROUTS.includes(+d.scs) ? +d.scs : 0;
    if (!d.date && state.product?.computed) d.date = state.day;
  }
  rssControl();
  if (d.date) await openDate(d.date, { ask: false });   // reports its own state
  else postState();
  if (d.view) setView(d.view);
  syncUrl();
});

// ------------------------------------------------------------- start
async function start() {
  setTheme(currentTheme(), false);
  {
    const q = params.get("series");
    let on = q === "1" ? true : q === "0" ? false : !EMBED && matchMedia("(min-width: 1100px)").matches;
    if (!q && on) try { on = localStorage.getItem("hf.series") !== "off"; } catch (e) {}
    setSeries(on, false);
  }
  try {
    const idx = await fetch("data/index.json").then((r) => r.json());
    state.dates = idx.dates;
    const v = +params.get("v");
    if (VSW.includes(v)) setV(v);
    if (params.has("layers")) setLayers(params.get("layers"));
    const r = +params.get("rmax");
    if (r >= 0.1 && r <= 1.8) setRmax(r);
    if (params.get("ext") === "radial") setExtMode("radial");
    if (params.get("conn") === "sc") setConnMode("sc");
    if (params.get("scale") === "true") setScale(false);
    const a = params.get("ss");
    if (a !== null && +a >= 0 && +a <= 1) $("ssAlpha").value = a;
    setSpin(params.get("rotate") === "1");
    if (params.has("scs")) state.routWant = ROUTS.includes(+params.get("scs")) ? +params.get("scs") : 0;
    const rs = +params.get("rss");
    if (rs >= RSS_MIN && rs <= RSS_MAX) state.rssWant = +rs.toFixed(1);
    rssControl();
    const nl = +params.get("lines");
    if (nl >= 20 && nl <= 2000) setNLines(nl);
    if (VIEWS[params.get("view")]) view = params.get("view");
    // A daily product opens directly; another date is computed (embeds and
    // shared links do not ask first; the page itself does).
    const want = params.get("date");
    let ok = false;
    if (want && want !== "latest") ok = await openDate(want, { ask: !EMBED });
    if (!ok) await goDaily(state.dates[state.dates.length - 1]);
    const cam = (params.get("cam") || "").split(",").map(Number);
    if (view) setView(view, true);
    else if (cam.length === 3 && cam.every(Number.isFinite) && cam[2] > 1.2) flyTo(dir(...cam), true);
    else flyTo(home(), true);
    syncUrl();
  } catch (err) {
    $("status").textContent = "Could not load data: " + err.message;
  }
}
start();

renderer.setAnimationLoop((now) => {
  if (tween) tween(now);
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
});
