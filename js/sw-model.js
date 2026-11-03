// Space-weather indicators for spaceweather.html. Pure functions (no DOM),
// tested from Python through tests/test_spaceweather.py.
//
// Everything works in the Carrington frame of the daily product: rings are
// 360 values, element j centred on Carrington longitude j + 0.5 deg, as in
// the PNGs (north row first, row i centred on latitude 89.5 - i).

export const RSUN_KM = 695700, AU_KM = 149597870.7, AU_RS = AU_KM / RSUN_KM;
export const OMEGA = 2 * Math.PI / (25.38 * 86400);       // sidereal rotation [rad/s]
export const SYNODIC_DAYS = 27.2753;                      // Carrington rotation seen from Earth
export const RATE = 360 / SYNODIC_DAYS;                   // Earth's Carrington longitude falls this fast [deg/day]
const DEG = Math.PI / 180, DAY = 86400000;
export const wrap = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => ((a + 540) % 360) - 180;

// ------------------------------------------------------------- grids
// Value of a 360 x 180 grid (north row first) at a latitude, linear between
// rows, for every longitude column. Cells holding NaN are filled from their
// nearest valid neighbours along the ring.
export function ringAt(grid, lat) {
  const y = Math.max(0, Math.min(179, 89.5 - lat)), i0 = Math.floor(y), i1 = Math.min(179, i0 + 1), f = y - i0;
  const out = new Float64Array(360);
  for (let j = 0; j < 360; j++) {
    const a = grid[i0 * 360 + j], b = grid[i1 * 360 + j];
    out[j] = Number.isFinite(a) && Number.isFinite(b) ? a + f * (b - a) : Number.isFinite(a) ? a : b;
  }
  return fillRing(out);
}
function fillRing(r) {
  if (r.every((v) => !Number.isFinite(v))) return r.fill(NaN);
  const out = Float64Array.from(r);
  for (let j = 0; j < 360; j++) {
    if (Number.isFinite(r[j])) continue;
    for (let k = 1; k < 180; k++) {
      const a = r[(j + k) % 360], b = r[(j - k + 360) % 360];
      if (Number.isFinite(a) || Number.isFinite(b)) { out[j] = Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : Number.isFinite(a) ? a : b; break; }
    }
  }
  return out;
}
// Linear interpolation on a ring at any Carrington longitude.
export function ringValue(ring, lon) {
  const x = wrap(lon) - 0.5, j0 = Math.floor(x), f = x - j0;
  const a = ring[(j0 + 360) % 360], b = ring[(j0 + 1) % 360];
  return a + f * (b - a);
}

// ------------------------------------------------------------- HUX
// Upwind kinematic propagation of the solar wind in the corotating frame
// (HUX, Riley & Lionello 2011, without the residual-acceleration term):
//   v(r + dr, phi) = v(r, phi) + (Omega dr / v) dv/dphi,
// stepping out from r0 to r1 [R_sun]. Faster wind catches slower wind and
// steepens into stream interfaces, which ballistic mapping cannot. Tracers
// (here the source-surface polarity and the source longitude) ride along the
// same characteristics. Returns rings at r1: { v, q: [...tracers] }.
export function hux(v0, r0, r1, tracers = [], dr = 1) {
  const n = v0.length, dphi = 2 * Math.PI / n;
  let v = Float64Array.from(v0), q = tracers.map((t) => Float64Array.from(t));
  const steps = Math.max(1, Math.ceil((r1 - r0) / dr)), h = (r1 - r0) / steps * RSUN_KM;
  for (let s = 0; s < steps; s++) {
    const nv = new Float64Array(n), nq = q.map(() => new Float64Array(n));
    for (let j = 0; j < n; j++) {
      const up = (j + 1) % n, c = Math.min(1, OMEGA * h / v[j] / dphi);    // Courant number, <= 1 for v >= 116 km/s
      nv[j] = v[j] + c * (v[up] - v[j]);
      for (let k = 0; k < q.length; k++) nq[k][j] = q[k][j] + c * (q[k][up] - q[k][j]);
    }
    v = nv; q = nq;
  }
  return { v, q };
}

// Propagate the source-surface ring at one latitude to a body at r_au:
// speed, polarity (sign of the advected source-surface field) and the
// Carrington longitude on the source surface the wind left from.
export function propagate(vRing, bRing, rss, rAu) {
  const cos = vRing.map((_, j) => Math.cos((j + 0.5) * DEG)), sin = vRing.map((_, j) => Math.sin((j + 0.5) * DEG));
  const out = hux(vRing, rss, rAu * AU_RS, [bRing, cos, sin]);
  return { v: out.v, b: out.q[0], cos: out.q[1], sin: out.q[2], src: out.q[1].map((c, j) => wrap(Math.atan2(out.q[2][j], c) / DEG)) };
}

// Earth's Carrington longitude at time t, from its value lon0 at t0.
export const earthLon = (lon0, t0, t) => wrap(lon0 - RATE * (t - t0) / DAY);

// Time series at a body that stays at Carrington longitude lon0 - RATE dt
// (Earth and the L1 monitors): speed, polarity, source longitude, and how
// old the magnetogram data at that source are. A synoptic map is refreshed
// as longitudes pass from about 60 deg east of central meridian onwards, so
// a source longitude was last updated wrap(src - (L0 - 60)) / RATE days
// before t0.
export function series(rings, lon0, t0, from, to, stepMs = 3600000 * 2) {
  const out = [];
  for (let t = from; t <= to; t += stepMs) {
    const lon = earthLon(lon0, t0, t), src = wrap(Math.atan2(ringValue(rings.sin, lon), ringValue(rings.cos, lon)) / DEG);
    out.push({ t, lon, v: ringValue(rings.v, lon), b: ringValue(rings.b, lon), src,
      age: wrap(src - (lon0 - 60)) / RATE });
  }
  return out;
}

// Sector boundaries in a time series: where the polarity changes sign.
export function crossings(ser) {
  const out = [];
  for (let k = 1; k < ser.length; k++) {
    const a = ser[k - 1], b = ser[k];
    if (Math.sign(a.b) !== Math.sign(b.b) && a.b && b.b) {
      const f = a.b / (a.b - b.b);
      out.push({ t: a.t + f * (b.t - a.t), to: b.b > 0 ? 1 : -1 });
    }
  }
  return out;
}

// High-speed streams: runs of the series above vmin, with the time and
// speed of each peak.
export function streams(ser, vmin = 500) {
  const out = [];
  let cur = null;
  for (const p of ser) {
    if (p.v >= vmin) {
      if (!cur) cur = { start: p.t, peak: p };
      if (p.v > cur.peak.v) cur.peak = p;
      cur.end = p.t;
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

export const windClass = (v) => (v < 400 ? "slow" : v < 550 ? "intermediate" : "fast");

// ------------------------------------------------------------- IMF at 1 au
// Interplanetary field magnitude from the model's open flux, if |B_r| r^2 is
// the same at all latitudes (Ulysses): |B_r| = Phi / (4 pi r^2), wound into
// a Parker spiral at speed v. Phi [Mx], r [au], v [km/s]; returns nT.
export function imfStrength(openFluxMx, rAu, v, latDeg = 0) {
  const r = rAu * AU_KM * 1e5, br = openFluxMx / (4 * Math.PI * r * r) * 1e5;       // G -> nT
  const tanPsi = OMEGA * rAu * AU_KM * Math.cos(latDeg * DEG) / v;
  return { br, b: br * Math.hypot(1, tanPsi), spiralDeg: Math.atan(tanPsi) / DEG };
}

// ------------------------------------------------------------- Russell-McPherron
// The southward (GSM) share of an ideal Parker-spiral field at Earth, for a
// date and hour: the reason sectors pointing towards the Sun are more
// geoeffective around the March equinox and those pointing away around the
// September equinox (Russell & McPherron 1973). Low-precision solar
// coordinates (Astronomical Almanac), the IAU solar pole and an IGRF-like
// centred dipole are ample for an angle of a few degrees' importance.
const SOLAR_POLE = { ra: 286.13, dec: 63.87 };          // IAU, J2000 equatorial
const DIPOLE_POLE = { lat: 80.8, lon: -72.6 };          // northern geomagnetic pole, IGRF 2025
const jdN = (ms) => ms / DAY + 2440587.5 - 2451545.0;
function eqToEcl([x, y, z], eps) {
  const c = Math.cos(eps * DEG), s = Math.sin(eps * DEG);
  return [x, y * c + z * s, -y * s + z * c];
}
const vec = (ra, dec) => [Math.cos(dec * DEG) * Math.cos(ra * DEG), Math.cos(dec * DEG) * Math.sin(ra * DEG), Math.sin(dec * DEG)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };

export function sunLongitude(ms) {
  const n = jdN(ms), L = 280.460 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * DEG;
  return { lam: wrap(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)), eps: 23.439 - 4e-7 * n };
}

// Bz (GSM) / |B| for polarity pol (+1 away from the Sun, -1 towards) at time
// ms, speed v [km/s] and distance r [au].
export function bzShare(ms, pol, v = 400, rAu = 1) {
  const { lam, eps } = sunLongitude(ms);
  const e = [-Math.cos(lam * DEG), -Math.sin(lam * DEG), 0];          // Sun -> Earth, ecliptic
  const S = eqToEcl(vec(SOLAR_POLE.ra, SOLAR_POLE.dec), eps);
  const sxe = cross(S, e), sinT = Math.hypot(...sxe), phi = sxe.map((x) => x / sinT);
  const tanPsi = OMEGA * rAu * AU_KM * sinT / v;
  const B = norm(e.map((x, k) => pol * (x - tanPsi * phi[k])));
  const gmst = 280.46061837 + 360.98564736629 * jdN(ms);
  const D = eqToEcl(vec(gmst + DIPOLE_POLE.lon, DIPOLE_POLE.lat), eps), X = e.map((x) => -x);
  const Z = norm(D.map((x, k) => x - dot(D, X) * X[k]));
  return dot(B, Z);
}

// Over one UTC day: the mean, and the most southward hour.
export function bzDay(dayMs, pol, v = 400, rAu = 1) {
  let sum = 0, min = Infinity, at = 0;
  for (let h = 0; h < 24; h++) {
    const s = bzShare(dayMs + h * 3600000 + 1800000, pol, v, rAu);
    sum += s;
    if (s < min) { min = s; at = h; }
  }
  return { mean: sum / 24, min, minHour: at };
}

// ------------------------------------------------------------- geometry
// Great-circle angle [deg] between two (lon, lat) directions.
export function angle(lon1, lat1, lon2, lat2) {
  const c = Math.sin(lat1 * DEG) * Math.sin(lat2 * DEG) + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon1 - lon2) * DEG);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

// "N08W54" -> Stonyhurst { lat: 8, lon: 54 } (west positive).
export function parseLocation(s) {
  const m = /^([NS])(\d+)([EW])(\d+)$/.exec(String(s || "").trim().toUpperCase());
  return m ? { lat: (m[1] === "N" ? 1 : -1) * +m[2], lon: (m[3] === "W" ? 1 : -1) * +m[4] } : null;
}
export const stonyhurst = (lon, lat) => `${lat >= 0 ? "N" : "S"}${String(Math.round(Math.abs(lat))).padStart(2, "0")}${wrap180(lon) >= 0 ? "W" : "E"}${String(Math.round(Math.abs(wrap180(lon)))).padStart(2, "0")}`;

// Magnetic connection of a flare site to a footpoint, by angular distance.
export const connection = (deg) => (deg <= 30 ? "good" : deg <= 60 ? "partial" : "poor");

// ------------------------------------------------------------- CMEs
// Drag-based model (Vrsnak et al. 2013): a CME launched at speed v0 from r0
// decelerates or accelerates towards the ambient wind speed w,
//   r(t) = (s / gamma) ln(1 + s gamma (v0 - w) t) + w t + r0,  s = sign(v0 - w).
// Distances in km, speeds in km/s, gamma in 1/km. Returns the transit time
// [s] to r1 and the arrival speed.
export function dbm(v0, w, r0, r1, gamma = 0.2e-7) {
  const d = v0 - w, s = d >= 0 ? 1 : -1;
  const r = (t) => (d === 0 ? 0 : (s / gamma) * Math.log(1 + s * gamma * d * t)) + w * t + r0;
  let lo = 0, hi = 1;
  while (r(hi) < r1 && hi < 1e8) hi *= 2;
  for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (r(m) < r1) lo = m; else hi = m; }
  const t = (lo + hi) / 2;
  return { t, v: d / (1 + s * gamma * d * t) + w };
}

// Whether a CME cone (Stonyhurst lon, lat, half-width) reaches a body.
export function cmeGeometry(cme, body) {
  const a = angle(cme.lon, cme.lat, body.lon, body.lat);
  return { deg: a, hit: a <= cme.half ? "inside" : a <= cme.half + 15 ? "flank" : "miss" };
}

// ------------------------------------------------------------- coronal holes
// Open-field regions on a 360 x 180 class grid (north row first; > 0 open
// outward, < 0 open inward, 0 closed), 8-connected with longitude wrapping.
// For each region: polarity, area as a share of the solar surface, and the
// same for its part within lowLat of the equator, whose wind reaches the
// ecliptic, with that part's centroid.
export function openRegions(cls, lowLat = 35) {
  const seen = new Uint8Array(360 * 180), out = [];
  const w = (i) => Math.cos((89.5 - i) * DEG) * (Math.PI / 180) ** 2 / (4 * Math.PI);    // cell area / sphere
  for (let start = 0; start < cls.length; start++) {
    if (!cls[start] || seen[start]) continue;
    const pol = Math.sign(cls[start]), stack = [start];
    seen[start] = 1;
    let area = 0, low = 0, cx = 0, cy = 0, cz = 0, latMin = 90;
    while (stack.length) {
      const p = stack.pop(), i = Math.floor(p / 360), j = p % 360, lat = 89.5 - i;
      area += w(i);
      if (Math.abs(lat) <= lowLat) {
        const lon = (j + 0.5) * DEG, a = w(i);
        low += a; cx += a * Math.cos(lat * DEG) * Math.cos(lon); cy += a * Math.cos(lat * DEG) * Math.sin(lon); cz += a * Math.sin(lat * DEG);
      }
      latMin = Math.min(latMin, Math.abs(lat));
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ii = i + di;
        if (ii < 0 || ii > 179 || (!di && !dj)) continue;
        const q = ii * 360 + ((j + dj + 360) % 360);
        if (!seen[q] && Math.sign(cls[q]) === pol) { seen[q] = 1; stack.push(q); }
      }
    }
    const reg = { pol, area, lowArea: low, latMin };
    if (low > 0) { reg.lon = wrap(Math.atan2(cy, cx) / DEG); reg.lat = Math.atan2(cz, Math.hypot(cx, cy)) / DEG; }
    out.push(reg);
  }
  return out.sort((a, b) => b.lowArea - a.lowArea);
}

// When wind from Carrington longitude lon at speed v reaches a body that
// stays at lon0 - RATE dt (Earth): dt [days] in (-from, 27.3 - from].
export function arrivalDays(lon, lon0, v, rAu = 1, rss = 2.5, from = 5) {
  const lag = OMEGA * (rAu * AU_RS - rss) * RSUN_KM / v / DEG;    // spiral winding [deg]
  let d = wrap(lon0 + lag - lon) / RATE;
  if (d > SYNODIC_DAYS - from) d -= SYNODIC_DAYS;
  return d;
}

// ------------------------------------------------------------- connections
// The speed a body is connected at, as on the connectivity page: start at
// v, map to the footpoint, take its WSA-type speed, repeat until it settles
// (or, in a cycle, the member closest to its own speed).
export function selfConsistent(rows, v = 400) {
  const byV = new Map(rows.map((r) => [r.v, r]));
  const seen = [];
  for (let k = 0; k < 30; k++) {
    const r = byV.get(v);
    if (!r?.vwsa) return v;
    const next = Math.max(200, Math.min(900, Math.round(r.vwsa / 25) * 25));
    if (next === v) return v;
    if (seen.includes(next)) {
      const cyc = seen.slice(seen.indexOf(next)).concat(v);
      return cyc.reduce((a, b) => (Math.abs((byV.get(a)?.vwsa ?? 1e9) - a) <= Math.abs((byV.get(b)?.vwsa ?? 1e9) - b) ? a : b));
    }
    seen.push(v); v = next;
  }
  return v;
}

// ------------------------------------------------------------- one day
// In-situ spacecraft, in the order shown. The L1 monitors (ACE, Wind,
// DSCOVR, IMAP, SWFO-L1, Aditya-L1) sit with Earth on this scale.
export const BODIES = [["earth", "Earth / L1"], ["psp", "Parker Solar Probe"], ["solo", "Solar Orbiter"], ["sta", "STEREO-A"], ["bepi", "BepiColombo"]];
const noon = (day) => Date.parse(day + "T12:00:00Z");

// Everything the page and the daily record derive from one product:
// d = { day, meta, speed, bss, cls, t0, L0, rss } with the PNGs decoded
// (speed in km/s or NaN; bss = source-surface B_r / ss_scale; cls = -1, 0, 1).
export function analyse(d) {
  const m = d.meta, E = m.fleet.earth, out = { bodies: {} };
  // The wind at each in-situ body: source-surface rings at its latitude,
  // carried out to its distance.
  for (const [k, name] of BODIES) {
    const b = m.fleet[k];
    if (!b || !d.speed) continue;
    const rings = propagate(ringAt(d.speed, b.lat), ringAt(d.bss, b.lat), d.rss, b.r);
    const rows = m.connect.filter((c) => c.body === k), v = selfConsistent(rows, 400), c = rows.find((r) => r.v === v);
    out.bodies[k] = { key: k, name, b, rings, v: ringValue(rings.v, b.lon), pol: ringValue(rings.b, b.lon),
      src: wrap(Math.atan2(ringValue(rings.sin, b.lon), ringValue(rings.cos, b.lon)) * 180 / Math.PI), conn: c, vConn: v };
  }
  const e = out.bodies.earth;
  if (e) {
    const from = noon(d.day) - 13 * DAY, to = noon(d.day) + 14 * DAY;
    out.ser = series(e.rings, E.lon, d.t0, from, to);
    out.cross = crossings(out.ser);
    out.streams = streams(out.ser, 500);
    out.now = out.ser.reduce((a, p) => (Math.abs(p.t - d.t0) < Math.abs(a.t - d.t0) ? p : a));
    out.next = out.cross.find((c) => c.t > d.t0);
    out.ahead = out.ser.filter((p) => p.t > d.t0 && p.t <= d.t0 + 7 * DAY);
    out.peak = out.ahead.reduce((a, p) => (p.v > (a?.v ?? -1) ? p : a), null);
    out.imf = imfStrength(m.open_flux_Mx, E.r, out.now.v, 0);
  }
  // Russell-McPherron for the date's current sector; Rosenberg-Coleman from
  // the source surface at Earth's latitude.
  const sec = out.now ? Math.sign(out.now.b) || 1 : 1;
  out.rm = { pol: sec, day: bzDay(Date.parse(d.day + "T00:00:00Z"), sec, out.now?.v || 400, E.r),
    other: bzDay(Date.parse(d.day + "T00:00:00Z"), -sec, out.now?.v || 400, E.r) };
  const ring = ringAt(d.bss, E.lat);
  out.rc = { lat: E.lat, away: ring.filter((x) => x > 0).length / 360 };
  // Coronal holes whose low-latitude part is big enough to matter.
  if (d.cls) {
    out.holes = openRegions(d.cls, 35).filter((h) => h.lowArea >= 0.0015).slice(0, 8).map((h, i) => {
      const cmd = wrap180(h.lon - d.L0);
      return { ...h, n: i + 1, cmd, cmT: d.t0 - (cmd / RATE) * DAY,
        arrive: [700, 500].map((v) => d.t0 + arrivalDays(h.lon, d.L0, v, E.r, d.rss) * DAY) };
    });
  }
  return out;
}

// Footpoints of the in-situ bodies on a day's product, as seen from Earth.
export function footpoints(meta) {
  const out = [];
  for (const [k, name] of BODIES) {
    const rows = meta.connect.filter((c) => c.body === k);
    if (!rows.length) continue;
    const v = selfConsistent(rows, 400), c = rows.find((r) => r.v === v);
    if (c?.foot) out.push({ key: k, name, v, foot: c.foot, ston: { lon: wrap180(c.foot[0] - meta.L0), lat: c.foot[1] }, fs: c.fs, dchb: c.dchb });
  }
  return out;
}


// The day's entry in the time series (data/spaceweather/daily.json): the
// headline numbers, and the daily-mean speed and sector predicted at Earth
// for each UTC day from the day before to seven days after, so forecasts at
// every lead time can later be scored against what was measured.
export function record(d, a) {
  const day0 = Date.parse(d.day + "T00:00:00Z"), r1 = (x, n = 1) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(n));
  const daily = [-1, 0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
    const pts = (a.ser || []).filter((p) => p.t >= day0 + k * DAY && p.t < day0 + (k + 1) * DAY);
    return pts.length ? [r1(pts.reduce((s, p) => s + p.v, 0) / pts.length, 0), r1(pts.reduce((s, p) => s + p.b, 0) / pts.length, 2)] : [null, null];
  });
  const iso = (t) => (t == null ? null : new Date(t).toISOString().slice(0, 16) + "Z");
  return {
    date: d.day, t0: iso(d.t0), src: d.meta.source.short || d.meta.source.name, cr: d.meta.carrington_rotation,
    v: r1(a.now?.v, 0), sector: a.now ? Math.sign(a.now.b) || 1 : null, next_boundary: iso(a.next?.t),
    peak7: a.peak ? [r1(a.peak.v, 0), iso(a.peak.t)] : null, imf_nT: r1(a.imf?.b, 2), open_flux: d.meta.open_flux_Mx,
    rm: r1(a.rm.day.mean, 3), rc_away: r1(a.rc.away, 3),
    holes_facing: a.holes ? a.holes.filter((h) => Math.abs(h.cmd) <= 30).length : null,
    fc_v: daily.map((x) => x[0]), fc_b: daily.map((x) => x[1]),
  };
}

// ------------------------------------------------------------- status
// Levels, mildest first. Ambient wind above 500 km/s is a high-speed
// stream; streams of 600 and 750 km/s commonly bring active and storm
// conditions.
export const LEVELS = ["good", "watch", "high", "severe"];
export const LEVEL_NAME = { good: "Nominal", watch: "Watch", high: "High", severe: "Severe" };
export const worst = (...lv) => lv.filter(Boolean).reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a), "good");
export const windLevel = (v) => (v < 500 ? "good" : v < 600 ? "watch" : v < 750 ? "high" : "severe");
export const fmtDay = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// ------------------------------------------------------------- DONKI events
const inWeek = (t0) => (x) => { const t = Date.parse(x.t); return t >= t0 - 7 * DAY && t <= t0; };
// The days whose products (flares) and positions (CMEs) the analysis needs.
export function eventDays(events, t0) {
  return { flares: [...new Set(events.flares.filter(inWeek(t0)).map((f) => f.t.slice(0, 10)))],
    cmes: [...new Set(events.cmes.filter(inWeek(t0)).map((c) => c.t.slice(0, 10)))] };
}
// The week to the map time: each flare against the footpoints of its own
// day's product (or this day's), each CME's cone against every body with a
// drag-based arrival in the model wind there, and the storms.
// ctx = { metaFor(day) -> meta or null, fleetAt(day) -> { fleet, L0 } or null }.
export function eventsAnalysis(events, d, a, ctx) {
  const within = inWeek(d.t0);
  const flares = events.flares.filter(within).map((f) => {
    const loc = parseLocation(f.loc), t = Date.parse(f.t), meta = ctx.metaFor(f.t.slice(0, 10)) || d.meta, feet = footpoints(meta);
    const L0 = earthLon(meta.L0, Date.parse(meta.obstime), t), conn = {}, dist = {};
    if (loc) for (const p of feet) { dist[p.key] = angle(loc.lon + L0, loc.lat, p.foot[0], p.foot[1]); conn[p.key] = connection(dist[p.key]); }
    return { ...f, tm: t, site: loc, conn, dist };
  });
  const cmes = events.cmes.filter(within).filter((c) => c.lon != null && c.lat != null).map((c) => {
    const t = Date.parse(c.t), t21 = c.t21 ? Date.parse(c.t21) : t + 21.5 * RSUN_KM / c.speed * 1000, pos = ctx.fleetAt(c.t.slice(0, 10));
    const targets = {};
    for (const [k] of BODIES) {
      const b = pos?.fleet[k] || d.meta.fleet[k];
      if (!b) continue;
      const g = cmeGeometry({ lon: c.lon, lat: c.lat, half: c.half ?? 30 }, { lon: wrap180(b.lon - (pos ? pos.L0 : d.L0)), lat: b.lat });
      if (g.hit !== "miss") {
        const w = a.bodies[k]?.v ?? 400, run = dbm(c.speed, w, 21.5 * RSUN_KM, b.r * AU_KM);
        Object.assign(g, { arrival: t21 + run.t * 1000, vArr: run.v, w });
      }
      targets[k] = g;
    }
    return { ...c, tm: t, targets };
  });
  return { flares, cmes, storms: events.storms.filter(within) };
}
// What the events mean for Earth: CMEs aimed at it (unless they arrived
// more than a day before the map), storms, and flares that could send it
// particles.
export function eventLevel(ev, t0) {
  if (!ev) return null;
  const why = [];
  let lv = "good";
  for (const c of ev.cmes) {
    const g = c.targets.earth;
    if (!g || g.hit === "miss" || g.arrival < t0 - DAY) continue;
    lv = worst(lv, g.hit === "inside" ? (c.speed >= 1500 ? "severe" : "high") : "watch");
    why.push(`a ${c.speed} km/s CME ${g.hit === "inside" ? "aimed at" : "glancing"} Earth`);
  }
  for (const st of ev.storms) { lv = worst(lv, st.g >= 4 ? "severe" : "high"); why.push(`a G${st.g} storm`); }
  for (const f of ev.flares) {
    lv = worst(lv, f.conn.earth === "good" ? "high" : "watch");
    why.push(`an ${f.cls} flare${f.conn.earth === "good" ? " well connected to Earth" : ""}`);
  }
  return { lv, why };
}
// One overall level for the day: the worst of the wind now, the week ahead
// and the events, with the reasons in words.
export function overall(d, a, ev) {
  const evl = eventLevel(ev, d.t0), reasons = [];
  const lvNow = a.now ? windLevel(a.now.v) : null, lvPeak = a.peak ? windLevel(a.peak.v) : null;
  if (lvNow && lvNow !== "good") reasons.push(`${windClass(a.now.v)} wind now (${Math.round(a.now.v)} km/s)`);
  if (lvPeak && lvPeak !== "good" && a.peak.v > (a.now?.v ?? 0) + 30) reasons.push(`a high-speed stream around ${fmtDay(a.peak.t)} (${Math.round(a.peak.v)} km/s)`);
  if (evl?.why.length) reasons.push(...evl.why);
  return { level: worst(lvNow, lvPeak, evl?.lv), reasons, lvNow, lvPeak, evl };
}

// What the nightly share card draws: the outlook at Earth every 3 hours
// from two days before the map to seven after, with far-side flags.
export function cardSeries(d, a) {
  const day0 = Date.parse(d.day + "T00:00:00Z");
  return (a.ser || []).filter((p) => p.t >= day0 - 2 * DAY && p.t <= day0 + 8 * DAY && new Date(p.t).getUTCHours() % 3 === 0)
    .map((p) => [new Date(p.t).toISOString().slice(0, 13), Math.round(p.v), Math.sign(p.b) || 1, p.age > 14 ? 1 : 0]);
}
