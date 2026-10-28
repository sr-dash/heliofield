"""Read HelioField result files and share the viewer's colours.

A HelioField download holds one NetCDF-3 file (``*.nc``) and a JSON header
(``*_header.json``) that describes every variable. This module reads both
into NumPy arrays, using only NumPy and SciPy:

    from heliofield_io import load
    res = load("heliofield_2014-03-12_pfss.nc")
    res["br_phot"], res.attrs["model"], res.header["view"]

It is shared by plot_surface.py, plot_3d.py and compute_corona.py.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.io import netcdf_file

AU_RS = 149597870.7 / 695700.0          # 1 au in solar radii
OMEGA = 2 * np.pi / (25.38 * 86400)      # sidereal rotation rate [rad/s]
RSUN_KM = 695700.0
L1_KEYS = ["soho", "ace", "wind", "dscovr", "aditya", "imap", "swfo"]

# The viewer's colours (js/theme.js), validated for colour-vision deficiency
# and contrast against each theme's background.
THEMES = {
    "dark": dict(bg="#080b14", occluder="#141a26", planet="#a3abbb", text="#e8eaf0", muted="#a3abbb",
                 pos="#c28412", neg="#1687a9", closed="#6b50c2", hcs="#d7506e",
                 fleet=dict(earth="#3987e5", psp="#d95926", solo="#199e70", sta="#c98500", bepi="#d55181", l1="#008300", stb="#9085e9")),
    "light": dict(bg="#f6f3ec", occluder="#d9d5cc", planet="#545c6c", text="#1b2030", muted="#545c6c",
                  pos="#a67110", neg="#0a8aae", closed="#583bab", hcs="#9c113f",
                  fleet=dict(earth="#2a78d6", psp="#e4622d", solo="#2b9c6f", sta="#b87f1d", bepi="#d26790", l1="#008300", stb="#6250d6")),
}


def fleet_color(theme: dict, key: str, planet: bool = False) -> str:
    if planet:
        return theme["planet"]
    if key in L1_KEYS:
        return theme["fleet"]["l1"]
    return theme["fleet"].get(key, theme["planet"])


class Result(dict):
    """Variables by name, with .attrs (file attributes), .var_attrs and .header."""
    attrs: dict
    var_attrs: dict
    header: dict


def _text(v):
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else v


def load(path) -> Result:
    path = Path(path)
    out = Result()
    with netcdf_file(path, "r", mmap=False) as f:
        for name, var in f.variables.items():
            out[name] = np.array(var.data)
        out.attrs = {k: _text(v) for k, v in f._attributes.items()}
        out.var_attrs = {n: {k: _text(v) for k, v in var._attributes.items()} for n, var in f.variables.items()}
    head = path.with_name(path.stem + "_header.json")
    out.header = json.loads(head.read_text()) if head.exists() else {}
    return out


def has_3d(res: Result) -> bool:
    return "br" in res and "line_x" in res


def body_keys(res: Result) -> list[str]:
    if "body_key" not in res:
        return []
    return [b"".join(row).decode().rstrip("\x00") for row in res["body_key"]]


def polylines(res: Result, prefix: str = "line") -> list[np.ndarray]:
    """Field lines (or connection lines with prefix 'cline') as (n, 3) arrays."""
    if f"{prefix}_x" not in res:
        return []
    xyz = np.stack([res[f"{prefix}_x"], res[f"{prefix}_y"], res[f"{prefix}_z"]], 1)
    return [xyz[s:s + n] for s, n in zip(res[f"{prefix}_start"], res[f"{prefix}_count"])]


def contour_lines(res: Result, prefix: str = "nl") -> list[np.ndarray]:
    """Neutral lines as (n, 2) arrays of (lon, lat) [deg]."""
    if f"{prefix}_lon" not in res:
        return []
    lon, lat, idx = res[f"{prefix}_lon"], res[f"{prefix}_lat"], res[f"{prefix}_line"]
    return [np.stack([lon[idx == i], lat[idx == i]], 1) for i in np.unique(idx) if i >= 0]


def model_radii(res: Result) -> tuple[float, float, float]:
    """(source surface, PFSS outer boundary drawn, start of the heliosphere)."""
    a = res.attrs
    rss = float(a["rss_rsun"])
    rcp = float(a["rcp_rsun"]) if "rcp_rsun" in a else None
    rout = float(a["rout_rsun"]) if "rout_rsun" in a else None
    return rss, rcp or rss, rout or rss


def map_r(r, rss: float, log: bool = True):
    """The viewer's log-distance display: true inside the source surface,
    compressed beyond it with slope 1 at R_ss (1 au near 25 R_sun)."""
    r = np.asarray(r, float)
    if not log:
        return r
    k = 2.5 * rss
    return np.where(r <= rss, r, rss + k * np.log1p(np.maximum(r - rss, 0) / k))


def warp(xyz: np.ndarray, rss: float, log: bool = True) -> np.ndarray:
    r = np.linalg.norm(xyz, axis=-1, keepdims=True)
    return xyz * np.where(r > 0, map_r(r, rss, log) / np.where(r > 0, r, 1), 1)


def sph(r, lon_deg, lat_deg) -> np.ndarray:
    lon, lat = np.radians(lon_deg), np.radians(lat_deg)
    return np.stack(np.broadcast_arrays(r * np.cos(lat) * np.cos(lon), r * np.cos(lat) * np.sin(lon), r * np.sin(lat)), -1)


def diverging_lut(n: int = 256) -> np.ndarray:
    """The surface B_r colour scale (js/theme.js): gold and cerulean poles at
    equal OKLab lightness around a silver midpoint. Returns (n, 3) in 0..1."""
    def lab(L, C, h):
        return np.array([L, C * np.cos(np.radians(h)), C * np.sin(np.radians(h))])

    def srgb(c):
        L, a, b = c
        l_, m_, s_ = L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.2914855480 * b
        l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
        rgb = np.array([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]).clip(0, 1)
        return np.round(255 * np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * rgb ** (1 / 2.4) - 0.055)) / 255

    neg, pos, mid = lab(0.62, 0.13, 225), lab(0.62, 0.13, 75), lab(0.93, 0.006, 250)
    out = np.zeros((n, 3))
    for i in range(n):
        s = i / (n - 1) * 2 - 1
        t = abs(s) ** 0.75
        out[i] = srgb(mid + t * ((neg if s < 0 else pos) - mid))
    return out


def br_cmap():
    from matplotlib.colors import ListedColormap
    return ListedColormap(diverging_lut(), name="heliofield_br")


def caption(res: Result) -> str:
    a = res.attrs
    parts = [f"{a.get('date', '')}", a.get("source", ""), a.get("model", "")]
    if "L0_deg" in a:
        parts.append(f"Earth L0 {float(a['L0_deg']):.1f}°, B0 {float(a['B0_deg']):.1f}°")
    return " · ".join(p for p in parts if p)
