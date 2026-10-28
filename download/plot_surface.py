#!/usr/bin/env python3
"""Plot the surface maps of a HelioField result file, as PNG and PDF.

Three panels in the viewer's colours:
  1. photospheric B_r (the input map),
  2. B_r on the source surface (or the cusp surface with SCS), with the
     neutral line, and the current sheet at the outer edge with SCS,
  3. the open-field footprints (the model's coronal holes), with the
     spacecraft footpoints at the wind speed of the saved view.

    python plot_surface.py heliofield_2014-03-12_surface.nc
    python plot_surface.py RESULT.nc --theme dark --out maps --dpi 200

Needs numpy, scipy and matplotlib.
"""
from __future__ import annotations

import argparse
import textwrap
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap

from heliofield_io import THEMES, body_keys, br_cmap, caption, contour_lines, fleet_color, load, model_radii


def edges(c, lo, hi):
    """Cell edges from centres, clipped to [lo, hi]."""
    e = np.concatenate([[lo], (c[1:] + c[:-1]) / 2, [hi]])
    return e


def split_wrap(line):
    """Break a (lon, lat) polyline where it crosses longitude 0/360."""
    jumps = np.where(np.abs(np.diff(line[:, 0])) > 180)[0] + 1
    return np.split(line, jumps)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="HelioField result file (.nc)")
    ap.add_argument("--theme", choices=["light", "dark"], help="colours (default: the theme of the saved view)")
    ap.add_argument("--out", help="output name without extension (default: <file>_surface)")
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--v", type=float, help="wind speed [km/s] for the footpoints (default: that of the saved view)")
    a = ap.parse_args(argv)

    res = load(a.file)
    view = res.header.get("view", {}) or {}
    th = THEMES[a.theme or view.get("theme", "light")]
    rss, r_in, r_top = model_radii(res)
    scs = "rcp_rsun" in res.attrs
    plt.rcParams.update({"font.size": 10, "text.color": th["text"], "axes.labelcolor": th["text"], "axes.edgecolor": th["muted"],
                         "xtick.color": th["muted"], "ytick.color": th["muted"], "font.family": "sans-serif"})

    lon_e = edges(res["lon"], 0, 360)
    lat_e = np.degrees(np.arcsin(np.linspace(-1, 1, len(res["lat"]) + 1)))       # sin(lat) rows
    cmap = br_cmap()
    fig, axes = plt.subplots(3, 1, figsize=(8.6, 12.6), facecolor=th["bg"], constrained_layout=True)
    fig.get_layout_engine().set(h_pad=0.12)

    def frame(ax, title):
        ax.set_facecolor(th["bg"])
        ax.set_xlim(0, 360); ax.set_ylim(-90, 90)
        ax.set_xticks(range(0, 361, 60)); ax.set_yticks(range(-90, 91, 30))
        ax.set_xlabel("Carrington longitude [°]"); ax.set_ylabel("Latitude [°]")
        ax.set_title(title, loc="left", fontsize=11, color=th["text"])
        ax.set_aspect("equal")

    # 1. Photosphere: the viewer's ±20 G scale.
    ax = axes[0]
    m = ax.pcolormesh(lon_e, lat_e, res["br_phot"], cmap=cmap, vmin=-20, vmax=20, shading="flat", rasterized=True)
    frame(ax, "Photospheric $B_r$ (model input)")
    fig.colorbar(m, ax=ax, label="$B_r$ [G]", shrink=0.85, pad=0.01)

    # 2. Source or cusp surface, scaled to its 99.5th percentile like the viewer.
    ax = axes[1]
    ss = res["br_cusp"] if scs else res["br_ss"]
    lim = float(np.nanpercentile(np.abs(ss), 99.5)) or 1.0
    m = ax.pcolormesh(lon_e, lat_e, ss, cmap=cmap, vmin=-lim, vmax=lim, shading="flat", rasterized=True)
    lines = [plt.Line2D([], [], color=th["hcs"], lw=1.8, label=f"neutral line at {r_in:g} R$_\\odot$")]
    for line in contour_lines(res, "nl"):
        for seg in split_wrap(line):
            ax.plot(seg[:, 0], seg[:, 1], color=th["hcs"], lw=1.8)
    if scs and "hcs_out_lon" in res:
        for line in contour_lines(res, "hcs_out"):
            for seg in split_wrap(line):
                ax.plot(seg[:, 0], seg[:, 1], color=th["hcs"], lw=1.2, ls="--")
        lines.append(plt.Line2D([], [], color=th["hcs"], lw=1.2, ls="--", label=f"current sheet at {r_top:g} R$_\\odot$"))
    frame(ax, f"$B_r$ on the cusp surface ({r_in:g} R$_\\odot$)" if scs else f"$B_r$ on the source surface ({rss:g} R$_\\odot$)")
    ax.legend(handles=lines, loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=2, frameon=False, fontsize=9)
    fig.colorbar(m, ax=ax, label="$B_r$ [G]", shrink=0.85, pad=0.01)

    # 3. Open-field footprints and spacecraft footpoints.
    ax = axes[2]
    cls = res["open_class"].astype(int) + 1                      # 0 inward, 1 closed, 2 outward
    fp = ListedColormap([th["neg"], th["occluder"], th["pos"]])
    m = ax.pcolormesh(edges(res["lon1"], 0, 360), edges(res["lat1"], -90, 90), cls, cmap=fp, vmin=-0.5, vmax=2.5, shading="flat", rasterized=True)
    fig.colorbar(m, ax=ax, shrink=0.85, pad=0.01).ax.set_visible(False)       # keeps the panels aligned
    frame(ax, f"Open-field footprints (open = reaches the {'cusp' if scs else 'source'} surface)")
    keys = body_keys(res)
    v = a.v or view.get("vsw", 400)
    if "conn_v" in res and keys:
        for i, key in enumerate(keys):
            if res["body_planet"][i]:
                continue
            rows = np.where((res["conn_body"] == i) & np.isclose(res["conn_v"], v))[0]
            if not len(rows) or not np.isfinite(res["foot_lon"][rows[0]]):
                continue
            k = rows[0]
            c = fleet_color(th, key)
            ax.plot(res["foot_lon"][k], res["foot_lat"][k], "o", ms=8, mfc=c, mec=th["bg"], mew=1.5)
            ax.annotate(f"{key} ({res['foot_vwsa'][k]:.0f} km/s)", (res["foot_lon"][k], res["foot_lat"][k]), xytext=(6, 6),
                        textcoords="offset points", fontsize=8.5, color=th["text"])
    handles = [plt.Line2D([], [], marker="s", ls="", ms=9, color=c, label=t) for c, t in
               [(th["pos"], "open, outward"), (th["neg"], "open, inward"), (th["occluder"], "closed")]]
    if keys:
        handles.append(plt.Line2D([], [], marker="o", ls="", ms=7, color=th["muted"], label=f"spacecraft footpoint at {v:g} km/s"))
    ax.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=4, frameon=False, fontsize=9)

    fig.suptitle("\n".join(textwrap.wrap("HelioField  ·  " + caption(res), 95)), fontsize=10, color=th["text"])
    out = a.out or str(Path(a.file).with_suffix("")) + "_surface"
    for ext in ("png", "pdf"):
        fig.savefig(f"{out}.{ext}", dpi=a.dpi, facecolor=th["bg"])
    print(f"wrote {out}.png and {out}.pdf")


if __name__ == "__main__":
    main()
