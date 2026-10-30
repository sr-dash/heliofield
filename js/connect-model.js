// What a connection predicts at the spacecraft: the polarity of the model
// field where the spiral meets the outer boundary, the polarity at the
// footpoint, and the angle to the current sheet. Shared by the connectivity
// worker and the test suite.
import { scsPolarity, sample } from "./pfss.js?v=1e0df6a8d5";

const DEG = Math.PI / 180;
const cart = (r, lon, lat) => [r * Math.cos(lat * DEG) * Math.cos(lon * DEG), r * Math.cos(lat * DEG) * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
const unit = (lon, lat) => cart(1, lon, lat);

// Polarity (+1 outward, -1 inward) of the model field at a point on the
// model's outer boundary: B_r of PFSS just inside the source surface, or the
// sign carried out along the SCS field.
export function topPolarity(m, lon, lat, r = null) {
  if (m.S) return scsPolarity(m, r ?? m.rout * 0.995, lon, lat);
  const p = cart(m.rss * 0.995, lon, lat), v = sample(m.G, ...p, [0, 0, 0]);
  return v[0] * p[0] + v[1] * p[1] + v[2] * p[2] >= 0 ? 1 : -1;
}
// Polarity of the photospheric field at a footpoint.
export function footPolarity(m, lon, lat) {
  const p = cart(1.01, lon, lat), v = sample(m.G, ...p, [0, 0, 0]);
  return v[0] * p[0] + v[1] * p[1] + v[2] * p[2] >= 0 ? 1 : -1;
}
// Angle [deg] from a point to the nearest point of the neutral lines.
export function toSheet(lines, lon, lat) {
  const u = unit(lon, lat);
  let best = -2;
  for (const h of lines) for (let k = 0; k < h.length; k += 2) {
    const w = unit(h[k], h[k + 1]);
    best = Math.max(best, u[0] * w[0] + u[1] * w[1] + u[2] * w[2]);
  }
  return best < -1 ? null : Math.acos(Math.min(1, best)) / DEG;
}

// Connections annotated with what they predict at the spacecraft.
export function annotate(m, meta, connect, ensemble) {
  const sheet = m.S ? meta.hcs_out || [] : meta.hcs || [];
  const rows = connect.map((c) => ({
    ...c,
    pol: topPolarity(m, c.ss[0], c.ss[1], c.inside ? c.r : null),
    footPol: c.foot ? footPolarity(m, c.foot[0], c.foot[1]) : 0,
    sheetDeg: toSheet(sheet, c.ss[0], c.ss[1]),
  }));
  return { rows, ensemble };
}

