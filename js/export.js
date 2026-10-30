// The downloadable results of a rotation solved in the browser: a NetCDF-3
// file and a JSON header describing it. Pure functions (no DOM), used by the
// worker and by the test suite.
//
// kind: "surface" (maps, neutral line, spacecraft and footpoints),
//       "pfss"    (+ the 3D PFSS field, field lines, connection lines),
//       "scs"     (+ the 3D Schatten current-sheet field, the traced sheet
//                  and the polarity at the outer edge).
import { surfaceBr, scsPolarity } from "./pfss.js?v=1e0df6a8d5";
import { writeNetCDF } from "./netcdf.js?v=b9a0a32cc2";

export const FORMAT = "heliofield-export-2";

// What happens to the map before and during the extrapolation.
const PREP = {
  input: "SDO/HMI Carrington-rotation synoptic map (hmi.Synoptic_Mr_small, or hmi.Synoptic_Mr averaged), averaged in blocks to 180 x 360 (rows uniform in sine latitude), missing pixels set to 0, mean removed so the net flux is zero",
  model: (L, l0) => `br_input expanded in spherical harmonics up to degree ${L}${l0 ? ` with a Gaussian taper exp(-l(l+1)/(2*${l0}^2))` : ""} and the monopole (l = 0) removed: a smoothing with a kernel of FWHM ${fwhmDeg(L, l0).toFixed(1)} degrees that also guarantees zero net flux. This is the boundary condition of the PFSS solution.`,
};

// Width of the smoothing kernel that the series and its taper amount to:
// sum (2l + 1) w_l P_l(cos g), down to half its peak.
function fwhmDeg(L, l0) {
  const w = (l) => (l0 ? Math.exp(-l * (l + 1) / (2 * l0 * l0)) : 1);
  const K = (g) => {
    const x = Math.cos(g);
    let p0 = 1, p1 = x, s = w(0) + 3 * w(1) * x;
    for (let l = 2; l <= L; l++) { const p = ((2 * l - 1) * x * p1 - (l - 1) * p0) / l; s += (2 * l + 1) * w(l) * p; p0 = p1; p1 = p; }
    return s;
  };
  const k0 = K(0);
  for (let i = 1; i <= 4000; i++) if (K(i * Math.PI / 180 / 100) < k0 / 2) return 2 * i / 100;
  return NaN;
}
const TAU = 2 * Math.PI;

// Grid values as spherical components (B_r, B_theta, B_phi) for the given
// radial levels, latitude rows south first. levels: [{ G, ir }].
function spherical(levels, nth, nph) {
  const n = levels.length * nth * nph, br = new Float32Array(n), bt = new Float32Array(n), bp = new Float32Array(n);
  levels.forEach(({ G, ir }, li) => {
    for (let i = 0; i < nth; i++) {
      const k = nth - 1 - i, th = (k + 0.5) * Math.PI / nth, st = Math.sin(th), ct = Math.cos(th);
      for (let p = 0; p < nph; p++) {
        const ph = p * TAU / nph, cp = Math.cos(ph), sp = Math.sin(ph);
        const o = 3 * ((ir * nth + k) * nph + p), x = G.B[o], y = G.B[o + 1], z = G.B[o + 2];
        const q = (li * nth + i) * nph + p;
        br[q] = x * st * cp + y * st * sp + z * ct;
        bt[q] = x * ct * cp + y * ct * sp - z * st;
        bp[q] = -x * sp + y * cp;
      }
    }
  });
  return { br, bt, bp };
}
const radiusOf = (G, ir) => Math.exp(G.lnr0 + G.lnr * ir / (G.nr - 1));
const f32 = (a) => Float32Array.from(a, (x) => (x == null ? NaN : x));

// Flat polylines: points in one list, each line's start and count.
function ragged(polys) {
  let n = 0;
  for (const p of polys) n += p.length;
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
  const start = new Int32Array(polys.length), count = new Int32Array(polys.length);
  let o = 0;
  polys.forEach((p, i) => {
    start[i] = o; count[i] = p.length;
    for (const q of p) { x[o] = q[0]; y[o] = q[1]; z[o] = q[2]; o++; }
  });
  return { x, y, z, start, count, n };
}

// ctx: { kind, br, ny, nx, coef, model (the solved main model: G, S, rss,
// rcp, rout, pol), meta (the product's meta), lines (field-line polylines),
// drawn (indices of the lines drawn), conn ([{ body, v, pts }] drawn
// connections), view ({ lon, lat, dist, fov, logScale, theme, vsw, connMode }),
// version, created }
export function buildExport(ctx) {
  const { kind, br, ny, nx, coef, model: m, meta } = ctx;
  if (kind === "scs" && !m.S) throw new Error("the current solution has no SCS field");
  const scs = !!m.S && kind !== "pfss";
  const rss = m.rss, rcp = scs ? m.rcp : null, rout = scs ? m.rout : null, rIn = scs ? rcp : rss;
  const dims = [], vars = [], dim = (name, n) => { if (!dims.find((d) => d[0] === name)) dims.push([name, n]); };
  const add = (name, ds, type, data, attrs) => vars.push({ name, dims: ds, type, data, attrs });

  // --- surface maps on the input grid (rows uniform in sin(latitude))
  dim("lat", ny); dim("lon", nx);
  add("lat", ["lat"], "float", Float32Array.from({ length: ny }, (_, i) => Math.asin(-1 + (2 * i + 1) / ny) * 180 / Math.PI),
    { units: "degrees_north", long_name: "Carrington latitude of the map rows (uniform in sine latitude, south first)" });
  add("lon", ["lon"], "float", Float32Array.from({ length: nx }, (_, j) => (j + 0.5) * 360 / nx),
    { units: "degrees_east", long_name: "Carrington longitude of the map columns" });
  // The archived map, and what the model actually uses: the harmonic
  // expansion to degree lmax without the monopole, which smooths it
  // (resolution about 180/lmax degrees) and leaves zero net flux.
  add("br_input", ["lat", "lon"], "float", Float32Array.from(br),
    { units: "G", long_name: "Input map: the archived magnetogram before the harmonic expansion",
      preprocessing: PREP.input });
  add("br_phot", ["lat", "lon"], "float", surfaceBr(coef, 1, rss, ny, nx, true),
    { units: "G", long_name: "Photospheric radial field as used by the model (its boundary condition)",
      preprocessing: PREP.model(coef.L, coef.taper ?? 0) });
  add("br_ss", ["lat", "lon"], "float", surfaceBr(coef, rss, rss, ny, nx, true),
    { units: "G", long_name: "PFSS radial field on the source surface", radius_rsun: rss });
  if (scs) add("br_cusp", ["lat", "lon"], "float", surfaceBr(coef, rcp, rss, ny, nx, true),
    { units: "G", long_name: "PFSS radial field on the cusp surface, the inner boundary of the SCS model", radius_rsun: rcp });

  dim("lat1", 180); dim("lon1", 360);
  add("lat1", ["lat1"], "float", Float32Array.from({ length: 180 }, (_, i) => -89.5 + i), { units: "degrees_north", long_name: "Latitude of the 1-degree open/closed map" });
  add("lon1", ["lon1"], "float", Float32Array.from({ length: 360 }, (_, j) => j + 0.5), { units: "degrees_east", long_name: "Longitude of the 1-degree open/closed map" });
  add("open_class", ["lat1", "lon1"], "byte", Int8Array.from(m.pol),
    { long_name: "Field line from just above the photosphere: 0 closed, 1 open outward, -1 open inward", open_means: scs ? "reaches the cusp surface" : "reaches the source surface" });

  const nl = (polys, prefix, radius, what) => {
    const pts = [], line = [];
    polys.forEach((h, i) => { for (let k = 0; k < h.length; k += 2) { pts.push([h[k], h[k + 1]]); line.push(i); } });
    dim(`${prefix}_pt`, Math.max(1, pts.length));
    const fill = (a) => (a.length ? a : [NaN]);
    add(`${prefix}_lon`, [`${prefix}_pt`], "float", f32(fill(pts.map((p) => p[0]))), { units: "degrees_east", long_name: `${what}: longitude`, radius_rsun: radius });
    add(`${prefix}_lat`, [`${prefix}_pt`], "float", f32(fill(pts.map((p) => p[1]))), { units: "degrees_north", long_name: `${what}: latitude` });
    add(`${prefix}_line`, [`${prefix}_pt`], "int", Int32Array.from(line.length ? line : [-1]), { long_name: `${what}: index of the polyline each point belongs to` });
  };
  nl(meta.hcs, "nl", rIn, scs ? "Neutral line on the cusp surface" : "Neutral line on the source surface");

  // --- spacecraft, planets and footpoints
  const keys = Object.keys(meta.fleet || {}), nb = Math.max(1, keys.length), w = Math.max(4, ...keys.map((k) => k.length));
  const names = keys.map((k) => String(meta.fleet[k].name || k).replace(/[^\x20-\x7e]/g, "")), wn = Math.max(4, ...names.map((n) => n.length));
  dim("body", nb); dim("name_len", w); dim("long_name_len", wn);
  const keyChars = new Uint8Array(nb * w), nameChars = new Uint8Array(nb * wn);
  keys.forEach((k, i) => { for (let c = 0; c < k.length; c++) keyChars[i * w + c] = k.charCodeAt(c); });
  names.forEach((n, i) => { for (let c = 0; c < n.length; c++) nameChars[i * wn + c] = n.charCodeAt(c); });
  const fb = (f) => f32(keys.length ? keys.map((k) => f(meta.fleet[k])) : [NaN]);
  add("body_key", ["body", "name_len"], "char", keyChars, { long_name: "Short key of each body (psp, solo, earth, ...)" });
  add("body_name", ["body", "long_name_len"], "char", nameChars, { long_name: "Name of each body" });
  add("body_lon", ["body"], "float", fb((b) => b.lon), { units: "degrees_east", long_name: "Carrington longitude of the body" });
  add("body_lat", ["body"], "float", fb((b) => b.lat), { units: "degrees_north", long_name: "Carrington latitude of the body" });
  add("body_r", ["body"], "float", fb((b) => b.r), { units: "au", long_name: "Heliocentric distance of the body" });
  add("body_planet", ["body"], "byte", Int8Array.from(keys.length ? keys.map((k) => (meta.fleet[k].planet ? 1 : 0)) : [0]), { long_name: "1 for a planet, 0 for a spacecraft" });

  const rows = meta.connect || [], nconn = Math.max(1, rows.length), col = (f) => f32(rows.length ? rows.map(f) : [NaN]);
  dim("conn", nconn);
  add("conn_body", ["conn"], "int", Int32Array.from(rows.length ? rows.map((c) => keys.indexOf(c.body)) : [-1]), { long_name: "Index into the body dimension" });
  add("conn_v", ["conn"], "float", col((c) => c.v), { units: "km s-1", long_name: "Solar-wind speed of the ballistic Parker-spiral mapping" });
  add("conn_top_lon", ["conn"], "float", col((c) => c.ss[0]), { units: "degrees_east", long_name: "Where the spiral meets the model's outer boundary: longitude", radius_rsun: scs ? rout : rss });
  add("conn_top_lat", ["conn"], "float", col((c) => c.ss[1]), { units: "degrees_north", long_name: "Where the spiral meets the model's outer boundary: latitude" });
  add("foot_lon", ["conn"], "float", col((c) => c.foot?.[0]), { units: "degrees_east", long_name: "Photospheric footpoint longitude (NaN: line does not reach the photosphere)" });
  add("foot_lat", ["conn"], "float", col((c) => c.foot?.[1]), { units: "degrees_north", long_name: "Photospheric footpoint latitude" });
  add("foot_fs", ["conn"], "float", col((c) => c.fs), { units: "1", long_name: `Expansion factor between the photosphere and the ${scs ? "cusp" : "source"} surface` });
  add("foot_dchb", ["conn"], "float", col((c) => c.dchb), { units: "degree", long_name: "Angular distance from the footpoint to the nearest coronal-hole boundary" });
  add("foot_vwsa", ["conn"], "float", col((c) => c.vwsa), { units: "km s-1", long_name: "WSA-type speed estimate from f_s and DCHB (illustrative coefficients)" });
  const ens = meta.ensemble?.foot || [];
  if (ens.length && rows.length) {
    dim("spread", ens.length);
    const e = (j) => f32(ens.flatMap((list) => list.map((x) => (x ? x[j] : null))));
    add("spread_rss", ["spread"], "float", f32(meta.ensemble.rss), { units: "R_sun", long_name: "Source-surface radius of each spread solution" });
    add("spread_foot_lon", ["spread", "conn"], "float", e(0), { units: "degrees_east", long_name: "Footpoint longitude on the spread solutions" });
    add("spread_foot_lat", ["spread", "conn"], "float", e(1), { units: "degrees_north", long_name: "Footpoint latitude on the spread solutions" });
    add("spread_foot_vwsa", ["spread", "conn"], "float", e(4), { units: "km s-1", long_name: "WSA-type speed on the spread solutions" });
  }

  // --- 3D fields and traced lines
  if (kind !== "surface") {
    const G = m.G, { nth, nph } = G;
    dim("r", G.nr); dim("lat_g", nth); dim("lon_g", nph);
    add("r", ["r"], "float", Float32Array.from({ length: G.nr }, (_, i) => radiusOf(G, i)), { units: "R_sun", long_name: "Radius of the PFSS grid (uniform in ln r)" });
    add("lat_g", ["lat_g"], "float", Float32Array.from({ length: nth }, (_, i) => 90 - (nth - 1 - i + 0.5) * 180 / nth), { units: "degrees_north", long_name: "Latitude of the 3D grid (cell centres, south first)" });
    add("lon_g", ["lon_g"], "float", Float32Array.from({ length: nph }, (_, p) => p * 360 / nph), { units: "degrees_east", long_name: "Longitude of the 3D grid (nodes)" });
    const b = spherical(Array.from({ length: G.nr }, (_, ir) => ({ G, ir })), nth, nph);
    const d3 = ["r", "lat_g", "lon_g"];
    add("br", d3, "float", b.br, { units: "G", long_name: "PFSS B_r" });
    add("btheta", d3, "float", b.bt, { units: "G", long_name: "PFSS B_theta (positive southward)" });
    add("bphi", d3, "float", b.bp, { units: "G", long_name: "PFSS B_phi (positive eastward, in the direction of rotation)" });

    const L = ragged(ctx.lines), kinds = meta.lines.kind, drawn = new Set(ctx.drawn || []);
    dim("line", Math.max(1, ctx.lines.length)); dim("line_pt", Math.max(1, L.n));
    add("line_start", ["line"], "int", L.start, { long_name: "Index of the line's first point in line_pt" });
    add("line_count", ["line"], "int", L.count, { long_name: "Number of points in the line" });
    add("line_kind", ["line"], "byte", Int8Array.from(kinds), { long_name: "0 closed, 1 open outward, -1 open inward" });
    add("line_drawn", ["line"], "byte", Int8Array.from(ctx.lines.map((_, i) => (drawn.has(i) ? 1 : 0))), { long_name: "1 if the viewer drew this line when the file was saved" });
    for (const [a, arr] of [["x", L.x], ["y", L.y], ["z", L.z]]) {
      add(`line_${a}`, ["line_pt"], "float", arr, { units: "R_sun", long_name: `Field-line points, Carrington Cartesian ${a} (x towards longitude 0, z along the rotation axis), true distance` });
    }
    const C = ctx.conn || [];
    if (C.length) {
      const R = ragged(C.map((c) => c.pts));
      dim("cline", C.length); dim("cline_pt", Math.max(1, R.n));
      add("cline_body", ["cline"], "int", Int32Array.from(C.map((c) => keys.indexOf(c.body))), { long_name: "Index into the body dimension" });
      add("cline_v", ["cline"], "float", f32(C.map((c) => c.v)), { units: "km s-1", long_name: "Wind speed of the drawn connection" });
      add("cline_start", ["cline"], "int", R.start, {});
      add("cline_count", ["cline"], "int", R.count, {});
      for (const [a, arr] of [["x", R.x], ["y", R.y], ["z", R.z]]) {
        add(`cline_${a}`, ["cline_pt"], "float", arr, { units: "R_sun", long_name: `Drawn connection field line (outer boundary to photosphere), Cartesian ${a}` });
      }
    }
  }

  if (scs && kind === "scs") {
    const S = m.S, sh = S.near, { nth, nph } = S;
    const levels = [];
    if (sh) for (let ir = 0; ir < sh.nr; ir++) levels.push({ G: sh, ir });
    for (let ir = sh ? 1 : 0; ir < S.nr; ir++) levels.push({ G: S, ir });
    dim("r_scs", levels.length);
    add("r_scs", ["r_scs"], "float", Float32Array.from(levels.map(({ G, ir }) => radiusOf(G, ir))),
      { units: "R_sun", long_name: "Radius of the SCS grid: the transition shell (cusp to source surface), then the SCS region" });
    const b = spherical(levels, nth, nph), d3 = ["r_scs", "lat_g", "lon_g"];
    const note = "Unsigned SCS field: it points outward everywhere. A line's sign is the sign of PFSS B_r where it crosses the cusp surface (see polarity_out).";
    add("br_scs", d3, "float", b.br, { units: "G", long_name: "SCS B_r (unsigned)", comment: note });
    add("btheta_scs", d3, "float", b.bt, { units: "G", long_name: "SCS B_theta (unsigned frame)" });
    add("bphi_scs", d3, "float", b.bp, { units: "G", long_name: "SCS B_phi (unsigned frame)" });
    const pol = new Int8Array(nth * nph), rp = rout * 0.98;
    for (let i = 0; i < nth; i++) {
      const lat = 90 - (nth - 1 - i + 0.5) * 180 / nth;
      for (let p = 0; p < nph; p++) pol[i * nph + p] = scsPolarity(m, rp, p * 360 / nph, lat);
    }
    add("polarity_out", ["lat_g", "lon_g"], "byte", pol, { long_name: "Sign of the coupled field near the outer edge (1 outward, -1 inward, 0 unresolved)", radius_rsun: rp });
    nl(meta.hcs_out || [], "hcs_out", rout, "Current sheet at the outer edge (traced from the cusp-surface neutral line)");
    const ribs = (meta.hcs_ribs || []).flatMap((list, li) => list.map((rib) => ({ rib, li })));
    if (ribs.length) {
      const nr = ribs[0].rib.length / 3;
      dim("rib", ribs.length); dim("rib_level", nr);
      add("rib_line", ["rib"], "int", Int32Array.from(ribs.map((x) => x.li)), { long_name: "Neutral-line polyline the rib starts from" });
      for (const [j, nm, u] of [[0, "lon", "degrees_east"], [1, "lat", "degrees_north"], [2, "r", "R_sun"]]) {
        add(`rib_${nm}`, ["rib", "rib_level"], "float", f32(ribs.flatMap(({ rib }) => Array.from({ length: nr }, (_, k) => rib[3 * k + j]))),
          { units: u, long_name: `Current-sheet ribs (field lines traced out from the cusp-surface neutral line): ${nm}` });
      }
    }
  }

  // --- global attributes and header
  const date = meta.date || ctx.day, saved = ctx.saved || (ctx.created || new Date().toISOString()).slice(0, 10);
  const model = scs ? `PFSS + Schatten current sheet (cusp ${rcp} R_sun, outer edge ${rout} R_sun)` : `PFSS (source surface ${rss} R_sun)`;
  const attrs = {
    title: `HelioField coronal magnetic field for ${date}`,
    format: FORMAT, product: kind,
    source: `${meta.source?.name || "magnetogram"}${meta.map_cr ? `, Carrington rotation ${meta.map_cr}` : ""}`,
    source_file: meta.source?.file, source_url: meta.source?.url,
    date, obstime: meta.obstime, carrington_rotation: meta.carrington_rotation, L0_deg: meta.L0, B0_deg: meta.B0,
    model, rss_rsun: rss, rcp_rsun: rcp ?? undefined, rout_rsun: rout ?? undefined, lmax: meta.model?.lmax,
    frame: "Carrington heliographic (rotating with the Sun); x towards longitude 0, z along the rotation axis",
    length_unit: "R_sun = 695700 km",
    open_flux_Mx: meta.open_flux_Mx,
    saved_date: saved, preprocessing: `${PREP.input}. ${PREP.model(coef.L, coef.taper ?? 0)}`, taper_l0: coef.taper ?? 0,
    software: `HelioField ${ctx.version || ""} in-browser solver (js/pfss.js)`.replace("  ", " "),
    references: "https://doi.org/10.5281/zenodo.23487231; https://sr-dash.github.io/heliofield/guide.html#methods",
    history: `Created ${ctx.created || new Date().toISOString()} in the browser`,
  };
  const nc = writeNetCDF({ dims, attrs, vars });
  const header = {
    format: FORMAT, product: kind, title: attrs.title,
    created: ctx.created, saved_date: saved, software: attrs.software,
    preprocessing: { br_input: PREP.input, br_phot: PREP.model(coef.L, coef.taper ?? 0) }, citation: "Dash, S. HelioField: the Sun's coronal magnetic field in 3D. Zenodo. https://doi.org/10.5281/zenodo.23487231",
    date, obstime: meta.obstime,
    source: { name: meta.source?.name, file: meta.source?.file, url: meta.source?.url, carrington_rotation_of_map: meta.map_cr, map_covers: [meta.map_start, meta.map_stop] },
    model: { name: scs ? "PFSS + SCS" : "PFSS", rss_rsun: rss, rcp_rsun: rcp, rout_rsun: rout, lmax: meta.model?.lmax, taper_l0: coef.taper ?? 0,
      grid: { pfss: [m.G.nr, m.G.nth, m.G.nph], scs: scs && kind === "scs" ? [dims.find((d) => d[0] === "r_scs")[1], m.S.nth, m.S.nph] : null },
      cusp_fraction: scs ? +(rcp / rss).toFixed(3) : null,
      transition_shell: scs ? "PFSS (turned outward) blended into SCS from the cusp surface to the source surface (smoothstep in r)" : null },
    frame: attrs.frame, length_unit: attrs.length_unit,
    earth: { L0_deg: meta.L0, B0_deg: meta.B0, carrington_rotation: meta.carrington_rotation },
    open_flux_Mx: meta.open_flux_Mx,
    view: ctx.view,
    dimensions: Object.fromEntries(dims),
    variables: Object.fromEntries(vars.map((v) => [v.name, { dims: v.dims, type: v.type, ...(v.attrs || {}) }])),
  };
  return { nc, header };
}

// The files that go with each product, and the README filled in for them.
// Every bundle has all the scripts; a 3D bundle also has the surface-map
// file, from which compute_corona.py can recompute the corona.
export const SCRIPTS = ["heliofield_io.py", "heliofield_update.py", "plot_surface.py", "plot_3d.py", "compute_corona.py",
  "requirements.txt", "requirements-tested.txt"];
const PRODUCT = {
  surface: "surface maps (the input map and the model's smoothed photospheric B_r, source-surface B_r, open-field footprints, neutral line, spacecraft footpoints)",
  pfss: "full 3D PFSS (the 3D field, field lines, spacecraft connections), with the surface maps",
  scs: "full 3D PFSS + Schatten current sheet (as PFSS, plus the SCS field, the traced current sheet and the polarity at the outer edge), with the surface maps",
};
const ABOUT = {
  "heliofield_io.py": "reads the results; colours and helpers shared by the scripts",
  "heliofield_update.py": "checks package versions and fetches fixed scripts (see below)",
  "plot_surface.py": "surface maps as PNG and PDF",
  "plot_3d.py": "the 3D view as PNG and PDF, as the viewer draws it",
  "compute_corona.py": "computes the 3D field from the surface maps, PFSS or PFSS + SCS (same method as the web page)",
  "requirements.txt": "Python packages needed (lowest supported versions)",
  "requirements-tested.txt": "the exact versions the scripts were tested with",
};

// heliofield_model-<model date>_saved-<date saved in the browser>_<product>
export function bundleName(header, product = header.product) {
  return `heliofield_model-${header.date}_saved-${header.saved_date}_${product}`;
}

export function readme(template, header) {
  const stem = bundleName(header), nc = `${stem}.nc`, hd = `${stem}_header.json`;
  const surf = bundleName(header, "surface"), three = header.product !== "surface";
  const files = [[nc, "results (NetCDF-3)"], [hd, "its header: variables, units, preprocessing, model settings, saved view"],
    ...(three ? [[`${surf}.nc`, "the surface maps alone (NetCDF-3)"], [`${surf}_header.json`, "their header"]] : []),
    [`${stem}_preview_view.png`, "preview: the view on screen when the files were saved"],
    [`${stem}_preview_maps.png`, "preview: the surface maps (plot_surface.py draws the full figure)"],
    ...SCRIPTS.map((f) => [f, ABOUT[f]]), ["README.txt", "this file"]];
  const w = Math.max(...files.map(([f]) => f.length));
  const model = header.model.rout_rsun ? "scs" : "pfss", out = `heliofield_model-${header.date}_computed-YYYY-MM-DD_${model}.nc`;
  const steps = (three
    ? [`    python plot_3d.py ${nc}`,
      `    python plot_surface.py ${surf}.nc`,
      "",
      "To recompute the corona yourself, for example with another source surface:",
      "",
      `    python compute_corona.py ${surf}.nc --rss 2.0${header.model.rout_rsun ? ` --scs ${header.model.rout_rsun}` : ""}`]
    : [`    python plot_surface.py ${nc}`,
      `    python compute_corona.py ${nc}                 # PFSS, as on the page`,
      `    python compute_corona.py ${nc} --scs 21.5      # or PFSS + SCS`])
    .concat(["", `compute_corona.py writes ${out}`, "(YYYY-MM-DD is the day you run it) in the format of a 3D download; then", `    python plot_3d.py ${out.replace("YYYY-MM-DD", "<that date>")}`]).join("\n");
  const fill = {
    TITLE: header.title, RULE: "=".repeat(Math.min(78, `HelioField results: ${header.title}`.length)),
    MODEL: header.model.name + (header.model.rout_rsun ? `, cusp ${header.model.rcp_rsun} R_sun, outer edge ${header.model.rout_rsun} R_sun` : `, source surface ${header.model.rss_rsun} R_sun`),
    SOURCE: [header.source?.name, header.source?.carrington_rotation_of_map ? `Carrington rotation ${header.source.carrington_rotation_of_map}` : null].filter(Boolean).join(", "),
    MODELDATE: header.date, SAVED: header.saved_date, CREATED: header.created, PRODUCT: PRODUCT[header.product],
    FILES: files.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`).join("\n"),
    STEPS: steps, NCNAME: nc, HEADERNAME: hd, CITATION: header.citation,
    PREP_INPUT: header.preprocessing?.br_input, PREP_MODEL: header.preprocessing?.br_phot,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? "");
}
