// Geometry for the connectivity page. Pure functions (no DOM), tested
// from Python through tests/js/bridge.mjs.
//
// Coordinates follow SunPy: Carrington and Stonyhurst heliographic, the
// heliocentric (Thompson) frame of an observer, and helioprojective angles
// (Tx positive to solar west, Ty to solar north) in arcseconds. Distances
// are in solar radii unless named otherwise.

export const RSUN_KM = 695700, AU_RS = 149597870.7 / RSUN_KM;
const DEG = Math.PI / 180, ARCSEC = DEG / 3600, DAY = 86400000;
export const OMEGA = 2 * Math.PI / (25.38 * 86400);           // sidereal rotation [rad/s]

const wrap = (a) => ((a % 360) + 360) % 360;
const wrap180 = (a) => ((a + 540) % 360) - 180;

// ------------------------------------------------------------- time
// A body's position at any moment from samples at 12:00 UTC each day
// ([{ t: ms, lon, lat, r }], Carrington), interpolated with longitude unwrapped.
export function interpolate(samples, t) {
  if (!samples.length) return null;
  let i = samples.findIndex((s) => s.t > t);
  if (i < 0) i = samples.length - 1;
  if (i === 0) i = 1;
  const a = samples[i - 1], b = samples[i] ?? a;
  if (!b || b === a) return { ...a };
  const f = (t - a.t) / (b.t - a.t), dl = wrap180(b.lon - a.lon);
  return { lon: wrap(a.lon + f * dl), lat: a.lat + f * (b.lat - a.lat), r: a.r + f * (b.r - a.r) };
}

// Ballistic travel time [ms] from the model's outer boundary to a body at
// r_au, at speed v [km/s]: the time the plasma reaching the body left.
export const travelMs = (rAu, rEdge, v) => ((rAu * AU_RS - rEdge) * RSUN_KM / v) * 1000;

// ------------------------------------------------------------- projection
// Heliocentric (Thompson) coordinates of a surface point (Stonyhurst lon,
// lat) for an observer at Stonyhurst (lonO, latO): x west, y north, z towards
// the observer, in solar radii.
export function heliocentric(lon, lat, lonO, latO, r = 1) {
  const L = (lon - lonO) * DEG, b = lat * DEG, B = latO * DEG;
  return [r * Math.cos(b) * Math.sin(L), r * (Math.sin(b) * Math.cos(B) - Math.cos(b) * Math.cos(L) * Math.sin(B)),
    r * (Math.sin(b) * Math.sin(B) + Math.cos(b) * Math.cos(L) * Math.cos(B))];
}

// Helioprojective angles [arcsec] of a point on the photosphere, and whether
// the observer (distance D [R_sun]) sees it.
export function toHpc(lon, lat, obs) {
  const [x, y, z] = heliocentric(lon, lat, obs.lon, obs.lat), D = obs.d;
  const dz = D - z, dist = Math.hypot(x, y, dz);
  return { x: Math.atan2(x, dz) / ARCSEC, y: Math.asin(y / dist) / ARCSEC, visible: z > 1 / D };
}

// The photospheric point behind helioprojective angles (Tx, Ty), as Stonyhurst
// lon, lat; off the disk, the limb point nearest the line of sight.
export function fromHpc(tx, ty, obs) {
  const D = obs.d, a = tx * ARCSEC, b = ty * ARCSEC;
  const dir = [Math.cos(b) * Math.sin(a), Math.sin(b), -Math.cos(b) * Math.cos(a)];
  const od = D * dir[2], disc = od * od - (D * D - 1);
  let p;
  if (disc >= 0) {
    const s = -od - Math.sqrt(disc);
    p = [s * dir[0], s * dir[1], D + s * dir[2]];
  } else {
    const s = -od;
    const q = [s * dir[0], s * dir[1], D + s * dir[2]], n = Math.hypot(...q);
    p = q.map((v) => v / n);
  }
  const B = obs.lat * DEG, [x, y, z] = p;
  const lat = Math.asin(Math.max(-1, Math.min(1, y * Math.cos(B) + z * Math.sin(B)))) / DEG;
  const lon = obs.lon + Math.atan2(x, z * Math.cos(B) - y * Math.sin(B)) / DEG;
  return { lon: wrap180(lon), lat, onDisk: disc >= 0 };
}

// Arcseconds per heliographic degree at disk centre, for an observer at D.
export const arcsecPerDeg = (D) => (Math.asin(1 / D) / ARCSEC) * DEG;

// ------------------------------------------------------------- polygons
export function inside(px, py, xs, ys) {
  let c = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    if ((ys[i] > py) !== (ys[j] > py) && px < ((xs[j] - xs[i]) * (py - ys[i])) / (ys[j] - ys[i]) + xs[i]) c = !c;
  }
  return c;
}
export function edgeDistance(px, py, xs, ys) {
  let best = Infinity;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const ax = xs[j], ay = ys[j], bx = xs[i], by = ys[i], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) || 1)));
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

// ------------------------------------------------------------- matching
// HelioFleet observation rows ({ i, t0, t1, f: "E"|"S", x, y, o }) whose
// footprint contains or lies near a body's footpoints, during the window
// [from, to] (ms). earthAt(t) gives Earth's Carrington { lon, lat, r }
// (Stonyhurst longitude 0 by definition); feet are Carrington
// { lon, lat } with feet[0] the main footpoint. near: degrees.
export function matchObservations(rows, feet, from, to, earthAt, near = 5) {
  const out = [];
  for (const row of rows) {
    const t0 = Date.parse(row.t0), t1 = Date.parse(row.t1 || row.t0);
    if (t1 < from || t0 > to) continue;
    const tm = Math.max(from, Math.min(to, (t0 + t1) / 2)), earth = earthAt(tm);
    if (!earth) continue;
    const obs = row.f === "S" && row.o
      ? { lon: row.o[0], lat: row.o[1], d: row.o[2] * AU_RS }
      : { lon: 0, lat: earth.lat, d: earth.r * AU_RS };
    const perDeg = arcsecPerDeg(obs.d);
    let inMain = false, inCount = 0, nearest = Infinity, seen = 0;
    feet.forEach((f, k) => {
      const h = toHpc(wrap180(f.lon - earth.lon), f.lat, obs);
      if (!h.visible) return;
      seen++;
      const isIn = inside(h.x, h.y, row.x, row.y);
      if (isIn) { inCount++; if (k === 0) inMain = true; nearest = 0; } else nearest = Math.min(nearest, edgeDistance(h.x, h.y, row.x, row.y) / perDeg);
    });
    if (!seen || nearest > near) continue;
    out.push({ row, inMain, share: inCount / feet.length, nearDeg: nearest, tm, frame: row.f || "E" });
  }
  return out.sort((a, b) => b.inMain - a.inMain || a.nearDeg - b.nearDeg || Date.parse(a.row.t0) - Date.parse(b.row.t0));
}

// An observation footprint drawn on a Carrington map: its vertices traced
// back to the photosphere and placed in Carrington longitude.
export function footprintCarrington(row, earth) {
  const obs = row.f === "S" && row.o ? { lon: row.o[0], lat: row.o[1], d: row.o[2] * AU_RS } : { lon: 0, lat: earth.lat, d: earth.r * AU_RS };
  return row.x.map((x, k) => {
    const p = fromHpc(x, row.y[k], obs);
    return [wrap(p.lon + earth.lon), p.lat];
  });
}

// ------------------------------------------------------------- plane of sky
// A camera at a body (Carrington lon, lat, r [R_sun]) looking at Sun centre,
// solar north up and west to the right, as coronagraph images are shown.
export function skyCamera(lon, lat, r) {
  const o = [r * Math.cos(lat * DEG) * Math.cos(lon * DEG), r * Math.cos(lat * DEG) * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
  const f = o.map((v) => -v / r);
  const k = [0, 0, 1], kf = k[0] * f[0] + k[1] * f[1] + k[2] * f[2];
  let up = k.map((v, i) => v - kf * f[i]);
  const nu = Math.hypot(...up) || 1;
  up = up.map((v) => v / nu);
  const west = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  return { o, f, up, west, d: r };
}
// A point (Carrington Cartesian, R_sun) seen from the camera: elongation
// [deg], position angle (from north through east, deg), and plane-of-sky
// coordinates in solar radii (x west, y north; tangent projection at the
// Sun's distance). behind: farther than the camera's plane through the Sun.
export function skyPoint(cam, p) {
  const q = [p[0] - cam.o[0], p[1] - cam.o[1], p[2] - cam.o[2]];
  const depth = q[0] * cam.f[0] + q[1] * cam.f[1] + q[2] * cam.f[2];
  const x = q[0] * cam.west[0] + q[1] * cam.west[1] + q[2] * cam.west[2];
  const y = q[0] * cam.up[0] + q[1] * cam.up[1] + q[2] * cam.up[2];
  const elong = Math.atan2(Math.hypot(x, y), depth) / DEG;
  return { elong, pa: Math.atan2(-x, y) / DEG, x: (x / depth) * cam.d, y: (y / depth) * cam.d, depth, front: depth > 0 };
}
// Whether the Sun hides a point from the camera.
export function hiddenBySun(cam, p) {
  const q = [p[0] - cam.o[0], p[1] - cam.o[1], p[2] - cam.o[2]], L = Math.hypot(...q);
  const u = q.map((v) => v / L), b = u[0] * cam.o[0] + u[1] * cam.o[1] + u[2] * cam.o[2];
  const disc = b * b - (cam.d * cam.d - 1), t0 = -b - Math.sqrt(Math.max(0, disc));
  return disc > 0 && t0 > 0 && t0 < L && Math.hypot(...p) > 1;
}
