#!/usr/bin/env python3
"""Icons and the social-preview image for HelioField.

    python scripts/make_icons.py                  # from the newest daily product
    python scripts/make_icons.py --date 2026-10-17

Writes assets/: favicon.svg, favicon-16/32.png, apple-touch-icon.png,
icon-192/512.png, icon-maskable-512.png, og-image.png (1200x630), and
favicon.ico at the repository root.

The icon is a Sun with open field lines leaving its poles (gold outward,
cerulean inward) and closed loops either side (violet). The preview image is
the real field of one day seen from Earth: the photospheric map in the site's
diverging scale, the first 250 field lines in the viewer's order, and the
source-surface neutral line, all in the dark-theme colours of js/theme.js.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

# Dark-theme colours, as in js/theme.js. The icon uses a lighter violet:
# it is a mark, not data, and must read at 16 px on the dark tile.
BG = "#080b14"
POS, NEG, CLOSED, HCS = "#c28412", "#1687a9", "#6b50c2", "#d7506e"
ICON_CLOSED, SUN = "#8f78e0", "#e9ecf2"
TEXT, MUTED = "#e8eaf0", "#a3abbb"

# Icon geometry on a 64-unit square: (colour, cubic Bezier control points).
STROKES = [
    (POS, [(32, 20), (32, 10), (30, 6), (25, 2.5)]),
    (POS, [(32, 20), (33, 10), (36, 6), (41, 2.5)]),
    (NEG, [(32, 44), (32, 54), (30, 58), (25, 61.5)]),
    (NEG, [(32, 44), (33, 54), (36, 58), (41, 61.5)]),
    (ICON_CLOSED, [(21, 26), (8, 19), (8, 45), (21, 38)]),
    (ICON_CLOSED, [(43, 26), (56, 19), (56, 45), (43, 38)]),
]
SUN_R, STROKE_W = 12.5, 3.4


def svg() -> str:
    paths = "\n    ".join(
        f'<path d="M{a[0]} {a[1]} C {b[0]} {b[1]}, {c[0]} {c[1]}, {d[0]} {d[1]}" stroke="{col}"/>'
        for col, (a, b, c, d) in STROKES)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <title>HelioField</title>
  <rect width="64" height="64" rx="14" fill="{BG}"/>
  <g fill="none" stroke-linecap="round" stroke-width="{STROKE_W}">
    {paths}
  </g>
  <circle cx="32" cy="32" r="{SUN_R}" fill="{SUN}"/>
</svg>
"""


def bezier(p, n=40):
    t = np.linspace(0, 1, n)[:, None]
    p = np.array(p, float)
    return ((1 - t) ** 3) * p[0] + 3 * ((1 - t) ** 2) * t * p[1] + 3 * (1 - t) * t ** 2 * p[2] + t ** 3 * p[3]


def icon(size: int, maskable: bool = False) -> Image.Image:
    """Raster the icon at 8x and downsample, so thin strokes stay smooth."""
    ss = 8
    S = size * ss
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:
        d.rectangle([0, 0, S, S], fill=BG)            # full bleed; art in the safe zone
        k, off = S / 64 * 0.72, S * 0.14
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 14 / 64, fill=BG)
        k, off = S / 64, 0
    for col, pts in STROKES:
        xy = [(off + x * k, off + y * k) for x, y in bezier(pts)]
        w = max(1, round(STROKE_W * k))
        d.line(xy, fill=col, width=w, joint="curve")
        for x, y in (xy[0], xy[-1]):
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=col)
    c, r = off + 32 * k, SUN_R * k
    d.ellipse([c - r, c - r, c + r, c + r], fill=SUN)
    return im.resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------- preview
def lut():
    """The surface colour map of js/theme.js (OKLab, gold/silver/cerulean)."""
    def lab(L, C, h):
        return np.array([L, C * np.cos(np.radians(h)), C * np.sin(np.radians(h))])

    def srgb(L, a, b):
        l_, m_, s_ = L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.2914855480 * b
        l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
        rgb = np.array([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s])
        rgb = np.clip(rgb, 0, 1)
        return np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * rgb ** (1 / 2.4) - 0.055)

    neg, pos, mid = lab(0.62, 0.13, 225), lab(0.62, 0.13, 75), lab(0.93, 0.006, 250)
    out = np.zeros((256, 3))
    for i in range(256):
        s = i / 255 * 2 - 1
        t = abs(s) ** 0.75
        out[i] = srgb(*(mid + t * ((neg if s < 0 else pos) - mid)))
    return out


def line_order(n):
    """The viewer's fixed shuffle (js/main.js lineOrder), so the image shows
    the same 250 lines a visitor sees by default."""
    idx = list(range(n))
    seed = 7
    for i in range(n - 1, 0, -1):
        seed = (seed * 1664525 + 1013904223) % 4294967296
        j = int(seed / 4294967296 * (i + 1))
        idx[i], idx[j] = idx[j], idx[i]
    return idx


def font(size, bold=False):
    base = Path("/System/Library/Fonts/Supplemental")
    for name in (["Arial Bold.ttf"] if bold else ["Arial.ttf"]):
        if (base / name).exists():
            return ImageFont.truetype(str(base / name), size)
    return ImageFont.load_default(size)


def preview(day: str) -> Image.Image:
    src = ROOT / "data" / day
    meta = json.loads((src / "meta.json").read_text())
    q = np.fromfile(src / "lines.bin", "<i2").reshape(-1, 3) / meta["qscale"]
    br = np.asarray(Image.open(src / "br.png"), float) / 127.5 - 1      # north row first
    ss, W, H = 2, 1200, 630
    im = Image.new("RGB", (W * ss, H * ss), BG)

    # Earth's view: n towards Earth, solar north up, west to the right.
    L0, B0 = np.radians(meta["L0"]), np.radians(meta["B0"])
    n = np.array([np.cos(B0) * np.cos(L0), np.cos(B0) * np.sin(L0), np.sin(B0)])
    up = np.array([0, 0, 1.0]) - n[2] * n
    up /= np.linalg.norm(up)
    right = np.cross(up, n)
    cx, cy, R = 925 * ss, 315 * ss, 128 * ss

    # Photosphere.
    colors = lut()
    y, x = np.mgrid[0:H * ss, 0:W * ss]
    u, v = (x - cx) / R, -(y - cy) / R
    inside = u * u + v * v < 1
    w = np.sqrt(np.clip(1 - u * u - v * v, 0, 1))
    P = u[..., None] * right + v[..., None] * up + w[..., None] * n
    lon = (np.degrees(np.arctan2(P[..., 1], P[..., 0])) % 360)
    lat = np.degrees(np.arcsin(np.clip(P[..., 2], -1, 1)))
    # Bilinear, with longitude wrapping, so the 1-degree map does not look blocky.
    from scipy.ndimage import map_coordinates
    padded = np.concatenate([br, br[:, :1]], axis=1)
    s = map_coordinates(padded, [np.clip(89.5 - lat, 0, 179), lon - 0.5], order=1, mode="nearest")
    rgb = colors[np.clip(((s + 1) / 2 * 255).round().astype(int), 0, 255)] * (0.55 + 0.45 * np.sqrt(w))[..., None]
    arr = np.asarray(im).copy()
    arr[inside] = (rgb[inside] * 255).astype(np.uint8)
    im = Image.fromarray(arr)
    d = ImageDraw.Draw(im)

    def proj(p):
        return cx + R * (p @ right), cy - R * (p @ up), p @ n

    def hidden(p):
        a, b, depth = proj(p)
        return depth < 0 and ((a - cx) ** 2 + (b - cy) ** 2) < R * R

    # Field lines, in the viewer's default subset.
    counts = meta["counts"]
    offs = np.concatenate([[0], np.cumsum(counts)])
    kind = meta["lines"]["kind"]
    nf = meta["lines"]["count"]
    for i in line_order(nf)[:250]:
        pts = q[offs[i]:offs[i + 1]]
        col = CLOSED if kind[i] == 0 else (POS if kind[i] > 0 else NEG)
        for a, b in zip(pts[:-1], pts[1:]):
            if hidden(a) or hidden(b):
                continue
            pa, pb = proj(a), proj(b)
            d.line([pa[:2], pb[:2]], fill=col, width=2 * ss)

    # Source-surface neutral line.
    for h in meta["hcs"]:
        ll = np.radians(np.array(h).reshape(-1, 2))
        pts = 2.5 * 1.004 * np.c_[np.cos(ll[:, 1]) * np.cos(ll[:, 0]), np.cos(ll[:, 1]) * np.sin(ll[:, 0]), np.sin(ll[:, 1])]
        for a, b in zip(pts[:-1], pts[1:]):
            if hidden(a) or hidden(b):
                continue
            d.line([proj(a)[:2], proj(b)[:2]], fill=HCS, width=3 * ss)

    # Text panel on the left; field lines reaching into it are covered.
    im = im.resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 640, H], fill=BG)
    d.text((64, 170), "HelioField", font=font(80, True), fill=TEXT)
    d.text((66, 270), "The Sun's coronal magnetic field in 3D", font=font(29), fill=TEXT)
    for k, t in enumerate(["PFSS field lines, source surface,", "heliospheric current sheet and", "spacecraft connectivity, any date since 2010"]):
        d.text((66, 330 + 34 * k), t, font=font(24), fill=MUTED)
    d.text((66, 520), "sr-dash.github.io/heliofield", font=font(22, True), fill=TEXT)
    # Legend chips.
    x = 66
    for label, col in [("open +", POS), ("open −", NEG), ("closed", CLOSED), ("neutral line", HCS)]:
        d.rounded_rectangle([x, 470, x + 22, 476], radius=3, fill=col)
        d.text((x + 30, 462), label, font=font(19), fill=MUTED)
        x += 30 + d.textlength(label, font=font(19)) + 26
    return im


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--date")
    a = ap.parse_args()
    ASSETS.mkdir(exist_ok=True)
    (ASSETS / "favicon.svg").write_text(svg())
    for size, name in [(16, "favicon-16.png"), (32, "favicon-32.png"), (180, "apple-touch-icon.png"),
                       (192, "icon-192.png"), (512, "icon-512.png")]:
        img = icon(size)
        if name == "apple-touch-icon.png":       # iOS adds its own rounding; give it a full tile
            img = Image.alpha_composite(Image.new("RGBA", img.size, BG), img)
        img.save(ASSETS / name, optimize=True)
    icon(512, maskable=True).save(ASSETS / "icon-maskable-512.png", optimize=True)
    icon(64).save(ROOT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    day = a.date or json.loads((ROOT / "data" / "index.json").read_text())["dates"][-1]
    preview(day).save(ASSETS / "og-image.png", optimize=True)
    print("assets written; preview from", day)


if __name__ == "__main__":
    main()
