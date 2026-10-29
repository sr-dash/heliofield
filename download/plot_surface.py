#!/usr/bin/env python3
"""Plot the surface maps of a HelioField result file, as PNG and PDF.

Three panels in the viewer's colours:
  1. photospheric B_r as the model uses it (the input map smoothed by the
     tapered harmonic expansion, with zero net flux), or with --input the
     input map itself,
  2. B_r on the source surface (or the cusp surface with SCS), with the
     neutral line, and the current sheet at the outer edge with SCS,
  3. the open-field footprints (the model's coronal holes), with the
     spacecraft footpoints at the wind speed of the saved view.

    python plot_surface.py heliofield_2014-03-12_surface.nc
    python plot_surface.py RESULT.nc --theme dark --out maps --dpi 200

Needs numpy, scipy and matplotlib.
"""
from __future__ import annotations

import heliofield_update                 # first: package-version notes, and an update if the script fails
heliofield_update.install()

import argparse
import textwrap
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap

from heliofield_io import L1_KEYS, THEMES, body_keys, body_names, br_cmap, caption, contour_lines, fleet_color, load, model_radii


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
    ap.add_argument("--input", action="store_true", help="show the input map (br_input) instead of the model's smoothed boundary (br_phot)")
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
    # Maps in the left column, all the same size; colour bars and the
    # footpoint list in the right one.
    fig = plt.figure(figsize=(10, 12.2), facecolor=th["bg"], constrained_layout=True)
    fig.get_layout_engine().set(h_pad=0.12)
    gs = fig.add_gridspec(3, 2, width_ratios=[1, 0.3], wspace=0.02)
    axes = [fig.add_subplot(gs[i, 0]) for i in range(3)]
    side = [fig.add_subplot(gs[i, 1]) for i in range(3)]
    for sa in side:
        sa.set_axis_off()

    def colorbar(m, i, label):
        cax = side[i].inset_axes([0.02, 0.12, 0.07, 0.76])
        fig.colorbar(m, cax=cax, label=label)

    def frame(ax, title):
        ax.set_facecolor(th["bg"])
        ax.set_xlim(0, 360); ax.set_ylim(-90, 90)
        ax.set_xticks(range(0, 361, 60)); ax.set_yticks(range(-90, 91, 30))
        ax.set_xlabel("Carrington longitude [°]"); ax.set_ylabel("Latitude [°]")
        ax.set_title(title, loc="left", fontsize=11, color=th["text"])
        ax.set_aspect("equal")

    # 1. Photosphere: the viewer's ±20 G scale.
    ax = axes[0]
    raw = a.input and "br_input" in res
    m = ax.pcolormesh(lon_e, lat_e, res["br_input"] if raw else res["br_phot"], cmap=cmap, vmin=-20, vmax=20, shading="flat", rasterized=True)
    frame(ax, "Photospheric $B_r$: input map" if raw or "br_input" not in res
          else "Photospheric $B_r$ as used by the model (smoothed, zero net flux)")
    colorbar(m, 0, "$B_r$ [G]")

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
    colorbar(m, 1, "$B_r$ [G]")

    # 3. Open-field footprints and spacecraft footpoints.
    ax = axes[2]
    cls = res["open_class"].astype(int) + 1                      # 0 inward, 1 closed, 2 outward
    fp = ListedColormap([th["neg"], th["occluder"], th["pos"]])
    m = ax.pcolormesh(edges(res["lon1"], 0, 360), edges(res["lat1"], -90, 90), cls, cmap=fp, vmin=-0.5, vmax=2.5, shading="flat", rasterized=True)
    frame(ax, f"Open-field footprints (open = reaches the {'cusp' if scs else 'source'} surface)")
    keys, names = body_keys(res), body_names(res)
    v = a.v or view.get("vsw", 400)
    entries = []                       # (colour, name, footpoint row) for the list on the right
    if "conn_v" in res and keys:
        l1_done = False
        for i, key in enumerate(keys):
            if res["body_planet"][i]:
                continue
            rows = np.where((res["conn_body"] == i) & np.isclose(res["conn_v"], v))[0]
            if not len(rows) or not np.isfinite(res["foot_lon"][rows[0]]):
                continue
            if key in L1_KEYS:          # the L1 monitors share one footpoint: one entry
                if l1_done:
                    continue
                l1_done, name = True, "L1 monitors"
            else:
                name = names[i]
            k, c = rows[0], fleet_color(th, key)
            ax.plot(res["foot_lon"][k], res["foot_lat"][k], "o", ms=8, mfc=c, mec=th["bg"], mew=1.5, zorder=5)
            entries.append((c, name, k))
    # The footpoint list: marker colour, name, and what the model says there.
    sa = side[2]
    sa.text(0.02, 0.97, f"Footpoints at {v:g} km/s", transform=sa.transAxes, va="top", fontsize=10, fontweight="bold", color=th["text"])
    y, step = 0.88, min(0.12, 0.85 / max(1, len(entries)))
    for c, name, k in entries:
        sa.plot([0.05], [y - 0.012], "o", ms=8, mfc=c, mec=th["bg"], mew=1.2, transform=sa.transAxes, clip_on=False)
        sa.text(0.12, y, name, transform=sa.transAxes, va="top", fontsize=9, color=th["text"])
        sa.text(0.12, y - step * 0.42, f"{res['foot_lon'][k]:.0f}°, {res['foot_lat'][k]:+.0f}°  ·  {res['foot_vwsa'][k]:.0f} km/s",
                transform=sa.transAxes, va="top", fontsize=8.5, color=th["muted"])
        y -= step
    if not entries:
        sa.text(0.02, 0.88, "no spacecraft footpoints", transform=sa.transAxes, va="top", fontsize=9, color=th["muted"])
    handles = [plt.Line2D([], [], marker="s", ls="", ms=9, color=c, label=t) for c, t in
               [(th["pos"], "open, outward"), (th["neg"], "open, inward"), (th["occluder"], "closed")]]
    ax.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=3, frameon=False, fontsize=9)

    fig.suptitle("\n".join(textwrap.wrap("HelioField  ·  " + caption(res), 95)), fontsize=10, color=th["text"])
    out = a.out or str(Path(a.file).with_suffix("")) + "_surface"
    for ext in ("png", "pdf"):
        fig.savefig(f"{out}.{ext}", dpi=a.dpi, facecolor=th["bg"])
    print(f"wrote {out}.png and {out}.pdf")


if __name__ == "__main__":
    main()
