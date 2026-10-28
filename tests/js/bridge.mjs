// Runs the browser solver (js/pfss.js) under Node for the Python test suite.
// Reads one JSON request on stdin and writes one JSON reply on stdout.
//
//   { "cmd": "alf", "mu": [...], "L": 40 }
//   { "cmd": "analyse", "br": "path.f32", "ny": 180, "nx": 360, "L": 40 }
//   { "cmd": "field", "br": "path.f32", "ny", "nx", "L", "rss", "points": [[x,y,z], ...] }
//   { "cmd": "trace", "br": ..., "ny", "nx", "L", "rss", "seeds": [[x,y,z], ...] }
//   { "cmd": "solve", "br": ..., "ny", "nx", "rss", "fleet": { key: { lon, lat, r, planet } } }
//   { "cmd": "wsa", "pairs": [[fs, dchb], ...] }
//   { "cmd": "scsfield", "br", "ny", "nx", "rss", "rout", "points": [[x,y,z], ...] }   SCS field
//   { "cmd": "scspolarity", "br", "ny", "nx", "rss", "rout", "r", "lonlat": [[lon,lat], ...] }
//
// Map files are little-endian float32, ny rows uniform in sin(latitude)
// from the south, column j centred on Carrington longitude (j + 0.5) 360/nx.
import fs from "node:fs";
import { alf, analyse, fieldGrid, sample, trace, solve, surfaceBr, zeroContour, chBoundary, wsaSpeed, model, scsPolarity } from "../../js/pfss.js";

const req = JSON.parse(fs.readFileSync(0, "utf8"));
const readMap = (p) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const grid = (r) => fieldGrid(analyse(readMap(r.br), r.ny, r.nx, r.L ?? 40), { rss: r.rss ?? 2.5 });
let out;

switch (req.cmd) {
  case "alf": {
    out = req.mu.map((mu) => Array.from(alf(mu, req.L)));
    break;
  }
  case "analyse": {
    const c = analyse(readMap(req.br), req.ny, req.nx, req.L);
    out = { C: Array.from(c.C), S: Array.from(c.S) };
    break;
  }
  case "field": {
    const G = grid(req), v = [0, 0, 0];
    out = req.points.map((p) => sample(G, p[0], p[1], p[2], v).slice());
    break;
  }
  case "trace": {
    const G = grid(req);
    out = req.seeds.map((p) => trace(G, p));
    break;
  }
  case "solve": {
    const br = readMap(req.br), t0 = Date.now();
    const res = solve(br, req.ny, req.nx, { fleet: req.fleet || {}, rss: req.rss ?? 2.5, rout: req.rout ?? 0 });
    const rss = res.meta.model.rss;
    out = {
      seconds: (Date.now() - t0) / 1000,
      open_flux_Mx: res.meta.open_flux_Mx,
      kind: res.meta.lines.kind,
      hcs: res.meta.hcs,
      // Source-surface B_r on the 180 x 360 equirectangular grid, south first.
      ss: Array.from(surfaceBr(res.coef, rss, rss)),
      open_fraction: res.models[0].openFraction,
      // Open (1) or closed (0) at r = 1 on the 1-degree grid, south first.
      open: Array.from(res.models[0].open),
      connect: res.meta.connect,
      ensemble: res.meta.ensemble,
      model: res.meta.model,
      hcs_out: res.meta.hcs_out,
      hcs_ribs: res.meta.hcs_ribs,
    };
    break;
  }
  case "contour": {
    out = zeroContour(Float32Array.from(req.field), req.nlat, req.nlon);
    break;
  }
  case "scsfield":
  case "scspolarity": {
    const m = model(analyse(readMap(req.br), req.ny, req.nx, req.L ?? 40), req.rss ?? 2.5, { rout: req.rout ?? 21.5 });
    if (req.cmd === "scsfield") { const v = [0, 0, 0]; out = req.points.map((p) => sample(m.S, p[0], p[1], p[2], v).slice()); }
    else out = req.lonlat.map(([lo, la]) => scsPolarity(m, req.r, lo, la));
    out = { rcp: m.rcp, values: out };
    break;
  }
  case "wsa": {
    out = req.pairs.map(([f, d]) => wsaSpeed(f, d));
    break;
  }
  case "openfraction": {
    out = chBoundary(grid(req)).openFraction;
    break;
  }
  default:
    throw new Error(`unknown command ${req.cmd}`);
}
process.stdout.write(JSON.stringify(out));
