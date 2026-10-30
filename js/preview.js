// A preview of the surface maps for the download zip, drawn in the worker
// on an OffscreenCanvas: the layout of download/plot_surface.py (model
// photospheric B_r, source- or cusp-surface B_r with the neutral line, and
// the open-field footprints with the spacecraft footpoints listed beside
// them). It shows a new user what the files hold before running anything.
import { surfaceBr } from "./pfss.js?v=1e0df6a8d5";
import { THEMES, divergingLUT } from "./theme.js?v=5abd830f82";

const L1 = ["soho", "ace", "wind", "dscovr", "aditya", "imap", "swfo"];
const TEXT = { dark: ["#e8eaf0", "#a3abbb"], light: ["#1b2030", "#545c6c"] };

// ctx: { br, ny, nx, coef, model, meta, theme, v } as for buildExport.
export async function mapsPreview(ctx) {
  if (typeof OffscreenCanvas === "undefined") return null;
  const { coef, model: m, meta, ny, nx } = ctx, th = THEMES[ctx.theme] || THEMES.light, [ink, muted] = TEXT[ctx.theme] || TEXT.light;
  const scs = !!m.S, rIn = scs ? m.rcp : m.rss, lut = divergingLUT();
  const W = 1500, mapW = 960, mapH = 480, x0 = 90, side = x0 + mapW + 40, top = 140, gap = 150;
  const H = top + 3 * mapH + 2 * gap + 120;
  const cv = new OffscreenCanvas(W, H), g = cv.getContext("2d");
  g.fillStyle = th.bg; g.fillRect(0, 0, W, H);
  const font = (px, bold = false) => { g.font = `${bold ? "600 " : ""}${px}px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`; };
  const text = (s, x, y, { px = 18, color = ink, align = "left", bold = false, base = "alphabetic" } = {}) => {
    font(px, bold); g.fillStyle = color; g.textAlign = align; g.textBaseline = base; g.fillText(s, x, y);
  };
  const px = (lon, lat, y0) => [x0 + lon / 360 * mapW, y0 + (90 - lat) / 180 * mapH];

  // A map on rows uniform in sin(latitude), drawn at uniform latitude.
  const drawMap = (F, y0, scale) => {
    const img = g.createImageData(mapW, mapH);
    for (let y = 0; y < mapH; y++) {
      const lat = 90 - (y + 0.5) / mapH * 180, i = Math.min(ny - 1, Math.max(0, Math.floor((Math.sin(lat * Math.PI / 180) + 1) / 2 * ny)));
      for (let x = 0; x < mapW; x++) {
        const j = Math.min(nx - 1, Math.floor((x + 0.5) / mapW * nx));
        const s = Math.max(-1, Math.min(1, F[i * nx + j] / scale)), k = Math.round((s + 1) / 2 * 255) * 4, o = 4 * (y * mapW + x);
        img.data[o] = lut[k]; img.data[o + 1] = lut[k + 1]; img.data[o + 2] = lut[k + 2]; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, x0, y0);
  };
  const axes = (y0, title) => {
    g.strokeStyle = muted; g.lineWidth = 1.2; g.strokeRect(x0, y0, mapW, mapH);
    for (let lon = 0; lon <= 360; lon += 60) {
      const [x] = px(lon, 0, y0);
      g.beginPath(); g.moveTo(x, y0 + mapH); g.lineTo(x, y0 + mapH + 6); g.stroke();
      text(String(lon), x, y0 + mapH + 26, { px: 16, color: muted, align: "center" });
    }
    for (let lat = -90; lat <= 90; lat += 30) {
      const [, y] = px(0, lat, y0);
      g.beginPath(); g.moveTo(x0 - 6, y); g.lineTo(x0, y); g.stroke();
      text(String(lat), x0 - 10, y + 5, { px: 16, color: muted, align: "right" });
    }
    text("Carrington longitude [°]", x0 + mapW / 2, y0 + mapH + 52, { px: 16, color: ink, align: "center" });
    g.save(); g.translate(30, y0 + mapH / 2); g.rotate(-Math.PI / 2); text("Latitude [°]", 0, 0, { px: 16, align: "center" }); g.restore();
    text(title, x0, y0 - 14, { px: 20 });
  };
  const colorbar = (y0, scale, label) => {
    const bx = side, by = y0 + 40, bh = mapH - 80;
    for (let k = 0; k < bh; k++) {
      const s = 1 - 2 * k / (bh - 1), i = Math.round((s + 1) / 2 * 255) * 4;
      g.fillStyle = `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`; g.fillRect(bx, by + k, 26, 1);
    }
    g.strokeStyle = muted; g.strokeRect(bx, by, 26, bh);
    for (const s of [1, 0.5, 0, -0.5, -1]) {
      const y = by + (1 - s) / 2 * bh;
      text((s * scale).toFixed(scale >= 5 ? 0 : 2), bx + 34, y + 5, { px: 15, color: muted });
    }
    text(label, bx, by - 12, { px: 16 });
  };
  const polyline = (pts, y0, dash) => {
    g.strokeStyle = th.hcs; g.lineWidth = dash ? 2 : 3; g.setLineDash(dash ? [8, 6] : []);
    g.beginPath();
    for (let k = 0; k < pts.length; k += 2) {
      const [x, y] = px(pts[k], pts[k + 1], y0);
      if (k && Math.abs(pts[k] - pts[k - 2]) > 180) g.moveTo(x, y); else if (k) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke(); g.setLineDash([]);
  };

  const date = meta.date || "";
  const model = scs ? `PFSS + Schatten current sheet (cusp ${m.rcp} R☉, outer edge ${m.rout} R☉)` : `PFSS (source surface ${m.rss} R☉)`;
  text(`HelioField · ${date} · ${meta.source?.name || ""}${meta.map_cr ? `, CR ${meta.map_cr}` : ""}`, x0, 40, { px: 22, bold: true });
  text(`${model} · preview drawn in the browser; plot_surface.py makes the full figure`, x0, 70, { px: 16, color: muted });

  // 1. Model photospheric B_r (smoothed, zero net flux), ±20 G as in the viewer.
  let y0 = top;
  drawMap(surfaceBr(coef, 1, m.rss, ny, nx, true), y0, 20);
  axes(y0, "Photospheric Br as used by the model (smoothed, zero net flux)");
  colorbar(y0, 20, "Br [G]");

  // 2. Source or cusp surface with the neutral line (and the sheet at the edge).
  y0 += mapH + gap;
  const ss = surfaceBr(coef, rIn, m.rss, ny, nx, true), abs = Array.from(ss, Math.abs).sort((a, b) => a - b);
  const lim = abs[Math.floor(0.995 * (abs.length - 1))] || 1;
  drawMap(ss, y0, lim);
  for (const h of meta.hcs || []) polyline(h, y0, false);
  if (scs) for (const h of meta.hcs_out || []) polyline(h, y0, true);
  axes(y0, `Br on the ${scs ? "cusp" : "source"} surface (${rIn} R☉), neutral line${scs ? `; dashed: current sheet at ${m.rout} R☉` : ""}`);
  colorbar(y0, lim, "Br [G]");

  // 3. Open-field footprints, footpoints, and the list beside the map.
  y0 += mapH + gap;
  const img = g.createImageData(mapW, mapH), col = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const cPos = col(th.pos), cNeg = col(th.neg), cClosed = col(th.occluder);
  for (let y = 0; y < mapH; y++) {
    const i = Math.min(179, Math.floor((mapH - 1 - y) / mapH * 180));
    for (let x = 0; x < mapW; x++) {
      const p = m.pol[i * 360 + Math.min(359, Math.floor(x / mapW * 360))], c = p > 0 ? cPos : p < 0 ? cNeg : cClosed, o = 4 * (y * mapW + x);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, x0, y0);
  axes(y0, `Open-field footprints (open = reaches the ${scs ? "cusp" : "source"} surface)`);
  const v = ctx.v || 400, rows = [];
  let l1 = false;
  for (const [key, b] of Object.entries(meta.fleet || {})) {
    if (b.planet) continue;
    const c = (meta.connect || []).find((r) => r.body === key && r.v === v);
    if (!c?.foot) continue;
    if (L1.includes(key)) { if (l1) continue; l1 = true; }
    rows.push({ name: L1.includes(key) ? "L1 monitors" : b.name || key, color: th.fleet[L1.includes(key) ? "l1" : key] || th.planet, c });
  }
  for (const r of rows) {
    const [x, y] = px(r.c.foot[0], r.c.foot[1], y0);
    g.beginPath(); g.arc(x, y, 8, 0, 2 * Math.PI); g.fillStyle = r.color; g.fill(); g.lineWidth = 2.5; g.strokeStyle = th.bg; g.stroke();
  }
  text(`Footpoints at ${v} km/s`, side, y0 + 18, { px: 18, bold: true });
  rows.forEach((r, k) => {
    const y = y0 + 58 + k * 50;
    g.beginPath(); g.arc(side + 8, y - 6, 7, 0, 2 * Math.PI); g.fillStyle = r.color; g.fill();
    text(r.name, side + 24, y, { px: 16 });
    text(`${r.c.foot[0].toFixed(0)}°, ${r.c.foot[1] >= 0 ? "+" : ""}${r.c.foot[1].toFixed(0)}° · ${r.c.vwsa.toFixed(0)} km/s`, side + 24, y + 21, { px: 14, color: muted });
  });
  if (!rows.length) text("no spacecraft footpoints", side, y0 + 58, { px: 15, color: muted });
  const ly = y0 + mapH + 84;
  [[th.pos, "open, outward"], [th.neg, "open, inward"], [th.occluder, "closed"]].forEach(([c, t], k) => {
    const x = x0 + 220 + k * 200;
    g.fillStyle = c; g.fillRect(x, ly - 14, 18, 18); g.strokeStyle = muted; g.lineWidth = 1; g.strokeRect(x, ly - 14, 18, 18);
    text(t, x + 26, ly, { px: 16 });
  });
  const blob = await cv.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
