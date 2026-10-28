// PFSS in the browser: spherical-harmonic solution of the potential field
// between the photosphere and a spherical source surface, a field grid for
// tracing, field lines, the source-surface neutral line, open flux and
// spacecraft connectivity. Optionally coupled to a Schatten current-sheet
// (SCS) model beyond a cusp surface, as in the WSA model. Pure math, no DOM: it runs in a Web Worker and
// under Node for testing against the Python pipeline.
//
// Input map: Float32Array of ny x nx radial field [G], rows uniform in
// sin(latitude) from south to north, column j centred on Carrington
// longitude (j + 0.5) * 360 / nx.

const TAU = 2 * Math.PI, DEG = Math.PI / 180;
const RSUN_KM = 695700, RSUN_CM = 6.957e10, AU_RS = 149597870.7 / RSUN_KM;
const OMEGA = TAU / (25.38 * 86400);

// Fully normalised associated Legendre functions (geodesy 4-pi norm:
// the mean of (P_lm cos m phi)^2 over the sphere is 1), at mu = cos(theta).
// Returned flat, index l*(L+1)+m.
export function alf(mu, L, out = new Float64Array((L + 1) * (L + 1))) {
  const s = Math.sqrt(Math.max(0, 1 - mu * mu)), W = L + 1;
  out.fill(0);
  out[0] = 1;
  for (let m = 0; m <= L; m++) {
    if (m > 0) out[m * W + m] = (m === 1 ? Math.sqrt(3) : Math.sqrt((2 * m + 1) / (2 * m))) * s * out[(m - 1) * W + (m - 1)];
    if (m + 1 <= L) out[(m + 1) * W + m] = Math.sqrt(2 * m + 3) * mu * out[m * W + m];
    for (let l = m + 2; l <= L; l++) {
      const a = Math.sqrt((4 * l * l - 1) / (l * l - m * m));
      const b = Math.sqrt((((l - 1) * (l - 1) - m * m) * (2 * l + 1)) / ((l * l - m * m) * (2 * l - 3)));
      out[l * W + m] = a * mu * out[(l - 1) * W + m] - b * out[(l - 2) * W + m];
    }
  }
  return out;
}

// Harmonic coefficients of the map, monopole removed unless `mono`.
export function analyse(br, ny, nx, L, { mono = false } = {}) {
  const W = L + 1, C = new Float64Array(W * W), S = new Float64Array(W * W);
  const cosT = new Float64Array(nx * W), sinT = new Float64Array(nx * W);
  for (let j = 0; j < nx; j++) for (let m = 0; m <= L; m++) {
    const ph = (j + 0.5) * TAU / nx;
    cosT[j * W + m] = Math.cos(m * ph); sinT[j * W + m] = Math.sin(m * ph);
  }
  const P = new Float64Array(W * W), dOmega = (2 / ny) * (TAU / nx) / (4 * Math.PI);
  const cm = new Float64Array(W), sm = new Float64Array(W);
  for (let i = 0; i < ny; i++) {
    const mu = -1 + (2 * i + 1) / ny;
    cm.fill(0); sm.fill(0);
    for (let j = 0; j < nx; j++) {
      const v = br[i * nx + j];
      if (!v) continue;
      for (let m = 0; m <= L; m++) { cm[m] += v * cosT[j * W + m]; sm[m] += v * sinT[j * W + m]; }
    }
    alf(mu, L, P);
    for (let l = mono ? 0 : 1; l <= L; l++) for (let m = 0; m <= l; m++) {
      C[l * W + m] += P[l * W + m] * cm[m] * dOmega;
      S[l * W + m] += P[l * W + m] * sm[m] * dOmega;
    }
  }
  return { C, S, L, lmin: mono ? 0 : 1 };
}

// Radial factors, scaled by rss^-(2l+1) so nothing overflows.
// f: B_r(r) / B_r(1) for degree l; g: the potential factor for B_theta, B_phi.
function radial(l, r, rss) {
  const q = Math.pow(rss, -(2 * l + 1)), D = l * q + (l + 1);
  return {
    f: (l * Math.pow(r, l - 1) * q + (l + 1) * Math.pow(r, -(l + 2))) / D,
    g: (Math.pow(r, l) * q - Math.pow(r, -(l + 1))) / D,
  };
}

// The same factors for a potential field outside a sphere of radius rcp,
// vanishing at infinity: B_r = a_lm (rcp/r)^(l+2) Y_lm. Used by the SCS model.
const exterior = (rcp) => (l, r) => ({ f: Math.pow(rcp / r, l + 2), g: -rcp / (l + 1) * Math.pow(rcp / r, l + 1) });

// Field on a grid uniform in ln r, theta (cell centres) and phi (periodic),
// stored as Cartesian components for trilinear interpolation. By default the
// PFSS field between 1 and rss; with r0, r1 and radialFn, any potential field
// whose radial dependence is given per degree.
export function fieldGrid(coef, { rss = 2.5, r0 = 1, r1 = rss, radialFn = (l, r) => radial(l, r, rss), nr = 36, nth = 90, nph = 180, progress } = {}) {
  const { C, S, L } = coef, W = L + 1, l0 = coef.lmin ?? 1;
  const n = nr * nth * nph, B = new Float32Array(3 * n);
  const cph = new Float64Array(nph * W), sph = new Float64Array(nph * W);
  for (let p = 0; p < nph; p++) for (let m = 0; m <= L; m++) {
    cph[p * W + m] = Math.cos(m * p * TAU / nph); sph[p * W + m] = Math.sin(m * p * TAU / nph);
  }
  // Legendre functions and their theta derivative at each theta node.
  const Pth = [], dPth = [], eps = 1e-5, Pa = new Float64Array(W * W), Pb = new Float64Array(W * W);
  for (let k = 0; k < nth; k++) {
    const th = (k + 0.5) * Math.PI / nth;
    Pth.push(alf(Math.cos(th), L));
    alf(Math.cos(th + eps), L, Pa); alf(Math.cos(th - eps), L, Pb);
    const d = new Float64Array(W * W);
    for (let i = 0; i < W * W; i++) d[i] = (Pa[i] - Pb[i]) / (2 * eps);
    dPth.push(d);
  }
  const rc = new Float64Array(W), rs = new Float64Array(W), tc = new Float64Array(W), ts = new Float64Array(W),
    pc = new Float64Array(W), ps = new Float64Array(W);
  const fl = new Float64Array(W), gl = new Float64Array(W);
  for (let ir = 0; ir < nr; ir++) {
    const r = r0 * Math.exp(Math.log(r1 / r0) * ir / (nr - 1));
    for (let l = l0; l <= L; l++) { const x = radialFn(l, r); fl[l] = x.f; gl[l] = x.g; }
    for (let k = 0; k < nth; k++) {
      const th = (k + 0.5) * Math.PI / nth, st = Math.sin(th), ct = Math.cos(th);
      const P = Pth[k], dP = dPth[k];
      rc.fill(0); rs.fill(0); tc.fill(0); ts.fill(0); pc.fill(0); ps.fill(0);
      for (let l = l0; l <= L; l++) for (let m = 0; m <= l; m++) {
        const i = l * W + m, c = C[i], s = S[i];
        rc[m] += c * P[i] * fl[l]; rs[m] += s * P[i] * fl[l];
        tc[m] += c * dP[i] * gl[l]; ts[m] += s * dP[i] * gl[l];
        pc[m] += c * P[i] * gl[l] * m; ps[m] += s * P[i] * gl[l] * m;
      }
      for (let p = 0; p < nph; p++) {
        let Br = 0, Bt = 0, Bp = 0;
        for (let m = 0; m <= L; m++) {
          const co = cph[p * W + m], si = sph[p * W + m];
          Br += rc[m] * co + rs[m] * si;
          Bt += tc[m] * co + ts[m] * si;
          Bp += -pc[m] * si + ps[m] * co;
        }
        Bt /= r; Bp /= r * st;
        const ph = p * TAU / nph, cp = Math.cos(ph), sp = Math.sin(ph);
        const o = 3 * ((ir * nth + k) * nph + p);
        B[o] = Br * st * cp + Bt * ct * cp - Bp * sp;
        B[o + 1] = Br * st * sp + Bt * ct * sp + Bp * cp;
        B[o + 2] = Br * ct - Bt * st;
      }
    }
    progress?.((ir + 1) / nr);
  }
  // rss is the outer edge, r0 the inner; rStop (set by the caller) can stop
  // tracing below the outer edge.
  return { B, nr, nth, nph, rss: r1, r0, lnr0: Math.log(r0), lnr: Math.log(r1 / r0) };
}

// Trilinear interpolation of the Cartesian field at a Cartesian point.
export function sample(G, x, y, z, out) {
  const r = Math.hypot(x, y, z);
  if (G.near && r < G.near.rss) return sample(G.near, x, y, z, out);
  const fr = Math.min(Math.max((Math.log(r) - G.lnr0) / G.lnr * (G.nr - 1), 0), G.nr - 1.000001);
  const ft = Math.min(Math.max(Math.acos(Math.max(-1, Math.min(1, z / r))) / Math.PI * G.nth - 0.5, 0), G.nth - 1.000001);
  let fp = (Math.atan2(y, x) / TAU) * G.nph; if (fp < 0) fp += G.nph;
  const i0 = fr | 0, j0 = ft | 0, k0 = Math.floor(fp) % G.nph, k1 = (k0 + 1) % G.nph;
  const a = fr - i0, b = ft - j0, c = fp - Math.floor(fp);
  out[0] = out[1] = out[2] = 0;
  for (let di = 0; di < 2; di++) for (let dj = 0; dj < 2; dj++) for (let dk = 0; dk < 2; dk++) {
    const w = (di ? a : 1 - a) * (dj ? b : 1 - b) * (dk ? c : 1 - c);
    if (!w) continue;
    const o = 3 * (((i0 + di) * G.nth + (j0 + dj)) * G.nph + (dk ? k1 : k0));
    out[0] += w * G.B[o]; out[1] += w * G.B[o + 1]; out[2] += w * G.B[o + 2];
  }
  return out;
}

// One direction of a field line by RK4 along the unit field, until it leaves
// r0 <= r <= rStop (1 and rss for PFSS). Returns points including the clipped
// boundary crossing, and which boundary: "sun" (or G.innerEnd) or "ss".
function traceDir(G, p0, sign, maxSteps = 4000) {
  const pts = [p0.slice()], v = [0, 0, 0], p = p0.slice();
  const rin = G.r0 ?? 1, rout = G.rStop ?? G.rss, inner = G.innerEnd ?? "sun";
  const k = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], q = [0, 0, 0];
  const dir = (x, y, z, o) => {
    sample(G, x, y, z, v);
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    o[0] = sign * v[0] / n; o[1] = sign * v[1] / n; o[2] = sign * v[2] / n;
  };
  for (let s = 0; s < maxSteps; s++) {
    const r = Math.hypot(p[0], p[1], p[2]), h = 0.012 * r;
    dir(p[0], p[1], p[2], k[0]);
    for (let i = 0; i < 3; i++) q[i] = p[i] + 0.5 * h * k[0][i];
    dir(q[0], q[1], q[2], k[1]);
    for (let i = 0; i < 3; i++) q[i] = p[i] + 0.5 * h * k[1][i];
    dir(q[0], q[1], q[2], k[2]);
    for (let i = 0; i < 3; i++) q[i] = p[i] + h * k[2][i];
    dir(q[0], q[1], q[2], k[3]);
    const nx = [0, 1, 2].map((i) => p[i] + (h / 6) * (k[0][i] + 2 * k[1][i] + 2 * k[2][i] + k[3][i]));
    const rn = Math.hypot(nx[0], nx[1], nx[2]);
    if (rn <= rin || rn >= rout) {
      // Clip the last step at the boundary it crossed.
      const bound = rn <= rin ? rin : rout, t = (bound - r) / ((rn - r) || 1e-9);
      pts.push(p.map((x, i) => x + Math.max(0, Math.min(1, t)) * (nx[i] - x)));
      return { pts, end: rn <= rin ? inner : "ss" };
    }
    p[0] = nx[0]; p[1] = nx[1]; p[2] = nx[2];
    pts.push(p.slice());
  }
  return { pts, end: "none" };
}

export function trace(G, p0) {
  const f = traceDir(G, p0, 1), b = traceDir(G, p0, -1);
  const pts = b.pts.slice(1).reverse().concat(f.pts);
  return { pts, ends: [b.end, f.end] };
}

function resample(pts, step = 0.02, nmax = 160) {
  if (pts.length < 3) return pts;
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const tot = s[s.length - 1], n = Math.max(6, Math.min(nmax, Math.floor(tot / step)));
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = tot * i / (n - 1);
    while (j < s.length - 2 && s[j + 1] < t) j++;
    const w = (t - s[j]) / ((s[j + 1] - s[j]) || 1);
    out.push([0, 1, 2].map((c) => pts[j][c] + w * (pts[j + 1][c] - pts[j][c])));
  }
  return out;
}

// Resampled with spacing proportional to the distance from the Sun (frac r),
// for lines running far out: fine near the Sun, coarse far away.
function resampleLog(pts, frac = 0.015, nmax = 180) {
  if (pts.length < 3) return pts;
  const s = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    s.push(s[i - 1] + 2 * d / (Math.hypot(...pts[i]) + Math.hypot(...pts[i - 1])));
  }
  const tot = s[s.length - 1], n = Math.max(6, Math.min(nmax, Math.ceil(tot / frac) + 1)), out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = tot * i / (n - 1);
    while (j < s.length - 2 && s[j + 1] < t) j++;
    const w = (t - s[j]) / ((s[j + 1] - s[j]) || 1);
    out.push([0, 1, 2].map((c) => pts[j][c] + w * (pts[j + 1][c] - pts[j][c])));
  }
  return out;
}

const cart = (r, lonDeg, latDeg) => {
  const lo = lonDeg * DEG, la = latDeg * DEG;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
};

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Seeds: equal area and |B|^1.5-weighted near the surface, plus an equal-area
// set just inside the source surface so open field is sampled evenly.
function seeds(br, ny, nx, rss, nU = 260, nF = 220, nO = 260) {
  const out = [], golden = Math.PI * (1 + Math.sqrt(5));
  for (let k = 0; k < nU; k++) { const t = k + 0.5; out.push(cart(1.05, (golden * t / DEG) % 360, Math.asin(1 - 2 * t / nU) / DEG)); }
  const w = new Float64Array(ny * nx); let tot = 0;
  for (let i = 0; i < ny * nx; i++) { w[i] = Math.pow(Math.abs(br[i]), 1.5); tot += w[i]; }
  const rand = rng(1), taken = new Set();
  for (let k = 0; k < nF && tot > 0; k++) {
    let u = rand() * tot, i = 0;
    while (i < w.length - 1 && u > w[i]) { u -= w[i]; i++; }
    if (taken.has(i)) { k--; if (taken.size >= ny * nx) break; continue; }
    taken.add(i); tot -= w[i]; w[i] = 0;
    const iy = Math.floor(i / nx), ix = i % nx;
    out.push(cart(1.05, (ix + 0.5) * 360 / nx, Math.asin(-1 + (2 * iy + 1) / ny) / DEG));
  }
  for (let k = 0; k < nO; k++) { const t = k + 0.5; out.push(cart(rss * 0.98, ((golden * t / DEG) + 7) % 360, Math.asin(1 - 2 * t / nO) / DEG)); }
  return out;
}

// Source-surface B_r on an equirectangular grid (lat rows south first).
export function surfaceBr(coef, r, rss, nlat = 180, nlon = 360, sinlat = false) {
  const { C, S, L } = coef, W = L + 1, out = new Float32Array(nlat * nlon), P = new Float64Array(W * W);
  const fl = new Float64Array(W);
  for (let l = 1; l <= L; l++) fl[l] = radial(l, r, rss).f;
  const am = new Float64Array(W), bm = new Float64Array(W);
  for (let i = 0; i < nlat; i++) {
    const mu = sinlat ? -1 + (2 * i + 1) / nlat : Math.sin((-90 + (i + 0.5) * 180 / nlat) * DEG);
    alf(mu, L, P);
    am.fill(0); bm.fill(0);
    for (let l = 1; l <= L; l++) for (let m = 0; m <= l; m++) {
      am[m] += C[l * W + m] * P[l * W + m] * fl[l]; bm[m] += S[l * W + m] * P[l * W + m] * fl[l];
    }
    for (let j = 0; j < nlon; j++) {
      const ph = (j + 0.5) * TAU / nlon; let v = 0;
      for (let m = 0; m <= L; m++) v += am[m] * Math.cos(m * ph) + bm[m] * Math.sin(m * ph);
      out[i * nlon + j] = v;
    }
  }
  return out;
}

// Zero contour of an equirectangular field (south-first rows), longitude
// periodic. Returns polylines as flat [lon, lat, lon, lat, ...].
export function zeroContour(F, nlat, nlon) {
  const lon = (j) => (j + 0.5) * 360 / nlon, lat = (i) => -90 + (i + 0.5) * 180 / nlat;
  const val = (i, j) => F[i * nlon + ((j % nlon) + nlon) % nlon];
  const segs = [];
  const cross = (i0, j0, i1, j1) => {
    const a = val(i0, j0), b = val(i1, j1), t = a / (a - b);
    return [lon(j0) + t * (lon(j1) - lon(j0)), lat(i0) + t * (lat(i1) - lat(i0))];
  };
  for (let i = 0; i < nlat - 1; i++) for (let j = 0; j < nlon; j++) {
    const v = [val(i, j), val(i, j + 1), val(i + 1, j + 1), val(i + 1, j)];
    const e = [];
    if ((v[0] > 0) !== (v[1] > 0)) e.push(cross(i, j, i, j + 1));
    if ((v[1] > 0) !== (v[2] > 0)) e.push(cross(i, j + 1, i + 1, j + 1));
    if ((v[2] > 0) !== (v[3] > 0)) e.push(cross(i + 1, j + 1, i + 1, j));
    if ((v[3] > 0) !== (v[0] > 0)) e.push(cross(i + 1, j, i, j));
    if (e.length === 2) segs.push(e);
    else if (e.length === 4) { segs.push([e[0], e[1]]); segs.push([e[2], e[3]]); }
  }
  // Chain segments by shared endpoints (longitudes compared modulo 360).
  const key = (p) => `${(((Math.round(p[0] * 1e4) / 1e4) % 360) + 360) % 360}|${Math.round(p[1] * 1e4) / 1e4}`;
  const ends = new Map();
  segs.forEach((s, k) => { for (const p of s) { const kk = key(p); if (!ends.has(kk)) ends.set(kk, []); ends.get(kk).push(k); } });
  const used = new Uint8Array(segs.length), lines = [];
  for (let k0 = 0; k0 < segs.length; k0++) {
    if (used[k0]) continue;
    used[k0] = 1;
    let line = [segs[k0][0], segs[k0][1]];
    for (const fwd of [true, false]) {
      for (;;) {
        const tip = fwd ? line[line.length - 1] : line[0];
        const next = (ends.get(key(tip)) || []).find((k) => !used[k]);
        if (next === undefined) break;
        used[next] = 1;
        const s = segs[next], other = key(s[0]) === key(tip) ? s[1] : s[0];
        fwd ? line.push(other) : line.unshift(other);
      }
    }
    if (line.length > 2) lines.push(line.flatMap((p) => [+(((p[0] % 360) + 360) % 360).toFixed(2), +p[1].toFixed(2)]));
  }
  return lines;
}

// Equirectangular 8-bit texture, rows SOUTH first (as a WebGL DataTexture
// expects), from a sin(lat)-uniform map.
function textureFromSinLat(br, ny, nx, scale) {
  const out = new Uint8Array(180 * nx), src = new Float64Array(ny), col = new Float64Array(ny);
  for (let i = 0; i < ny; i++) src[i] = -1 + (2 * i + 1) / ny;
  for (let j = 0; j < nx; j++) {
    for (let i = 0; i < ny; i++) col[i] = br[i * nx + j];
    let k = 0;
    for (let i = 0; i < 180; i++) {
      const s = Math.sin((-90 + i + 0.5) * DEG);
      while (k < ny - 2 && src[k + 1] < s) k++;
      const t = Math.max(0, Math.min(1, (s - src[k]) / (src[k + 1] - src[k])));
      const v = Math.max(-1, Math.min(1, (col[k] + t * (col[k + 1] - col[k])) / scale));
      out[i * nx + j] = Math.round((v + 1) * 127.5);
    }
  }
  return out;
}
function textureFromEquirect(F, scale) {
  const out = new Uint8Array(F.length);
  for (let i = 0; i < F.length; i++) out[i] = Math.round((Math.max(-1, Math.min(1, F[i] / scale)) + 1) * 127.5);
  return out;
}

// Speeds mapped for connectivity (the slider's 300-800 km/s +-100) and the
// extra source surfaces for the footpoint spread; the daily build uses the
// same, so both paths produce the same product.
export const VGRID = Array.from({ length: 29 }, (_, i) => 200 + 25 * i);
export const RSS_ENS = [2.0, 3.0];
// The spread's source surfaces for any main one: 0.5 R_sun either side
// (RSS_ENS at the default 2.5), never below 1.3.
export const rssSpread = (rss) => [Math.max(1.3, rss - 0.5), rss + 0.5].map((r) => +r.toFixed(2));
const CH_STEP = 1;   // open/closed map resolution for DCHB [deg]

// WSA-type wind speed [km/s] from the expansion factor and the distance to
// the coronal-hole boundary [deg], in the form of Arge et al. (2003, 2004).
// Illustrative coefficients, not tuned; scripts/build_day.py uses the same.
export const wsaSpeed = (fs, dchb) => 285 + 625 / Math.pow(1 + fs, 2 / 9) * Math.pow(1 - 0.8 * Math.exp(-((dchb / 2) ** 2)), 3);

// Whether the field line from (lon, lat) just above the photosphere reaches
// the source surface: traced one way, outward along the local B_r, by RK2.
// Returns the footpoint's B_r sign (1 or -1) when open, 0 when closed.
function isOpen(G, lon, lat, v) {
  let [x, y, z] = cart(1.001, lon, lat);
  sample(G, x, y, z, v);
  const s = (v[0] * x + v[1] * y + v[2] * z) >= 0 ? 1 : -1;
  for (let k = 0; k < 3000; k++) {
    const h = 0.012 * Math.hypot(x, y, z);
    sample(G, x, y, z, v); let n = Math.hypot(v[0], v[1], v[2]) || 1;
    const mx = x + 0.5 * h * s * v[0] / n, my = y + 0.5 * h * s * v[1] / n, mz = z + 0.5 * h * s * v[2] / n;
    sample(G, mx, my, mz, v); n = Math.hypot(v[0], v[1], v[2]) || 1;
    x += h * s * v[0] / n; y += h * s * v[1] / n; z += h * s * v[2] / n;
    const r = Math.hypot(x, y, z);
    if (r >= (G.rStop ?? G.rss)) return s;
    if (r < 1) return 0;
  }
  return 0;
}

// Coronal-hole boundary as unit vectors: midpoints between neighbouring
// cells of a 1-degree photospheric grid where one cell is open and the other
// closed (longitude wraps). Also returns the open/closed map, the polarity
// of the open cells (1 outward, -1 inward) and the open fraction.
export function chBoundary(G) {
  const nlat = 180 / CH_STEP, nlon = 360 / CH_STEP, op = new Uint8Array(nlat * nlon), pol = new Int8Array(nlat * nlon), v = [0, 0, 0];
  let aOpen = 0, aAll = 0;   // area-weighted: rows are uniform in latitude
  for (let i = 0; i < nlat; i++) {
    const w = Math.cos((-90 + (i + 0.5) * CH_STEP) * DEG);
    for (let j = 0; j < nlon; j++) {
      const o = isOpen(G, (j + 0.5) * CH_STEP, -90 + (i + 0.5) * CH_STEP, v);
      pol[i * nlon + j] = o;
      aOpen += w * (op[i * nlon + j] = o ? 1 : 0);
      aAll += w;
    }
  }
  const pts = [];
  for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) {
    const lon = (j + 0.5) * CH_STEP, lat = -90 + (i + 0.5) * CH_STEP;
    if (op[i * nlon + j] !== op[i * nlon + (j + 1) % nlon]) pts.push(...cart(1, lon + CH_STEP / 2, lat));
    if (i + 1 < nlat && op[i * nlon + j] !== op[(i + 1) * nlon + j]) pts.push(...cart(1, lon, lat + CH_STEP / 2));
  }
  return { bound: Float64Array.from(pts), open: op, pol, openFraction: aOpen / aAll };
}

// Angle [deg] from (lon, lat) to the nearest boundary point.
function dchb(bound, lon, lat) {
  const u = cart(1, lon, lat);
  let best = -1;
  for (let k = 0; k < bound.length; k += 3) best = Math.max(best, u[0] * bound[k] + u[1] * bound[k + 1] + u[2] * bound[k + 2]);
  return Math.acos(Math.min(1, best)) / DEG;
}

const bMag = (G, p, v) => { sample(G, p[0], p[1], p[2], v); return Math.hypot(v[0], v[1], v[2]); };

// ------------------------------------------------------------------ SCS
// Schatten current-sheet model (Schatten 1972), coupled as in WSA: PFSS
// inside the cusp surface rcp, a little below the PFSS source surface where
// the field is not yet radial (McGregor et al. 2008); beyond it, the
// potential field of |B_r(rcp)|, which points outward everywhere, out to
// rout. Each line then takes back the sign of B_r where it crossed rcp, so
// the current sheets sit where neighbouring lines came from opposite
// polarity. rcp scales with the source surface: 2.3 R_sun at 2.5.
export const CUSP_FRAC = 0.92;
export const cusp = (rss) => +(CUSP_FRAC * rss).toFixed(3);

// The SCS field from rcp to rout. Between rcp and the source surface both
// solutions exist, and the field there is blended across the shell from
// the PFSS field, turned to point outward (its sign times B), into the SCS
// field. Field lines then turn smoothly instead of kinking at rcp; the
// unsigned flux changes by a fraction of a percent in the shell (see the
// guide). The shell has its own finer grid, sampled below rss.
export function scsGrid(coef, rss, rcp, rout, { nr = 40, nrShell = 14, blend = true, progress } = {}) {
  const ny = 180, nx = 360, abs = surfaceBr(coef, rcp, rss, ny, nx, true).map(Math.abs);
  const a = analyse(abs, ny, nx, coef.L, { mono: true });
  const ext = exterior(rcp);
  if (!blend || rss <= rcp) {
    const S = fieldGrid(a, { r0: rcp, r1: rout, radialFn: ext, nr, progress });
    S.innerEnd = "cp";
    return S;
  }
  const S = fieldGrid(a, { r0: rss, r1: rout, radialFn: ext, nr, progress: (f) => progress?.(0.6 + 0.4 * f) });
  const sh = fieldGrid(a, { r0: rcp, r1: rss, radialFn: ext, nr: nrShell });
  const P = fieldGrid(coef, { rss, r0: rcp, r1: rss, nr: nrShell, progress: (f) => progress?.(0.6 * f) });
  const { nth, nph } = sh;
  for (let ir = 0; ir < nrShell; ir++) {
    const t = ir / (nrShell - 1), w = t * t * (3 - 2 * t);       // smoothstep, 0 at rcp, 1 at rss
    for (let k = 0; k < nth; k++) {
      const th = (k + 0.5) * Math.PI / nth, st = Math.sin(th), ct = Math.cos(th);
      for (let p = 0; p < nph; p++) {
        const ph = p * TAU / nph, o = 3 * ((ir * nth + k) * nph + p);
        const ux = st * Math.cos(ph), uy = st * Math.sin(ph), uz = ct;
        const sg = P.B[o] * ux + P.B[o + 1] * uy + P.B[o + 2] * uz >= 0 ? 1 : -1;
        for (let c = 0; c < 3; c++) sh.B[o + c] = (1 - w) * sg * P.B[o + c] + w * sh.B[o + c];
      }
    }
  }
  S.near = sh;
  S.r0 = rcp;
  S.innerEnd = "cp";
  return S;
}

// Sign of the PFSS B_r at a point on the cusp surface.
function cuspSign(G, p, v) {
  sample(G, p[0], p[1], p[2], v);
  return (v[0] * p[0] + v[1] * p[1] + v[2] * p[2]) >= 0 ? 1 : -1;
}

// Polarity (+1/-1) of the coupled field at (lon, lat) on the sphere of
// radius r between rcp and rout: traced in along the SCS field to the cusp
// surface. 0 when the line does not get there.
export function scsPolarity(m, r, lon, lat) {
  const t = traceDir(m.S, cart(r, lon, lat), -1, 6000);
  return t.end === "cp" ? cuspSign(m.G, t.pts[t.pts.length - 1], [0, 0, 0]) : 0;
}

// The current sheet between rcp and rout: field lines traced outward from
// the cusp-surface neutral line, along which the opposite polarities meet.
// Each rib is sampled at nRib radii spaced evenly in ln r, as flat
// [lon, lat, r, ...]; their outer ends give the neutral line at rout.
function hcsRibs(S, hcs, rcp, rout, nRib = 24) {
  const radii = Array.from({ length: nRib }, (_, j) => rcp * Math.pow(rout / rcp, j / (nRib - 1)));
  const ribs = [], out = [];
  for (const h of hcs) {
    const n = h.length / 2, step = Math.max(1, Math.floor(n / 220)), R = [], O = [];
    for (let i = 0; i < n; i += step) {
      const t = traceDir(S, cart(rcp * 1.001, h[2 * i], h[2 * i + 1]), 1, 6000);
      if (t.end !== "ss") continue;
      const rib = [];
      let k = 0;
      for (const r of radii) {
        while (k < t.pts.length - 2 && Math.hypot(...t.pts[k + 1]) < r) k++;
        const a = t.pts[k], b = t.pts[k + 1] || a, ra = Math.hypot(...a), rb = Math.hypot(...b);
        const w = Math.max(0, Math.min(1, (r - ra) / ((rb - ra) || 1))), q = [0, 1, 2].map((c) => a[c] + w * (b[c] - a[c]));
        const rr = Math.hypot(...q);
        rib.push(+(((Math.atan2(q[1], q[0]) / DEG) + 360) % 360).toFixed(3), +(Math.asin(q[2] / rr) / DEG).toFixed(3), +r.toFixed(4));
      }
      R.push(rib);
      O.push(rib[rib.length - 3], rib[rib.length - 2]);
    }
    if (R.length >= 2) { ribs.push(R); out.push(O); }
  }
  return { ribs, out };
}

// A field grid and its coronal-hole boundary for one source surface, with
// the SCS field beyond its cusp surface when rout is set. With SCS, a line
// is open once it reaches the cusp surface.
export function model(coef, rss, { rout = 0, progress } = {}) {
  const G = fieldGrid(coef, { rss, progress });
  if (!rout) return { G, rss, ...chBoundary(G) };
  const rcp = cusp(rss);
  G.rStop = rcp;
  const S = scsGrid(coef, rss, rcp, rout);
  return { G, S, rss, rcp, rout, ...chBoundary(G) };
}

// A PFSS line that reached the cusp surface, continued outward through the
// SCS field to rout. pts run photosphere first.
function continueScs(S, pts) {
  const e = pts[pts.length - 1], r = Math.hypot(...e), f = (S.r0 * 1.0005) / r;
  const t = traceDir(S, e.map((x) => x * f), 1, 6000);
  return t.end === "ss" ? t.pts : null;
}

// Everything the viewer draws, in the same shape as a daily product.
// fleet: { key: { name, planet, lon, lat, r } } at the requested time.
// rout > 0 couples the SCS model out to rout [R_sun]; 0 is PFSS alone.
// Returns the solved models too ([main, ...spread]) for connectOnly, and the
// harmonic coefficients, which a re-solve of the same map at another source
// surface can pass back in as `coef` to skip the expansion.
export function solve(br, ny, nx, { rss = 2.5, rout = 0, L = 40, vsw = [300, 400, 500, 600, 700, 800], fleet = {}, coef = null, progress = () => {} } = {}) {
  const t0 = Date.now();
  progress("harmonics", 0);
  coef ??= analyse(br, ny, nx, L);
  progress("field", 0.05);
  const G = fieldGrid(coef, { rss, progress: (f) => progress("field", 0.05 + (rout ? 0.15 : 0.3) * f) });
  const rcp = rout ? cusp(rss) : 0, rIn = rcp || rss;
  let S = null;
  if (rout) {
    G.rStop = rcp;
    S = scsGrid(coef, rss, rcp, rout, { progress: (f) => progress("field", 0.2 + 0.15 * f) });
  }

  progress("lines", 0.35);
  const polys = [], kind = [], v = [0, 0, 0], sd = seeds(br, ny, nx, rIn);
  sd.forEach((p, i) => {
    const t = trace(G, p);
    if (t.pts.length >= 3 && t.ends.includes("sun")) {
      const open = t.ends.includes("ss");
      const pts = t.ends[0] === "sun" ? t.pts : t.pts.slice().reverse(), foot = pts[0];
      sample(G, foot[0], foot[1], foot[2], v);
      const brFoot = (v[0] * foot[0] + v[1] * foot[1] + v[2] * foot[2]) / Math.hypot(...foot);
      kind.push(open ? (brFoot > 0 ? 1 : -1) : 0);
      // Beyond the cusp surface the spacing can grow with distance.
      const out = open && S ? continueScs(S, pts) : null;
      polys.push(out ? resample(pts).concat(resampleLog(out).slice(1)) : resample(pts));
    }
    if (i % 40 === 0) progress("lines", 0.35 + 0.15 * i / sd.length);
  });

  // The surface drawn as the source surface, its neutral line and the open
  // flux are at the cusp surface with SCS: the SCS field carries the same
  // unsigned flux out to rout.
  progress("surface", 0.5);
  const ss = surfaceBr(coef, rIn, rss);
  const abs = Array.from(ss, Math.abs).sort((a, b) => a - b);
  const ssScale = abs[Math.floor(0.995 * (abs.length - 1))] || 1;
  let flux = 0;
  for (let i = 0; i < 180; i++) {
    const w = Math.cos((-90 + i + 0.5) * DEG) * (DEG) * (DEG) * Math.pow(rIn * RSUN_CM, 2);
    for (let j = 0; j < 360; j++) flux += Math.abs(ss[i * 360 + j]) * w;
  }
  const hcs = zeroContour(ss, 180, 360);
  const sheet = S ? hcsRibs(S, hcs, rcp, rout) : null;

  // Coronal holes for this and the other source surfaces, for the footpoint
  // diagnostics and their spread.
  progress("holes", 0.55);
  const models = [S ? { G, S, rss, rcp, rout, ...chBoundary(G) } : { G, rss, ...chBoundary(G) }];
  rssSpread(rss).forEach((r, k) => {
    progress("holes", 0.65 + 0.15 * k);
    models.push(model(coef, r, { rout }));
  });

  progress("connect", 0.95);
  const { connect, conn, ensemble } = connectOnly(models, fleet);
  progress("done", 1);
  return {
    polys: polys.concat(conn),
    meta: {
      model: rout
        ? { name: "PFSS + SCS", code: "HelioField in-browser solver", rss, rcp, rout, lmax: L }
        : { name: "PFSS", code: "HelioField in-browser solver", rss, lmax: L },
      br_scale: 20, ss_scale: +ssScale.toFixed(4), open_flux_Mx: +flux.toExponential(4),
      lines: { count: polys.length, kind }, counts: polys.concat(conn).map((p) => p.length),
      hcs, ...(sheet ? { hcs_out: sheet.out, hcs_ribs: sheet.ribs } : {}),
      vsw, vgrid: VGRID, fleet, connect, ensemble, seconds: (Date.now() - t0) / 1000,
    },
    brTex: textureFromSinLat(br, ny, nx, 20),
    ssTex: textureFromEquirect(ss, ssScale),
    // Open-field footprints in the daily products' classes (0 closed,
    // 128 open inward, 255 open outward), 1-degree rows south first.
    footTex: Uint8Array.from(models[0].pol, (p) => (p > 0 ? 255 : p < 0 ? 128 : 0)),
    models, coef,
  };
}

// Connectivity: each body joined to the model's outer boundary (the source
// surface, or rout with SCS) along a ballistic Parker spiral at every speed
// in VGRID, then the model field line from there down to the photosphere,
// with the source diagnostics at its foot:
//   fs   = (|B_phot| / |B_top|) (R_sun / R_top)^2   expansion factor, R_top
//          the source surface for PFSS and the cusp surface with SCS
//   dchb = angle to the nearest coronal-hole boundary [deg]
//   vwsa = wsaSpeed(fs, dchb)
// models[0] gives the drawn lines and `connect`; the others only footpoints
// and diagnostics, in `ensemble`. Also used alone for a new date inside an
// already solved rotation.
export function connectOnly(models, fleet) {
  const v = [0, 0, 0];
  const one = (m, b, vs, lines) => {
    const rRs = b.r * AU_RS, rEdge = m.rout || m.rss;
    const lon = (b.lon + (OMEGA * (rRs - rEdge) * RSUN_KM / vs) / DEG) % 360, lat = Math.max(-89, Math.min(89, b.lat));
    let pts = [], top = cart(m.rss, lon, lat), rTop = m.rss, ok = false;
    if (m.S) {
      // In along the SCS field to the cusp surface, then down through PFSS.
      const s = traceDir(m.S, cart(rEdge * 0.995, lon, lat), -1, 6000);
      if (s.end === "cp") {
        const e = s.pts[s.pts.length - 1], f = (m.rcp * 0.995) / Math.hypot(...e);
        top = e; rTop = m.rcp;
        const t = trace(m.G, e.map((x) => x * f));
        let low = t.pts;
        if (low.length && Math.hypot(...low[0]) > Math.hypot(...low[low.length - 1])) low = low.slice().reverse();
        pts = low.concat(s.pts.slice().reverse());
        ok = t.ends.includes("sun");
      } else pts = s.pts.slice().reverse();
    } else {
      const t = trace(m.G, cart(m.rss * 0.995, lon, lat));
      pts = t.pts;
      if (pts.length && Math.hypot(...pts[0]) > Math.hypot(...pts[pts.length - 1])) pts = pts.slice().reverse();
      ok = t.ends.includes("sun");
    }
    const c = { ss: [+lon.toFixed(3), +lat.toFixed(3)], foot: null, fs: null, dchb: null, vwsa: null };
    if (pts.length && ok) {
      const f = pts[0], rr = Math.hypot(...f);
      const flon = ((Math.atan2(f[1], f[0]) / DEG) + 360) % 360, flat = Math.asin(f[2] / rr) / DEG;
      const fs = bMag(m.G, cart(1, flon, flat), v) / bMag(m.G, top, v) / (rTop * rTop);
      const d = dchb(m.bound, flon, flat);
      Object.assign(c, { foot: [+flon.toFixed(2), +flat.toFixed(2)], fs: +fs.toFixed(2), dchb: +d.toFixed(2), vwsa: +wsaSpeed(fs, d).toFixed(1) });
    }
    return { c, line: lines ? (pts.length > 2 ? (m.S ? resampleLog(pts, 0.02, 220) : resample(pts, 0.03, 80)) : pts) : null };
  };
  const connect = [], conn = [], foot = models.slice(1).map(() => []);
  for (const [key, b] of Object.entries(fleet)) {
    if (b.planet || b.lon == null) continue;
    for (const vs of VGRID) {
      const { c, line } = one(models[0], b, vs, true);
      connect.push({ body: key, v: vs, ...c });
      conn.push(line);
      models.slice(1).forEach((m, k) => {
        const e = one(m, b, vs, false).c;
        foot[k].push(e.foot ? [...e.foot, e.fs, e.dchb, e.vwsa] : null);
      });
    }
  }
  return { connect, conn, ensemble: { rss: models.slice(1).map((m) => m.rss), foot } };
}
