// HelioField: the coronal magnetic field in 3D.
// Every position in data/<date>/ is already in the Carrington frame
// (z = solar rotation axis, x = Carrington longitude 0), in solar radii, so
// the scene uses that frame directly with z up.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const RSUN_KM = 695700, AU_RS = 149597870.7 / RSUN_KM;
const OMEGA = 2 * Math.PI / (25.38 * 86400);          // Carrington sidereal [rad/s]
const DEG = Math.PI / 180;
const L1 = ["soho", "ace", "wind", "dscovr", "aditya", "imap", "swfo"];
const COLORS = {
  earth: "#4fa3ff", psp: "#ff7a45", solo: "#b37bff", sta: "#3ddc97",
  bepi: "#e8d36a", l1: "#7fd3e6", mercury: "#8b93a5", venus: "#b9a77d", mars: "#c46a4a",
};

const $ = (id) => document.getElementById(id);
const state = {
  dates: [], day: null, meta: null, lines: null,
  vsw: 400, rmaxAu: 1.2, logScale: true, rss: 2.5,
};

// ---------------------------------------------------------------- renderer
const stage = $("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
stage.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#05070d");
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
camera.up.set(0, 0, 1);
camera.position.set(9, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 1.3;
controls.maxDistance = 2000;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// Groups, rebuilt per date (or per wind speed for the heliospheric ones).
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
const brShader = (tex, alpha) => new THREE.ShaderMaterial({
  uniforms: { map: { value: tex }, alpha: { value: alpha } },
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
    uniform sampler2D map; uniform float alpha;
    varying vec3 vPos; varying float vMu;
    void main() {
      float lon = atan(vPos.y, vPos.x);
      float lat = asin(clamp(vPos.z / length(vPos), -1.0, 1.0));
      float s = texture2D(map, vec2(fract(lon / 6.2831853), lat / 3.1415927 + 0.5)).r * 2.0 - 1.0;
      vec3 W = vec3(0.93), P = vec3(0.88, 0.33, 0.24), N = vec3(0.24, 0.49, 0.88);
      vec3 c = s > 0.0 ? mix(W, P, pow(s, 0.8)) : mix(W, N, pow(-s, 0.8));
      gl_FragColor = vec4(c * mix(0.5, 1.0, sqrt(vMu)), alpha);
    }`,
});
const texLoader = new THREE.TextureLoader();
const loadTex = (url) => new Promise((ok, bad) => texLoader.load(url, (t) => {
  t.wrapS = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  ok(t);
}, undefined, bad));

// ------------------------------------------------------------- helpers
function clear(g) {
  for (const o of [...g.children]) {
    g.remove(o);
    o.traverse((c) => {
      c.geometry?.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
      if (c.isCSS2DObject) c.element.remove();
    });
  }
}
function segments(polys, colorOf, opacity) {
  const pos = [], col = [], c = new THREE.Color();
  polys.forEach((p, i) => {
    c.set(colorOf(i));
    for (let k = 0; k + 1 < p.length; k++) {
      pos.push(...p[k], ...p[k + 1]);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity }));
}
function line(points, color, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
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

// ------------------------------------------------------------- data
async function loadDay(day) {
  $("status").textContent = "Loading " + day + "…";
  const base = `data/${day}/`;
  const [meta, buf, brTex, ssTex] = await Promise.all([
    fetch(base + "meta.json").then((r) => r.json()),
    fetch(base + "lines.bin").then((r) => r.arrayBuffer()),
    loadTex(base + "br.png"), loadTex(base + "ss.png"),
  ]);
  const q = new Int16Array(buf), s = 1 / meta.qscale;
  const polys = [];
  let o = 0;
  for (const n of meta.counts) {
    const p = new Array(n);
    for (let k = 0; k < n; k++, o += 3) p[k] = [q[o] * s, q[o + 1] * s, q[o + 2] * s];
    polys.push(p);
  }
  state.day = day; state.meta = meta; state.lines = polys; state.rss = meta.model.rss;
  buildSun(brTex, ssTex);
  buildHelio();
  info();
  $("status").textContent = "";
  $("day").value = day;
  // Which magnetogram fed this day: GONG normally, HMI when GONG was unreachable.
  $("src").textContent = meta.source.short || "GONG";
  $("src").title = meta.source.name;
  syncUrl();
  postState();
}

function buildSun(brTex, ssTex) {
  const m = state.meta, nf = m.lines.count, kind = m.lines.kind;
  for (const k of ["photo", "closed", "open", "ss", "pil"]) clear(G[k]);

  G.photo.add(new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), brShader(brTex, 1)));
  // Without the photosphere, keep an occluding dark Sun so lines behind it hide.
  if (G.photo.userData.dark) scene.remove(G.photo.userData.dark);
  G.photo.userData.dark = new THREE.Mesh(new THREE.SphereGeometry(0.998, 64, 32),
    new THREE.MeshBasicMaterial({ color: "#11141c" }));
  scene.add(G.photo.userData.dark);

  const closed = [], open = [], openKind = [];
  for (let i = 0; i < nf; i++) (kind[i] ? (open.push(state.lines[i]), openKind.push(kind[i])) : closed.push(state.lines[i]));
  G.closed.add(segments(closed, () => "#c9ced8", 0.45));
  G.open.add(segments(open, (i) => (openKind[i] > 0 ? "#e0533d" : "#3d7ee0"), 0.85));

  const ss = new THREE.Mesh(new THREE.SphereGeometry(state.rss, 96, 48), brShader(ssTex, +$("ssAlpha").value));
  ss.renderOrder = 2;
  G.ss.add(ss);

  for (const h of m.hcs) {
    const pts = [];
    for (let k = 0; k < h.length; k += 2) pts.push(sph(state.rss * 1.004, h[k], h[k + 1]));
    G.pil.add(line(pts, "#f2b33d"));
  }
  applyVisibility();
}

// Fleet entries: L1 monitors collapse into one marker.
function fleetEntries() {
  const f = state.meta.fleet, out = [];
  for (const [k, b] of Object.entries(f)) if (!L1.includes(k)) out.push({ key: k, ...b });
  const l1 = L1.filter((k) => f[k]);
  if (l1.length) out.push({ key: "l1", ref: l1[0], ...f[l1[0]], name: `L1 monitors (${l1.length})`, members: l1 });
  return out;
}

function buildHelio() {
  for (const k of ["hcs", "fleet", "spiral"]) clear(G[k]);
  const m = state.meta, v = state.vsw;

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
      const lon = h[2 * i] - (OMEGA * (r - state.rss) * RSUN_KM / v) / DEG;
      const p = sph(r, lon, h[2 * i + 1]);
      pos.push(p.x, p.y, p.z);
    }
    for (let a = 0; a + 1 < idx.length; a++) for (let j = 0; j + 1 < NR; j++) {
      const p = a * NR + j, q = (a + 1) * NR + j;
      tri.push(p, q, p + 1, p + 1, q, q + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(tri);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: "#f2b33d", transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.renderOrder = 3;
    G.hcs.add(mesh);
  }

  // Bodies and their magnetic connection.
  const nf = m.lines.count, labelled = [];
  for (const b of fleetEntries()) {
    const color = COLORS[b.key] || "#ffffff", rRs = b.r * AU_RS;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: DOT, color, sizeAttenuation: false, depthTest: false }));
    sp.scale.setScalar(b.planet ? 0.012 : 0.016);
    sp.position.copy(sph(rRs, b.lon, b.lat));
    sp.renderOrder = 5;
    G.fleet.add(sp);
    // Bodies sitting together (Earth and L1, Mercury and BepiColombo) share
    // one label; spacecraft names lead and set its colour.
    const near = labelled.find((o) => o.pos.distanceTo(sp.position) < 0.02 * o.pos.length() + 0.05);
    if (near) {
      near.names[b.planet ? "push" : "unshift"](b.name);
      if (!b.planet && !near.color) near.color = color;
    } else {
      labelled.push({ pos: sp.position, sprite: sp, names: [b.name], color: b.planet ? null : color });
    }
    if (b.planet) continue;

    const ci = m.connect.findIndex((c) => c.body === (b.ref || b.key) && c.v === v);
    if (ci < 0) continue;
    const c = m.connect[ci], pts = [];
    for (let j = 0; j <= 160; j++) {
      const r = state.rss * Math.pow(rRs / state.rss, j / 160);
      pts.push(sph(r, c.ss[0] - (OMEGA * (r - state.rss) * RSUN_KM / v) / DEG, c.ss[1]));
    }
    G.spiral.add(line(pts, color, 0.9));
    const cor = state.lines[nf + ci];
    if (cor?.length > 1) G.spiral.add(line(cor.map((p) => new THREE.Vector3(...p)), color));
  }
  for (const o of labelled) {
    const el = document.createElement("div");
    el.className = "label" + (o.color ? "" : " planet");
    el.textContent = o.names.join(" · ");
    if (o.color) el.style.color = o.color;
    o.sprite.add(new CSS2DObject(el));
  }
  applyVisibility();
  feet();
}

// ------------------------------------------------------------- panel
const root = document.documentElement;
const EMBED = root.classList.contains("embed");
const params = new URLSearchParams(location.search);
const DEFAULTS = { v: 400, rmax: 1.2, ss: 0.25 };
const LAYERS = { photo: "lyrPhoto", closed: "lyrClosed", open: "lyrOpen", ss: "lyrSS",
  pil: "lyrPIL", hcs: "lyrHCS", fleet: "lyrFleet", spiral: "lyrSpiral" };

function applyVisibility() {
  for (const [g, id] of Object.entries(LAYERS)) G[g].visible = $(id).checked;
  if (G.photo.userData.dark) G.photo.userData.dark.visible = !G.photo.visible;
  // CSS2D labels ignore their parent's visibility, so toggle them by hand.
  G.fleet.traverse((o) => { if (o.isCSS2DObject) o.element.style.display = G.fleet.visible ? "" : "none"; });
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

function setV(v) {
  state.vsw = v; $("vsw").value = v; $("vOut").textContent = v;
  if (state.meta) buildHelio();
}
$("vsw").addEventListener("input", (e) => { setV(+e.target.value); syncUrl(); postState(); });
function setRmax(r) {
  state.rmaxAu = r; $("rmax").value = r; $("rOut").textContent = r.toFixed(1);
  if (state.meta) buildHelio();
}
$("rmax").addEventListener("input", (e) => { setRmax(+e.target.value); syncUrl(); });
function setScale(log) {
  state.logScale = log;
  $("scaleLog").classList.toggle("on", log);
  $("scaleTrue").classList.toggle("on", !log);
  $("scaleLog").setAttribute("aria-pressed", log);
  $("scaleTrue").setAttribute("aria-pressed", !log);
  if (state.meta) buildHelio();
}
$("scaleLog").onclick = () => { setScale(true); syncUrl(); };
$("scaleTrue").onclick = () => { setScale(false); syncUrl(); };

function info() {
  const m = state.meta, src = m.source;
  $("info").innerHTML = `<dl>
    <dt>Map time</dt><dd>${m.obstime.replace("T", " ").replace("Z", " UTC")}</dd>
    <dt>Magnetogram</dt><dd><a href="${src.url}" title="${src.file}">${src.name}</a></dd>
    <dt>Carrington rotation</dt><dd>${m.carrington_rotation}</dd>
    <dt>Earth L<sub>0</sub>, B<sub>0</sub></dt><dd>${m.L0.toFixed(1)}°, ${m.B0.toFixed(1)}°</dd>
    <dt>Open flux</dt><dd>${(m.open_flux_Mx / 1e22).toFixed(2)} × 10<sup>22</sup> Mx</dd>
    <dt>Field lines</dt><dd>${m.lines.count}</dd>
  </dl>`;
}
function feet() {
  const m = state.meta, v = state.vsw;
  const rows = fleetEntries().filter((b) => !b.planet).map((b) => {
    const c = m.connect.find((c) => c.body === (b.ref || b.key) && c.v === v);
    const f = c?.foot;
    return `<tr><td><span class="dot" style="background:${COLORS[b.key] || "#fff"}"></span>${b.name}</td>
      <td>${b.r.toFixed(2)}</td><td>${f ? f[0].toFixed(0) + "°" : "–"}</td><td>${f ? f[1].toFixed(0) + "°" : "–"}</td></tr>`;
  }).join("");
  $("feet").innerHTML = `<p class="note">Carrington longitude and latitude where each body's field line
    meets the photosphere, for ${v} km/s wind.</p>
    <table><tr><th></th><th>r [au]</th><th>Lon</th><th>Lat</th></tr>${rows}</table>`;
}

// Folding the panel. The choice is remembered on wide screens; links can
// force it with ?panel=0|1, and embeds start folded.
const narrow = matchMedia("(max-width: 760px)");
function setPanel(open) {
  root.classList.toggle("panel-closed", !open);
  $("panelToggle").setAttribute("aria-expanded", open);
  if (!EMBED && !narrow.matches) try { localStorage.setItem("hf.panel", open ? "open" : "closed"); } catch (e) {}
}
$("panelToggle").setAttribute("aria-expanded", !root.classList.contains("panel-closed"));
$("panelToggle").onclick = () => setPanel(root.classList.contains("panel-closed"));
$("panelClose").onclick = () => { setPanel(false); $("panelToggle").focus(); };

// ------------------------------------------------------------- views
let tween = null, view = null;
function flyTo(pos, instant) {
  if (instant) { camera.position.copy(pos); controls.target.set(0, 0, 0); return; }
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
  earth: () => dir(state.meta.L0, state.meta.B0, near()),
  north: () => dir(state.meta.L0 + 180, 89.5, near() * 1.2),
  fleet: () => {
    const far = Math.max(...Object.values(state.meta.fleet).map((b) => mapR(b.r * AU_RS)));
    return dir(state.meta.L0 + 200, 55, far / Math.tan(17.5 * DEG) * 1.15);
  },
};
// Named views follow the date (Earth moves); anything else is a fixed
// Carrington camera, which a shared link reproduces with ?cam=lon,lat,dist.
function setView(name, instant) {
  if (!VIEWS[name] || !state.meta) return;
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
// Everything a viewer can set is in the URL, so any state can be linked or
// embedded. Defaults are left out to keep links short.
function stateParams() {
  const p = new URLSearchParams({ date: state.day });
  if (state.vsw !== DEFAULTS.v) p.set("v", state.vsw);
  const on = Object.keys(LAYERS).filter((g) => $(LAYERS[g]).checked);
  if (on.length !== Object.keys(LAYERS).length) p.set("layers", on.join(","));
  if (state.rmaxAu !== DEFAULTS.rmax) p.set("rmax", state.rmaxAu);
  if (!state.logScale) p.set("scale", "true");
  if (+$("ssAlpha").value !== DEFAULTS.ss) p.set("ss", $("ssAlpha").value);
  if (view) p.set("view", view); else p.set("cam", camParam());
  if (controls.autoRotate) p.set("rotate", "1");
  return p;
}
const base = () => location.origin + location.pathname.replace(/index\.html$/, "");
function syncUrl() {
  if (!state.day) return;
  const p = stateParams();
  $("embedOpen").href = base() + "?" + p;
  for (const k of ["embed", "controls", "panel"]) if (params.has(k)) p.set(k, params.get(k));
  history.replaceState(null, "", "?" + p);
}

async function share(text, btn) {
  const out = $("shareOut");
  out.hidden = false; out.value = text; out.select();
  try { await navigator.clipboard.writeText(text); } catch (e) { return; }
  const label = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => { btn.textContent = label; }, 1400);
}
$("copyLink").onclick = (e) => share(base() + "?" + stateParams(), e.target);
$("copyEmbed").onclick = (e) => {
  const p = stateParams(); p.set("embed", "1");
  share(`<iframe src="${base()}?${p}" title="HelioField: the Sun's coronal magnetic field in 3D" ` +
    `width="100%" height="560" style="border:0;border-radius:12px" loading="lazy" allowfullscreen></iframe>`, e.target);
};

// ------------------------------------------------------------- dates
// A requested date snaps to the latest product on or before it, so a host
// page can pass any date (or "latest") without knowing which days exist.
function pickDate(want) {
  const d = state.dates;
  if (!want || want === "latest") return d[d.length - 1];
  want = String(want).slice(0, 10);
  let best = d[0];
  for (const x of d) if (x <= want) best = x;
  return best;
}
async function goDay(day) {
  await loadDay(day);
  if (view) setView(view, true);
}
function step(k) {
  const i = state.dates.indexOf(state.day) + k;
  if (i >= 0 && i < state.dates.length) goDay(state.dates[i]);
}
$("prev").onclick = () => step(-1);
$("next").onclick = () => step(1);
$("day").onchange = (e) => goDay(e.target.value);
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input,select,textarea")) return;
  const k = e.key.toLowerCase();
  if (k === "arrowleft") step(-1);
  else if (k === "arrowright") step(1);
  else if (k === "l") setPanel(root.classList.contains("panel-closed"));
  else if (k === "e") setView("earth");
  else if (k === "n") setView("north");
  else if (k === "f") setView("fleet");
  else if (k === "r") { setSpin(!controls.autoRotate); syncUrl(); }
});

// ------------------------------------------------------------- embedding
// A host page can drive an embedded copy:
//   frame.contentWindow.postMessage({ type: "heliofield:set", date: "2026-10-17", v: 500, view: "earth" }, "*")
// and hears { type: "heliofield:state", date, v, source } after every change.
function postState() {
  if (window.parent === window || !state.meta) return;
  window.parent.postMessage({ type: "heliofield:state", date: state.day, v: state.vsw,
    source: state.meta.source.short || "GONG", obstime: state.meta.obstime }, "*");
}
addEventListener("message", async (e) => {
  const d = e.data;
  if (!d || d.type !== "heliofield:set" || !state.dates.length) return;
  if ([300, 400, 500, 600, 700, 800].includes(+d.v)) setV(+d.v);
  if (d.layers) setLayers(d.layers);
  if (d.view) view = d.view;
  if (d.date) await goDay(pickDate(d.date));   // reports its own state
  else postState();
  if (d.view) setView(d.view);
  syncUrl();
});

// ------------------------------------------------------------- start
async function start() {
  try {
    const idx = await fetch("data/index.json").then((r) => r.json());
    state.dates = idx.dates;
    $("day").innerHTML = idx.dates.slice().reverse().map((d) => `<option>${d}</option>`).join("");
    const v = +params.get("v");
    if ([300, 400, 500, 600, 700, 800].includes(v)) setV(v);
    if (params.has("layers")) setLayers(params.get("layers"));
    const r = +params.get("rmax");
    if (r >= 0.1 && r <= 1.8) setRmax(r);
    if (params.get("scale") === "true") setScale(false);
    const a = params.get("ss");
    if (a !== null && +a >= 0 && +a <= 1) $("ssAlpha").value = a;
    setSpin(params.get("rotate") === "1");
    await loadDay(pickDate(params.get("date")));
    const cam = (params.get("cam") || "").split(",").map(Number);
    if (VIEWS[params.get("view")]) setView(params.get("view"), true);
    else if (cam.length === 3 && cam.every(Number.isFinite) && cam[2] > 1.2) flyTo(dir(...cam), true);
    else flyTo(dir(state.meta.L0 - 35, state.meta.B0 + 20, near()), true);
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
