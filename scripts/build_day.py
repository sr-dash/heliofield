#!/usr/bin/env python3
"""Build one day's 3D coronal-field product for HelioField.

    python scripts/build_day.py                    # today (UTC)
    python scripts/build_day.py --date 2026-10-17  # a past day
    python scripts/build_day.py --date 2026-10-01 --to 2026-10-17

For each date this fetches the last GONG zero-point-corrected synoptic map
(mrzqs) of that day, extrapolates it with a PFSS model (sunkit-magex), and
writes data/<date>/:

    meta.json   map provenance, scales, open flux, HCS polylines, fleet
    br.png      photospheric Br, 360x180 equirectangular, 8-bit, +-BR_SCALE G
    ss.png      source-surface Br, same grid, +-ss_scale G (in meta)
    lines.bin   every polyline as int16 Carrington xyz in units of 1e-4 R_sun

Everything is in the Carrington frame (z = solar rotation axis), so the page
never transforms coordinates. Spacecraft come from HelioFleet's published
ephemerides and are converted here, once, for the map time.

The whole run fits a small CI runner: a 180x360 map on nr=40 shells is
~70 MB of field and solves and traces in well under a minute.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import urllib.request
import warnings
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / "cache"

GONG = "https://gong2.nso.edu/oQR/zqs"
FLEET_URL = "https://sr-dash.github.io/heliofleet/data"
UA = {"User-Agent": "heliofield/0.1 (+https://github.com/sr-dash/heliofield)"}

RSS = 2.5            # source-surface radius [R_sun]
NR = 40              # radial shells
BR_SCALE = 20.0      # photospheric display range [G]
QSCALE = 1e4         # int16 quantisation: 1 unit = 1e-4 R_sun (max 3.27 R_sun)
VSW = [300, 400, 500, 600, 700, 800]   # wind speeds for connectivity [km/s]
OMEGA = 2 * np.pi / (25.38 * 86400)    # Carrington sidereal rate [rad/s]
RSUN_KM = 695700.0
AU_KM = 149597870.7

# Bodies drawn in the scene. *_geo series are geocentric km; Earth is added.
FLEET = {
    "earth": "Earth", "mercury": "Mercury", "venus": "Venus", "mars": "Mars",
    "psp": "Parker Solar Probe", "solo": "Solar Orbiter", "sta": "STEREO-A",
    "bepi": "BepiColombo", "aditya": "Aditya-L1", "soho_geo": "SOHO",
    "ace_geo": "ACE", "wind_geo": "Wind", "dscovr_geo": "DSCOVR",
    "imap_geo": "IMAP", "swfo_geo": "SWFO-L1",
}
PLANETS = {"mercury", "venus", "mars"}


# --------------------------------------------------------------------- input
def _get(url: str, timeout: int = 60) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def gong_file(day: date) -> str | None:
    """URL of the last mrzqs map of `day`, or None if the day has none."""
    folder = f"{GONG}/{day:%Y%m}/mrzqs{day:%y%m%d}/"
    try:
        html = _get(folder).decode("latin-1")
    except Exception:
        return None
    # Match map filenames only; the listing also carries unrelated links.
    names = sorted(set(re.findall(r'href="(mrzqs\d{6}t\d{4}c\d{4}_\d{3}\.fits\.gz)"', html)))
    return folder + names[-1] if names else None


def load_map(url: str):
    import sunpy.map
    CACHE.mkdir(exist_ok=True)
    path = CACHE / url.rsplit("/", 1)[1]
    if not path.exists():
        path.write_bytes(_get(url))
    m = sunpy.map.Map(str(path))
    # GONG zqs rows are uniform in sin(latitude); sunpy needs the CUNIT fix
    # it applies itself, nothing else. Remove the monopole PFSS cannot carry.
    return sunpy.map.Map(m.data - np.nanmean(m.data), m.meta)


# ------------------------------------------------------------------ products
def to_equirect(smap, nlat: int = 180) -> np.ndarray:
    """Resample a sin(lat)-uniform Carrington map to a regular latitude grid,
    north up, column j centred on Carrington longitude (j + 0.5) * 360/nx.
    GONG maps do not start at longitude 0 (CRVAL1 moves with the map), so
    the columns are rolled using the map's own WCS."""
    import astropy.units as u
    data = smap.data
    ny, nx = data.shape
    lon0 = smap.pixel_to_world(0 * u.pix, 0 * u.pix).lon.to_value("deg") % 360
    data = np.roll(data, int(round(lon0 / (360 / nx) - 0.5)), axis=1)
    s_src = np.linspace(-1 + 1 / ny, 1 - 1 / ny, ny)
    lat = np.linspace(90 - 90 / nlat, -90 + 90 / nlat, nlat)     # north first
    s_dst = np.sin(np.radians(lat))
    out = np.empty((nlat, nx))
    for j in range(nx):
        out[:, j] = np.interp(s_dst, s_src, data[:, j])
    return out


def write_png(path: Path, field: np.ndarray, scale: float):
    from PIL import Image
    v = np.clip(np.nan_to_num(field) / scale, -1, 1)
    Image.fromarray(np.round((v + 1) * 127.5).astype(np.uint8), "L").save(path, optimize=True)


def resample(xyz: np.ndarray, step: float = 0.02, nmax: int = 160) -> np.ndarray:
    """Even arclength resampling, so long loops and short ones cost alike."""
    if len(xyz) < 3:
        return xyz
    seg = np.linalg.norm(np.diff(xyz, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = int(np.clip(s[-1] / step, 6, nmax))
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, xyz[:, k]) for k in range(3)], axis=1)


def seeds(out, n_uniform: int = 260, n_flux: int = 220, n_open: int = 260, rng=None):
    """Equal-area + flux-weighted seeds near the surface, plus a source-surface
    grid so open field is sampled evenly rather than only from strong flux."""
    import astropy.units as u
    from astropy.coordinates import SkyCoord
    rng = rng or np.random.default_rng(0)
    frame = out.coordinate_frame

    # Fibonacci sphere: equal area, deterministic.
    k = np.arange(n_uniform) + 0.5
    lat_u = np.degrees(np.arcsin(1 - 2 * k / n_uniform))
    lon_u = (np.degrees(np.pi * (1 + 5 ** 0.5) * k)) % 360

    br = out.bc[0][:, :, 0].T            # (nsinlat, nphi) at r=1
    w = np.abs(br).ravel() ** 1.5
    idx = rng.choice(w.size, n_flux, replace=False, p=w / w.sum())
    ny, nx = br.shape
    iy, ix = np.unravel_index(idx, br.shape)
    lat_f = np.degrees(np.arcsin(-1 + (2 * iy + 1) / ny))
    # Grid columns follow the input map, whose first column is not lon 0.
    col0 = out.input_map.pixel_to_world(0 * u.pix, 0 * u.pix).lon.to_value("deg")
    lon_f = (col0 + ix * 360 / nx) % 360

    k = np.arange(n_open) + 0.5
    lat_o = np.degrees(np.arcsin(1 - 2 * k / n_open))
    lon_o = (np.degrees(np.pi * (1 + 5 ** 0.5) * k) + 7.0) % 360

    lat = np.concatenate([lat_u, lat_f, lat_o])
    lon = np.concatenate([lon_u, lon_f, lon_o])
    r = np.concatenate([np.full(n_uniform + n_flux, 1.05), np.full(n_open, RSS * 0.98)])
    return SkyCoord(lon * u.deg, lat * u.deg, r * 696000 * u.km, frame=frame)


def cart(fl) -> np.ndarray:
    c = fl.coords
    c.representation_type = "cartesian"
    return np.stack([c.x.to_value("km"), c.y.to_value("km"), c.z.to_value("km")], axis=1) / 696000.0


def open_flux(out) -> float:
    """Unsigned flux through the source surface [Mx]."""
    br = np.abs(out.source_surface_br.data)          # G, sin-lat grid
    ny, nx = br.shape
    dA = (4 * np.pi * (RSS * 6.957e10) ** 2) / (ny * nx)
    return float(np.nansum(br) * dA)


# --------------------------------------------------------------------- fleet
_fleet_cache: dict = {}


def _series(key: str, year: int):
    if (key, year) in _fleet_cache:
        return _fleet_cache[key, year]
    local = ROOT.parent / "heliofleet" / "data" / key / f"{year}.json"
    try:
        doc = json.loads(local.read_text()) if local.exists() else json.loads(_get(f"{FLEET_URL}/{key}/{year}.json"))
    except Exception:
        doc = None
    _fleet_cache[key, year] = doc
    return doc


def _at(key: str, jd: float, year: int):
    doc = _series(key, year)
    if not doc:
        return None
    d = np.asarray(doc["d"]).reshape(-1, 3)
    f = (jd - doc["t0"]) / doc["step"]
    i = int(np.floor(f))
    if i < 0 or i + 1 >= len(d):
        return None
    return d[i] + (f - i) * (d[i + 1] - d[i])


def fleet_positions(obstime):
    """Carrington lon/lat [deg] and r [au] for each body at `obstime`."""
    import astropy.units as u
    from astropy.coordinates import HeliocentricMeanEcliptic, SkyCoord
    from sunpy.coordinates import HeliographicCarrington

    jd, year = obstime.jd, obstime.datetime.year
    earth = _at("earth", jd, year)
    out = {}
    for key, name in FLEET.items():
        v = _at(key, jd, year)
        if v is None:
            continue
        if key.endswith("_geo"):
            if earth is None:
                continue
            v = earth + v / AU_KM
        c = SkyCoord(*(v * u.au), representation_type="cartesian",
                     frame=HeliocentricMeanEcliptic(equinox="J2000", obstime=obstime))
        h = c.transform_to(HeliographicCarrington(observer="earth", obstime=obstime))
        out[key.replace("_geo", "")] = dict(
            name=name, planet=key in PLANETS,
            lon=round(float(h.lon.to_value("deg")) % 360, 3),
            lat=round(float(h.lat.to_value("deg")), 3),
            r=round(float(h.radius.to_value("au")), 5))
    return out


def connectivity(out, tracer, fleet):
    """Ballistic Parker-spiral footpoint on the source surface for each body
    and wind speed, then the PFSS line from there down to the photosphere."""
    import astropy.units as u
    from astropy.coordinates import SkyCoord
    jobs, coords = [], []
    for key, b in fleet.items():
        if b["planet"]:
            continue
        r_rs = b["r"] * AU_KM / RSUN_KM
        for v in VSW:
            dlon = np.degrees(OMEGA * (r_rs - RSS) * RSUN_KM / v)
            lon = (b["lon"] + dlon) % 360
            lat = float(np.clip(b["lat"], -89, 89))
            jobs.append((key, v, round(lon, 3), round(lat, 3)))
            coords.append((lon, lat))
    if not coords:
        return [], []
    lon, lat = np.array(coords).T
    s = SkyCoord(lon * u.deg, lat * u.deg, np.full(len(lon), RSS * 0.995 * 696000) * u.km,
                 frame=out.coordinate_frame)
    fls = tracer.trace(s, out)
    lines = []
    for fl in fls:
        xyz = cart(fl)
        if len(xyz) and np.linalg.norm(xyz[0]) > np.linalg.norm(xyz[-1]):
            xyz = xyz[::-1]                     # photosphere -> source surface
        foot = None
        if len(xyz):
            x, y, z = xyz[0]
            foot = [round(float(np.degrees(np.arctan2(y, x)) % 360), 2),
                    round(float(np.degrees(np.arcsin(z / np.linalg.norm(xyz[0])))), 2)]
        lines.append((resample(xyz, 0.02, 120) if len(xyz) > 2 else xyz, foot))
    return jobs, lines


# ---------------------------------------------------------------------- main
def build(day: date, force: bool = False) -> bool:
    import astropy.units as u
    import sunkit_magex.pfss as pfss
    from sunkit_magex.pfss import tracing

    dest = DATA / day.isoformat()
    if (dest / "meta.json").exists() and not force:
        print(f"{day}: exists")
        return True
    url = gong_file(day)
    if url is None:
        print(f"{day}: no GONG map")
        return False
    print(f"{day}: {url.rsplit('/', 1)[1]}")

    m = load_map(url)
    out = pfss.pfss(pfss.Input(m, NR, RSS))
    tracer = tracing.PerformanceTracer()

    dest.mkdir(parents=True, exist_ok=True)
    write_png(dest / "br.png", to_equirect(m), BR_SCALE)
    ss = out.source_surface_br.data
    ss_scale = float(np.nanpercentile(np.abs(ss), 99.5)) or 1.0
    write_png(dest / "ss.png", to_equirect(out.source_surface_br), ss_scale)

    # Field lines: closed, open-positive, open-negative.
    fls = tracer.trace(seeds(out), out)
    polys, kinds = [], []
    for fl in fls:
        xyz = cart(fl)
        if len(xyz) < 3:
            continue
        kinds.append(int(fl.polarity) if fl.is_open else 0)
        polys.append(resample(xyz))

    fleet = fleet_positions(m.date)
    jobs, conn = connectivity(out, tracer, fleet)

    # One binary: field lines first, then connectivity lines.
    counts = [len(p) for p in polys] + [len(c[0]) for c in conn]
    flat = np.concatenate(polys + [c[0] for c in conn if len(c[0])]) if counts else np.zeros((0, 3))
    q = np.clip(np.round(flat * QSCALE), -32767, 32767).astype("<i2")
    (dest / "lines.bin").write_bytes(q.tobytes())

    hcs = []
    for c in out.source_surface_pils:
        lon = np.round(c.lon.to_value("deg") % 360, 2)
        lat = np.round(c.lat.to_value("deg"), 2)
        if len(lon) > 2:
            hcs.append([v for pair in zip(lon.tolist(), lat.tolist()) for v in pair])

    from sunpy.coordinates import sun
    meta = dict(
        date=day.isoformat(),
        obstime=m.date.isot[:19] + "Z",
        source=dict(name="GONG mrzqs", file=url.rsplit("/", 1)[1], url=url),
        carrington_rotation=int(sun.carrington_rotation_number(m.date)),
        L0=round(float(sun.L0(m.date).to_value("deg")), 3),
        B0=round(float(sun.B0(m.date).to_value("deg")), 3),
        model=dict(name="PFSS", code="sunkit-magex", rss=RSS, nr=NR,
                   grid=list(m.data.shape)),
        br_scale=BR_SCALE, ss_scale=round(ss_scale, 4),
        open_flux_Mx=float(f"{open_flux(out):.4e}"),
        qscale=QSCALE,
        lines=dict(count=len(polys), kind=kinds),
        counts=counts,
        hcs=hcs,
        vsw=VSW,
        fleet=fleet,
        connect=[dict(body=k, v=v, ss=[lo, la], foot=c[1])
                 for (k, v, lo, la), c in zip(jobs, conn)],
    )
    (dest / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(f"  {len(polys)} lines, {len(conn)} connections, "
          f"{sum(p.stat().st_size for p in dest.iterdir()) / 1e3:.0f} kB")
    return True


def write_index():
    days = sorted(p.name for p in DATA.iterdir() if (p / "meta.json").exists())
    (DATA / "index.json").write_text(json.dumps(dict(
        dates=days, updated=datetime.now(timezone.utc).isoformat(timespec="seconds"))))


def prune(keep_days: int = 120):
    """Keep every day in the last `keep_days`, and one day per Carrington
    rotation before that, so history stays browsable at ~0.5 MB a rotation."""
    days = sorted(p.name for p in DATA.iterdir() if (p / "meta.json").exists())
    if not days:
        return
    cutoff = (date.fromisoformat(days[-1]) - timedelta(days=keep_days)).isoformat()
    seen = set()
    for d in days:
        if d >= cutoff:
            continue
        cr = json.loads((DATA / d / "meta.json").read_text())["carrington_rotation"]
        if cr in seen:
            shutil.rmtree(DATA / d)
        seen.add(cr)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--date", type=date.fromisoformat,
                    default=datetime.now(timezone.utc).date())
    ap.add_argument("--to", type=date.fromisoformat)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--prune", action="store_true")
    a = ap.parse_args()
    warnings.filterwarnings("ignore")
    day, ok = a.date, True
    while True:
        ok = build(day, a.force) and ok
        if not a.to or day >= a.to:
            break
        day += timedelta(days=1)
    if a.prune:
        prune()
    write_index()


if __name__ == "__main__":
    main()
