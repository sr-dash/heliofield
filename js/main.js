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
import { historyIndex, rotationFor, sourceUrl, fleetFor, compute, cancel, unflatten } from "./history.js";
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
  vsw: 400, rmaxAu: 1.2, logScale: true, rss: 2.5, nLines: 250,
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
const WIDTH = { field: 1.6, spiral: 2.2, pil: 2.4 };
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  for (const m of lineMats) m.resolution.set(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const G = {};
for (const k of ["photo", "closed", "open", "ss", "pil", "hcs", "fleet", "spiral"]) {
  G[k] = new THREE.Group();
  scene.add(G[k]);
}

// ------------------------------------------------------------- distance
// Log mode keeps the corona at true size and compresses the heliosphere so
// 1 au lands near 25 R_sun; spirals and the sheet are computed in true r and
// mapped afterwards, so their shape in longitude is unchanged.
const mapR = (r) => (!state.logScale || r <= state.rss) ? r : state.rss * (1 + 2 * Math.log(r / state.rss));
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
  p?.brTex?.dispose(); p?.ssTex?.dispose();
}

function showProduct(p) {
  if (state.product && state.product !== p && state.product.brTex !== p.brTex) disposeProduct(state.product);
  state.product = p; state.day = p.day; state.rss = p.meta.model.rss;
  buildSun(); buildHelio(); info();
  $("status").textContent = "";
  $("day").value = p.day;
  $("src").textContent = p.meta.source.short || "GONG";
  $("src").title = p.meta.source.name;
  $("src").classList.toggle("computed", !!p.computed);
  syncUrl(); postState();
}

function buildSun() {
  const p = state.product, m = p.meta, nf = m.lines.count, kind = m.lines.kind, th = T();
  for (const k of ["photo", "closed", "open", "ss", "pil"]) clear(G[k]);
  G.photo.add(new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), brShader(p.brTex, 1)));
  // Without the photosphere, keep an occluding Sun so lines behind it hide.
  if (G.photo.userData.dark) scene.remove(G.photo.userData.dark);
  G.photo.userData.dark = new THREE.Mesh(new THREE.SphereGeometry(0.998, 64, 32),
    new THREE.MeshBasicMaterial({ color: th.occluder }));
  scene.add(G.photo.userData.dark);

  buildLines();

  const ss = new THREE.Mesh(new THREE.SphereGeometry(state.rss, 96, 48), brShader(p.ssTex, +$("ssAlpha").value));
  ss.renderOrder = 2;
  G.ss.add(ss);
  for (const h of m.hcs) {
    const pts = [];
    for (let k = 0; k < h.length; k += 2) pts.push(sph(state.rss * 1.004, h[k], h[k + 1]));
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
  for (const i of keep) (kind[i] ? (open.push(p.polys[i]), openKind.push(kind[i])) : closed.push(p.polys[i]));
  G.closed.add(segments(closed, () => th.closed, 0.85));
  G.open.add(segments(open, (i) => (openKind[i] > 0 ? th.pos : th.neg), 1));
  $("nlOut").textContent = keep.length;
  $("nLines").max = nf;
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

function buildHelio() {
  for (const k of ["hcs", "fleet", "spiral"]) clear(G[k]);
  const p = state.product, m = p.meta, v = state.vsw, th = T();

  // Heliospheric current sheet: the source-surface neutral line carried
  // outward radially and wound back by rotation at speed v.
  const rOut = Math.max(state.rmaxAu * AU_RS, state.rss * 1.01), NR = 90;
  const radii = Array.from({ length: NR }, (_, j) => state.rss * Math.pow(rOut / state.rss, j / (NR - 1)));
  for (const h of m.hcs) {
    const n = h.length / 2, step = Math.max(1, Math.floor(n / 260)), idx = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    const pos = [], tri = [];
    for (const i of idx) for (const r of radii) {
      const q = sph(r, h[2 * i] - (OMEGA * (r - state.rss) * RSUN_KM / v) / DEG, h[2 * i + 1]);
      pos.push(q.x, q.y, q.z);
    }
    for (let a = 0; a + 1 < idx.length; a++) for (let j = 0; j + 1 < NR; j++) {
      const s0 = a * NR + j, s1 = (a + 1) * NR + j;
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

    const ci = m.connect.findIndex((c) => c.body === (b.ref || b.key) && c.v === v);
    if (ci < 0) continue;
    const c = m.connect[ci], pts = [];
    for (let j = 0; j <= 160; j++) {
      const r = state.rss * Math.pow(rRs / state.rss, j / 160);
      pts.push(sph(r, c.ss[0] - (OMEGA * (r - state.rss) * RSUN_KM / v) / DEG, c.ss[1]));
    }
    G.spiral.add(line(pts, color, 0.95));
    const cor = p.polys[nf + ci];
    if (cor?.length > 1) G.spiral.add(line(cor.map((q) => new THREE.Vector3(...q)), color));
  }
  // Labels wear text colours; the marker colour sits in a dot beside them.
  for (const o of labelled) {
    const el = document.createElement("div");
    el.className = "label" + (o.colors.length ? "" : " planet");
    el.textContent = o.names.join(" · ");
    if (o.colors.length) { el.style.setProperty("--dot", o.colors[0]); el.dataset.color = o.colors[0]; }
    o.sprite.add(new CSS2DObject(el));
  }
  applyVisibility();
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
  syncUrl();
}
$("themeToggle").onclick = () => setTheme(currentTheme() === "dark" ? "light" : "dark");

// ------------------------------------------------------------- panel
const DEFAULTS = { v: 400, rmax: 1.2, ss: 0.25, lines: 250 };
const LAYERS = { photo: "lyrPhoto", closed: "lyrClosed", open: "lyrOpen", ss: "lyrSS",
  pil: "lyrPIL", hcs: "lyrHCS", fleet: "lyrFleet", spiral: "lyrSpiral" };

function applyVisibility() {
  for (const [g, id] of Object.entries(LAYERS)) G[g].visible = $(id).checked;
  if (G.photo.userData.dark) G.photo.userData.dark.visible = !G.photo.visible;
  // Spirals start at the spacecraft, so they go when the fleet goes; their
  // own switch is a sub-option, disabled meanwhile.
  G.spiral.visible = G.fleet.visible && $("lyrSpiral").checked;
  $("lyrSpiral").disabled = !G.fleet.visible;
  // The label renderer reads each label's own visible flag every frame and
  // ignores its parents', so the flag has to be set on the labels themselves.
  G.fleet.traverse((o) => { if (o.isCSS2DObject) o.visible = G.fleet.visible; });
}
function setLayers(list) {
  const on = new Set(String(list).split(",").map((s) => s.trim()));
  for (const [g, id] of Object.entries(LAYERS)) $(id).checked = on.has(g);
  applyVisibility();
}
for (const id of Object.values(LAYERS)) $(id).addEventListener("change", () => { applyVisibility(); syncUrl(); });

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
function setScale(log) {
  state.logScale = log;
  for (const [id, on] of [["scaleLog", log], ["scaleTrue", !log]]) {
    $(id).classList.toggle("on", on); $(id).setAttribute("aria-pressed", on);
  }
  if (state.product) buildHelio();
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
    ["Open flux", `${flux} × 10<sup>22</sup> Mx`],
    ["Field lines", m.lines.count],
    ["Computed", state.product.computed ? "in your browser" : "daily, on the server"],
  );
  $("info").innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`
    + (state.product.computed && !m.exact ? `<p class="note warn">No rotation map covers this date, so the nearest one (CR ${m.map_cr}) is used.</p>` : "");
}
function feet() {
  const m = state.product.meta, v = state.vsw;
  const rows = fleetEntries().filter((b) => !b.planet).map((b) => {
    const c = m.connect.find((c) => c.body === (b.ref || b.key) && c.v === v);
    const f = c?.foot;
    return `<tr><td><span class="dot" style="background:${fleetColor(b.key)}"></span>${b.name}</td>
      <td>${b.r.toFixed(2)}</td><td>${f ? f[0].toFixed(0) + "°" : "–"}</td><td>${f ? f[1].toFixed(0) + "°" : "–"}</td></tr>`;
  }).join("");
  $("feet").innerHTML = `<p class="note">Carrington longitude and latitude where each body's field line
    meets the photosphere, for ${v} km/s wind.</p>
    <table><tr><th></th><th>r [au]</th><th>Lon</th><th>Lat</th></tr>${rows}</table>`;
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
const near = () => 9 / Math.min(1, camera.aspect * 1.6);
const VIEWS = {
  earth: () => dir(state.product.meta.L0, state.product.meta.B0, near()),
  north: () => dir(state.product.meta.L0 + 180, 89.5, near() * 1.2),
  fleet: () => {
    const far = Math.max(...Object.values(state.product.meta.fleet).map((b) => mapR(b.r * AU_RS)));
    return dir(state.product.meta.L0 + 200, 55, far / Math.tan(17.5 * DEG) * 1.15);
  },
};
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
controls.addEventListener("end", () => syncUrl());
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
  if (on.length !== Object.keys(LAYERS).length) p.set("layers", on.join(","));
  if (state.rmaxAu !== DEFAULTS.rmax) p.set("rmax", state.rmaxAu);
  if (!state.logScale) p.set("scale", "true");
  if (+$("ssAlpha").value !== DEFAULTS.ss) p.set("ss", $("ssAlpha").value);
  if (state.nLines !== DEFAULTS.lines) p.set("lines", state.nLines);
  if (view) p.set("view", view); else p.set("cam", camParam());
  if (controls.autoRotate) p.set("rotate", "1");
  return p;
}
const base = () => location.origin + location.pathname.replace(/index\.html$/, "");
function syncUrl() {
  if (!state.day) return;
  const p = stateParams();
  $("embedOpen").href = base() + "?" + p;
  for (const k of ["embed", "controls", "panel", "theme"]) if (params.has(k)) p.set(k, params.get(k));
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
function snapshotCanvas() {
  controls.update();
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
      `${m.source.name}${state.product.computed ? ` (CR ${m.map_cr})` : ""} · PFSS, source surface ${state.rss} R☉ · solar wind ${state.vsw} km/s`,
      `Carrington frame · Earth L0 ${m.L0.toFixed(1)}°, B0 ${m.B0.toFixed(1)}° · open flux ${(m.open_flux_Mx / 1e22).toFixed(2)} × 10²² Mx`,
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
  field: "Solving the field", lines: "Tracing field lines", surface: "Finding the current sheet", done: "Drawing" };
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
    const sameRot = state.product?.computed && state.product.meta.map_cr === rot.cr;
    if (ask && askAgain && !sameRot && !(await confirmCompute(day, rot, exact))) { $("day").value = state.day || ""; return false; }
    if (!sameRot) {
      fallbackDay = state.product && !state.product.computed ? state.day : state.dates[state.dates.length - 1];
      clearScene();
      showProgress(true, day);
    }
    const pos = await fleetFor(day);
    const res = await compute({ url: `data/history/${rot.file}`, key: rot.cr, scale: idx.scale_G, shape: idx.shape, fleet: pos.fleet, reuse: sameRot },
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
      product = { ...old, day, polys, meta: { ...old.meta, ...sourceMeta, connect: res.connect,
        counts: polys.map((q) => q.length) } };
    } else {
      product = { day, computed: true, polys: unflatten(res.xyz, res.counts),
        brTex: dataTex(res.brTex), ssTex: dataTex(res.ssTex), meta: { ...res.meta, ...sourceMeta } };
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
  ++loading; cancel();
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
  else if (k === "e") setView("earth");
  else if (k === "n") setView("north");
  else if (k === "f") setView("fleet");
  else if (k === "r") { setSpin(!controls.autoRotate); syncUrl(); }
});

// ------------------------------------------------------------- embedding
// A host page can drive an embedded copy:
//   frame.contentWindow.postMessage({ type: "heliofield:set", date: "2014-03-12", v: 500, view: "earth" }, "*")
// and hears { type: "heliofield:state", date, v, source, computed } after every change.
function postState() {
  if (window.parent === window || !state.product) return;
  window.parent.postMessage({ type: "heliofield:state", date: state.day, v: state.vsw,
    source: state.product.meta.source.short || "GONG", computed: !!state.product.computed,
    obstime: state.product.meta.obstime }, "*");
}
addEventListener("message", async (e) => {
  const d = e.data;
  if (!d || d.type !== "heliofield:set" || !state.dates.length) return;
  if (VSW.includes(+d.v)) setV(+d.v);
  if (d.layers) setLayers(d.layers);
  if (d.view) view = d.view;
  if (d.date) await openDate(d.date, { ask: false });   // reports its own state
  else postState();
  if (d.view) setView(d.view);
  syncUrl();
});

// ------------------------------------------------------------- start
async function start() {
  setTheme(currentTheme(), false);
  try {
    const idx = await fetch("data/index.json").then((r) => r.json());
    state.dates = idx.dates;
    const v = +params.get("v");
    if (VSW.includes(v)) setV(v);
    if (params.has("layers")) setLayers(params.get("layers"));
    const r = +params.get("rmax");
    if (r >= 0.1 && r <= 1.8) setRmax(r);
    if (params.get("scale") === "true") setScale(false);
    const a = params.get("ss");
    if (a !== null && +a >= 0 && +a <= 1) $("ssAlpha").value = a;
    setSpin(params.get("rotate") === "1");
    const nl = +params.get("lines");
    if (nl >= 20 && nl <= 2000) setNLines(nl);
    if (VIEWS[params.get("view")]) view = params.get("view");
    // A daily product opens directly; another date is computed (embeds and
    // shared links do not ask first; the page itself does).
    const want = params.get("date");
    let ok = false;
    if (want && want !== "latest" && !state.dates.includes(want.slice(0, 10))) ok = await openDate(want, { ask: !EMBED });
    if (!ok) await goDaily(state.dates[state.dates.length - 1]);
    const cam = (params.get("cam") || "").split(",").map(Number);
    if (view) setView(view, true);
    else if (cam.length === 3 && cam.every(Number.isFinite) && cam[2] > 1.2) flyTo(dir(...cam), true);
    else flyTo(dir(state.product.meta.L0 - 35, state.product.meta.B0 + 20, near()), true);
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
