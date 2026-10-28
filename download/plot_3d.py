#!/usr/bin/env python3
"""Render a HelioField 3D result as the viewer shows it, to PNG and PDF.

The Sun is drawn as a shaded sphere coloured by photospheric B_r. Field
lines are closed violet, open gold (outward) or cerulean (inward), and hidden
where the Sun is in front of them. The figure also shows the neutral line, the
current-sheet ribs with SCS, and spacecraft with their Parker spirals and
connection lines. The camera, theme, wind speed and log-distance scale default
to the view that was on screen when the file was saved.

    python plot_3d.py heliofield_2014-03-12_pfss.nc
    python plot_3d.py RESULT.nc --lon 300 --lat 20 --dist 12 --all-lines --theme light
    python plot_3d.py RESULT.nc --true-distance --dist 40

A surface-only download has no 3D field: run compute_corona.py on it first.
Needs numpy, scipy and matplotlib.
"""
from __future__ import annotations

import heliofield_update                 # first: package-version notes, and an update if the script fails
heliofield_update.install()

import argparse
import sys
import textwrap
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection, PolyCollection

from heliofield_io import (AU_RS, OMEGA, RSUN_KM, THEMES, body_keys, caption, contour_lines, diverging_lut,
                           fleet_color, has_3d, load, map_r, model_radii, polylines, sph, warp)


def dot(a, b):
    # Explicit sums: NumPy's matmul through Apple's Accelerate can raise
    # spurious floating-point warnings.
    return (np.asarray(a) * np.asarray(b)).sum(-1)


class Camera:
    """Perspective camera looking at the Sun's centre, z (rotation axis) up."""

    def __init__(self, lon, lat, dist, fov, w, h):
        self.pos = sph(dist, lon, lat)
        f = -self.pos / np.linalg.norm(self.pos)
        up = np.array([0.0, 0.0, 1.0])
        r = np.cross(f, up)
        if np.linalg.norm(r) < 1e-6:                       # looking down the axis
            r = np.cross(f, [0.0, 1.0, 0.0])
        r /= np.linalg.norm(r)
        self.f, self.r, self.u = f, r, np.cross(r, f)
        self.t = np.tan(np.radians(fov) / 2)
        self.w, self.h = w, h

    def project(self, p):
        v = p - self.pos
        zc = dot(v, self.f)
        x = dot(v, self.r) / (zc * self.t) * (self.h / 2) + self.w / 2
        y = dot(v, self.u) / (zc * self.t) * (self.h / 2) + self.h / 2
        return np.stack([x, y], -1), zc

    def visible(self, p):
        """Not behind the unit sphere (the photosphere) as seen from the camera."""
        d = p - self.pos
        L = np.linalg.norm(d, axis=-1)
        u = d / L[..., None]
        b = dot(u, self.pos)
        c = dot(self.pos, self.pos) - 1
        disc = b * b - c
        t0 = -b - np.sqrt(np.maximum(disc, 0))
        hidden = (disc > 0) & (t0 > 0) & (t0 < L - 1e-6)
        return ~hidden & (np.linalg.norm(p, axis=-1) >= 0.999)


def sun_image(cam, res, lut, key="br_phot", mu_floor=0.55):
    """RGBA image of the photosphere, B_r on the viewer's ±20 G scale, with the
    viewer's limb shading: colour * mix(0.55, 1, sqrt(mu))."""
    ys, xs = np.mgrid[0:cam.h, 0:cam.w] + 0.5
    dx = (xs - cam.w / 2) / (cam.h / 2) * cam.t
    dy = (ys - cam.h / 2) / (cam.h / 2) * cam.t
    d = cam.f + dx[..., None] * cam.r + dy[..., None] * cam.u
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    b = dot(d, cam.pos)
    disc = b * b - (dot(cam.pos, cam.pos) - 1)
    hit = disc > 0
    t = -b - np.sqrt(np.where(hit, disc, 0))
    p = cam.pos + t[..., None] * d
    lon = np.degrees(np.arctan2(p[..., 1], p[..., 0])) % 360
    sinlat = np.clip(p[..., 2], -1, 1)
    ny, nx = res[key].shape
    i = np.clip(((sinlat + 1) / 2 * ny).astype(int), 0, ny - 1)
    j = np.clip((lon / 360 * nx).astype(int), 0, nx - 1)
    s = np.clip(res[key][i, j] / 20.0, -1, 1)
    rgb = lut[np.round((s + 1) / 2 * 255).astype(int)]
    mu = np.clip(-(p * d).sum(-1), 0, 1)
    rgb = rgb * (mu_floor + (1 - mu_floor) * np.sqrt(mu))[..., None]
    img = np.zeros((cam.h, cam.w, 4))
    img[..., :3] = rgb
    img[..., 3] = hit
    return img


def draw_poly(ax, cam, pts, color, lw, alpha=1.0, z=3):
    """A 3D polyline, split where it passes behind the Sun or behind the camera."""
    if len(pts) < 2:
        return
    xy, zc = cam.project(pts)
    ok = cam.visible(pts) & (zc > 0.05)
    segs = np.stack([xy[:-1], xy[1:]], 1)[ok[:-1] & ok[1:]]
    if len(segs):
        ax.add_collection(LineCollection(segs, colors=color, linewidths=lw, alpha=alpha, zorder=z, capstyle="round"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="HelioField result file with a 3D field (.nc)")
    ap.add_argument("--lon", type=float, help="camera Carrington longitude [deg]")
    ap.add_argument("--lat", type=float, help="camera latitude [deg]")
    ap.add_argument("--dist", type=float, help="camera distance (display units, R_sun inside the source surface)")
    ap.add_argument("--fov", type=float, help="vertical field of view [deg] (viewer: 35)")
    ap.add_argument("--theme", choices=["light", "dark"])
    ap.add_argument("--v", type=float, help="wind speed for the spacecraft spirals [km/s]")
    ap.add_argument("--rmax", type=float, default=None, help="draw spirals out to this distance [au] (default 1.2)")
    ap.add_argument("--true-distance", action="store_true", help="no log compression beyond the source surface")
    ap.add_argument("--model-surface", action="store_true",
                    help="colour the Sun with the model's smoothed boundary (br_phot) instead of the input map, as the web page does")
    ap.add_argument("--all-lines", action="store_true", help="draw every traced line, not only the ones drawn in the viewer")
    ap.add_argument("--size", default="1600x1200", help="image size in pixels, WxH")
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--out", help="output name without extension (default: <file>_3d)")
    a = ap.parse_args(argv)

    res = load(a.file)
    if not has_3d(res):
        sys.exit("This file has surface maps only. Run compute_corona.py on it to compute the 3D field first.")
    view = res.header.get("view", {}) or {}
    th = THEMES[a.theme or view.get("theme", "dark")]
    log = not a.true_distance and view.get("logScale", True)
    rss, r_in, r_top = model_radii(res)
    w, h = (int(x) for x in a.size.lower().split("x"))
    cam = Camera(a.lon if a.lon is not None else view.get("lon", 330.0), a.lat if a.lat is not None else view.get("lat", 15.0),
                 a.dist or view.get("dist", 9.0), a.fov or view.get("fov", 35.0), w, h)
    v = a.v or view.get("vsw", 400.0)
    lut = diverging_lut()

    fig = plt.figure(figsize=(w / a.dpi, h / a.dpi), dpi=a.dpi, facecolor=th["bg"])
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, w); ax.set_ylim(0, h); ax.set_axis_off(); ax.set_facecolor(th["bg"])
    surface = "br_input" if "br_input" in res and not a.model_surface else "br_phot"
    ax.imshow(sun_image(cam, res, lut, surface), origin="lower", extent=(0, w, 0, h), zorder=2, interpolation="bilinear")

    lw = 1.1 * w / 1600
    lines, kinds = polylines(res), res["line_kind"]
    drawn = np.ones(len(lines), bool) if a.all_lines else res["line_drawn"].astype(bool)
    colors = {0: th["closed"], 1: th["pos"], -1: th["neg"]}
    for p, k, d in zip(lines, kinds, drawn):
        if d:
            draw_poly(ax, cam, warp(p.astype(float), rss, log), colors[int(k)], lw, 0.9 if k == 0 else 1.0)

    for line in contour_lines(res, "nl"):
        draw_poly(ax, cam, sph(r_in * 1.004, line[:, 0], line[:, 1]), th["hcs"], 1.6 * lw)
    if "rib_lon" in res:
        # The current sheet between the cusp surface and the outer edge: a
        # translucent surface between neighbouring ribs, as in the viewer.
        P = warp(sph(res["rib_r"], res["rib_lon"], res["rib_lat"]), rss, log)      # (rib, level, 3)
        xy, zc = cam.project(P)
        vis = cam.visible(P) & (zc > 0.05)
        same = res["rib_line"][1:] == res["rib_line"][:-1]
        quads = []
        for k in np.where(same)[0]:
            for j in range(P.shape[1] - 1):
                if vis[k, j] and vis[k, j + 1] and vis[k + 1, j] and vis[k + 1, j + 1]:
                    quads.append([xy[k, j], xy[k, j + 1], xy[k + 1, j + 1], xy[k + 1, j]])
        if quads:
            ax.add_collection(PolyCollection(quads, facecolors=th["hcs"], edgecolors="face", linewidths=0.4,
                                             alpha=0.10 if th is THEMES["dark"] else 0.08, zorder=3))
        for line in contour_lines(res, "hcs_out"):
            draw_poly(ax, cam, warp(sph(r_top, line[:, 0], line[:, 1]), rss, log), th["hcs"], 1.4 * lw)

    # Spacecraft: the Parker spiral from the model's outer boundary, the
    # connection field line below it, and the marker with its label.
    keys = body_keys(res)
    clines = polylines(res, "cline")
    for i, key in enumerate(keys):
        planet = bool(res["body_planet"][i])
        c = fleet_color(th, key, planet)
        r_b = float(res["body_r"][i]) * AU_RS
        pos = warp(sph(r_b, res["body_lon"][i], res["body_lat"][i]), rss, log)
        xy, zc = cam.project(pos)
        if zc <= 0.05:
            continue
        if not planet and "conn_v" in res:
            rows = np.where((res["conn_body"] == i) & np.isclose(res["conn_v"], v))[0]
            if len(rows):
                k = rows[0]
                rr = r_top * (r_b / r_top) ** np.linspace(0, 1, 160)
                lon = res["conn_top_lon"][k] - np.degrees(OMEGA * (rr - r_top) * RSUN_KM / v)
                draw_poly(ax, cam, warp(sph(rr, lon, res["conn_top_lat"][k]), rss, log), c, 1.3 * lw, 0.95)
            for j, p in enumerate(clines):
                if res["cline_body"][j] == i and np.isclose(res["cline_v"][j], v):
                    draw_poly(ax, cam, warp(p.astype(float), rss, log), c, 1.6 * lw)
        if 0 <= xy[0] <= w and 0 <= xy[1] <= h and cam.visible(pos[None])[0]:
            ax.plot(*xy, "o", ms=6 if planet else 7.5, mfc=c, mec=th["bg"], mew=1.2, zorder=6)
            ax.annotate(key, xy, xytext=(7, 5), textcoords="offset points", fontsize=8, color=th["text"], zorder=6)

    handles = [plt.Line2D([], [], color=th["closed"], lw=2, label="closed"), plt.Line2D([], [], color=th["pos"], lw=2, label="open +"),
               plt.Line2D([], [], color=th["neg"], lw=2, label="open −"), plt.Line2D([], [], color=th["hcs"], lw=2, label="neutral line / current sheet")]
    ax.legend(handles=handles, loc="lower left", frameon=False, fontsize=8, labelcolor=th["text"], ncol=4)
    cl = cam.pos
    view_txt = f"view from lon {np.degrees(np.arctan2(cl[1], cl[0])) % 360:.0f}°, lat {np.degrees(np.arcsin(cl[2] / np.linalg.norm(cl))):.0f}°"
    title = "HelioField  ·  " + caption(res) + f" · {view_txt} · wind {v:g} km/s" + (" · log distance" if log else "")
    ax.text(0.012, 0.985, "\n".join(textwrap.wrap(title, 110)), transform=ax.transAxes, va="top", fontsize=8, color=th["text"])

    out = a.out or str(Path(a.file).with_suffix("")) + "_3d"
    for ext in ("png", "pdf"):
        fig.savefig(f"{out}.{ext}", dpi=a.dpi, facecolor=th["bg"])
    print(f"wrote {out}.png and {out}.pdf")


if __name__ == "__main__":
    main()
