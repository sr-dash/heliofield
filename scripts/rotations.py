"""PFSS solutions of the HMI rotation archive (data/history/cr), for the
validation and series scripts.

Each rotation is solved once with sunkit-magex, on the same settings as the
daily product (R_ss = 2.5 R_sun, 40 shells), and kept in cache/solve/:

    ss    source-surface B_r [G], 180 x 360, rows uniform in sin(latitude)
          from the south, column j centred on Carrington longitude j + 0.5
    open  photospheric footprint class on the same grid: +1 / -1 where the
          field line traced from 1.001 R_sun reaches the source surface
          (its sign is the polarity), 0 where it closes
    flux  unsigned flux through the source surface [Mx]
"""
from __future__ import annotations

import gzip
import json
import warnings
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "data" / "history"
CACHE = ROOT / "cache" / "solve"
RSS, NR = 2.5, 40
RSUN_KM = 695700.0
VERSION = 1


def rotation_index() -> list[dict]:
    return json.loads((HIST / "index.json").read_text())["rotations"]


def load_cr(cr: int) -> np.ndarray:
    raw = gzip.decompress((HIST / "cr" / f"{cr}.bin.gz").read_bytes())
    return np.frombuffer(raw, "<i2").reshape(180, 360).astype(float) * 0.1


def sinlat_map(br: np.ndarray, date_obs: str):
    """A sunpy CEA map for a 180 x 360 sin(lat) grid whose column j is centred
    on Carrington longitude j + 0.5 deg."""
    import sunpy.map
    ny, nx = br.shape
    meta = {"ctype1": "CRLN-CEA", "ctype2": "CRLT-CEA", "cunit1": "deg", "cunit2": "deg",
            "crpix1": (nx + 1) / 2, "crval1": 180.0, "cdelt1": 360 / nx,
            "crpix2": (ny + 1) / 2, "crval2": 0.0, "cdelt2": 180 / np.pi * 2 / ny, "pv2_1": 1.0,
            "date-obs": date_obs, "naxis": 2, "naxis1": nx, "naxis2": ny, "rsun_ref": RSUN_KM * 1e3}
    return sunpy.map.Map(br, meta)


def solve_map(smap) -> dict:
    """Source-surface B_r, open-footprint classes and open flux of one map
    (sin-lat grid, column 0 at Carrington longitude 0.5)."""
    import astropy.units as u
    from astropy.coordinates import SkyCoord
    import sunkit_magex.pfss as pfss
    from sunkit_magex.pfss import tracing
    warnings.filterwarnings("ignore")
    out = pfss.pfss(pfss.Input(smap, NR, RSS))
    ss = out.source_surface_br.data.astype(np.float32)
    ny, nx = ss.shape
    lat = np.degrees(np.arcsin(np.linspace(-1 + 1 / ny, 1 - 1 / ny, ny)))
    lon = (np.arange(nx) + 0.5) * 360 / nx
    LO, LA = np.meshgrid(lon, lat)
    seeds = SkyCoord(LO.ravel() * u.deg, LA.ravel() * u.deg, np.full(LO.size, 1.001 * RSUN_KM) * u.km,
                     frame=out.coordinate_frame)
    fls = tracing.PerformanceTracer().trace(seeds, out)
    cls = np.array([int(f.polarity) if f.is_open else 0 for f in fls], np.int8).reshape(ny, nx)
    flux = float(np.nansum(np.abs(ss)) * 4 * np.pi * (RSS * RSUN_KM * 1e5) ** 2 / ss.size)
    return dict(ss=ss, open=cls, flux=flux)


def solve(cr: int, start: str) -> dict:
    """Cached solve of rotation `cr`."""
    path = CACHE / f"{cr}.npz"
    if path.exists():
        z = np.load(path)
        if int(z["version"]) == VERSION:
            return dict(ss=z["ss"], open=z["open"], flux=float(z["flux"]))
    res = solve_map(sinlat_map(load_cr(cr), start.rstrip("Z")))
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, version=VERSION, **res)
    return res


def neutral_line_tilt(ss: np.ndarray) -> tuple[float, float]:
    """Highest northern and southern latitude [deg] reached by the
    source-surface neutral line, from sign changes between grid neighbours
    interpolated linearly in sin(latitude)."""
    ny, nx = ss.shape
    s = np.linspace(-1 + 1 / ny, 1 - 1 / ny, ny)
    lats = []
    a, b = ss[:-1], ss[1:]
    i, j = np.nonzero(np.sign(a) != np.sign(b))
    f = a[i, j] / (a[i, j] - b[i, j])
    lats.append(np.degrees(np.arcsin(s[i] + f * (s[1] - s[0]))))
    a, b = ss, np.roll(ss, -1, axis=1)
    i, j = np.nonzero(np.sign(a) != np.sign(b))
    lats.append(np.degrees(np.arcsin(s[i])))
    lat = np.concatenate(lats)
    if not lat.size:
        return 0.0, 0.0
    return float(max(lat.max(), 0)), float(max(-lat.min(), 0))

