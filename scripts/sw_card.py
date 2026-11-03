"""Share cards for the space-weather page: one 1200 x 630 image per day and a
small page per day that carries it, so a post on X, Bluesky, LinkedIn or
Facebook shows that day's assessment instead of a bare link.

    sw/<date>.png    the card: status, the three headline numbers and the
                     wind outlook at Earth
    sw/<date>.html   the page a share links to: its Open Graph and X card
                     tags name the card; people are sent on at once to
                     spaceweather.html?date=<date>
    sw/latest.png    the newest card, also the page's own preview image

Called by scripts/sw_record.py with what scripts/sw_eval.mjs returns.
"""
from __future__ import annotations

import html
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "sw"
SITE = "https://sr-dash.github.io/heliofield/"
W, H = 1200, 630
# The dark theme of the site (js/theme.js, css/spaceweather.css).
BG, CARD, LINE = (8, 11, 20), (15, 20, 31), (40, 46, 60)
TEXT, MUTED = (232, 234, 240), (163, 171, 187)
SPEED, POS, NEG = (57, 135, 229), (194, 132, 18), (22, 135, 169)
STATUS = {"good": (86, 184, 108), "watch": (226, 169, 59), "high": (240, 123, 69), "severe": (242, 92, 140)}
NAME = {"good": "Nominal", "watch": "Watch", "high": "High", "severe": "Severe"}
CLASS = lambda v: "slow" if v < 400 else "intermediate" if v < 550 else "fast"


def font(size: int, bold: bool = False):
    """Arial on a Mac, DejaVu or Liberation on the runner, else Pillow's own."""
    names = (["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"] if bold else
             ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"])
    for n in names:
        if Path(n).exists():
            return ImageFont.truetype(n, size)
    return ImageFont.load_default(size)


def day_label(day: str, long: bool = True) -> str:
    d = datetime.fromisoformat(day)
    return f"{d.day} {d.strftime('%B' if long else '%b')} {d.year}" if long else f"{d.day} {d.strftime('%b')}"


def status_icon(g: ImageDraw.ImageDraw, lv: str, x: float, y: float, s: float):
    """The page's shapes: circle (nominal), triangle (watch), diamond (high),
    octagon (severe), each with its mark cut out."""
    c = STATUS[lv]
    if lv == "good":
        g.ellipse([x, y, x + s, y + s], fill=c)
        g.line([(x + .28 * s, y + .52 * s), (x + .44 * s, y + .68 * s), (x + .74 * s, y + .34 * s)], fill=BG, width=max(2, int(s / 9)))
        return
    if lv == "watch":
        g.polygon([(x + s / 2, y + .04 * s), (x + s, y + .92 * s), (x, y + .92 * s)], fill=c)
    elif lv == "high":
        g.polygon([(x + s / 2, y), (x + s, y + s / 2), (x + s / 2, y + s), (x, y + s / 2)], fill=c)
    else:
        k = .29 * s
        g.polygon([(x + k, y), (x + s - k, y), (x + s, y + k), (x + s, y + s - k), (x + s - k, y + s), (x + k, y + s), (x, y + s - k), (x, y + k)], fill=c)
    w = max(2, int(s / 8))
    g.line([(x + s / 2, y + .3 * s), (x + s / 2, y + .6 * s)], fill=BG, width=w)
    g.ellipse([x + s / 2 - w / 1.6, y + .7 * s, x + s / 2 + w / 1.6, y + .7 * s + 1.25 * w], fill=BG)


def wrap(g, text, f, width):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if g.textlength(t, font=f) <= width:
            cur = t
        else:
            lines.append(cur); cur = w_
    return lines + ([cur] if cur else [])


def render(day: str, ev: dict, path: Path):
    rec, ser = ev["record"], ev["card"]
    img = Image.new("RGB", (W, H), BG)
    g = ImageDraw.Draw(img)
    # Heading.
    g.text((56, 40), "HelioField · Space weather", font=font(24), fill=MUTED)
    g.text((56, 74), day_label(day), font=font(54, True), fill=TEXT)
    # Status, top right: shape, word, and the first reason.
    lv = ev["level"]
    word = NAME[lv]
    fw = font(34, True)
    tw = g.textlength(word, font=fw)
    x1 = W - 56
    g.rounded_rectangle([x1 - tw - 84, 44, x1, 104], radius=30, fill=tuple(int(c * .22 + b * .78) for c, b in zip(STATUS[lv], BG)), outline=STATUS[lv], width=2)
    status_icon(g, lv, x1 - tw - 70, 56, 36)
    g.text((x1 - tw - 22, 54), word, font=fw, fill=TEXT)
    rs = ev["reasons"][:2]
    why = "Nominal ambient solar wind and no large events." if lv == "good" else ("; ".join(rs)[0].upper() + "; ".join(rs)[1:] + ".") if rs else ""
    for k, line in enumerate(wrap(g, why, font(22), 470)[:2]):
        g.text((x1 - g.textlength(line, font=font(22)), 116 + 28 * k), line, font=font(22), fill=MUTED)
    # Three numbers.
    blocks = []
    if rec.get("v") is not None:
        blocks.append(("Solar wind at Earth", f"{rec['v']} km/s", CLASS(rec["v"])))
    if rec.get("peak7"):
        pv, pt = rec["peak7"]
        blocks.append(("Fastest in the next 7 days", f"{pv} km/s", day_label(pt[:10], False) + (" · high-speed stream" if pv >= 500 else "")))
    if rec.get("sector") is not None:
        nb = rec.get("next_boundary")
        blocks.append(("Magnetic sector", "away" if rec["sector"] > 0 else "towards",
                       f"next boundary {day_label(nb[:10], False)}" if nb else "no boundary in two weeks"))
    bw = (W - 112 - 2 * 20) / 3
    for k, (lab, val, note) in enumerate(blocks):
        x = 56 + k * (bw + 20)
        g.rounded_rectangle([x, 188, x + bw, 300], radius=12, fill=CARD, outline=LINE)
        g.text((x + 18, 200), lab, font=font(20), fill=MUTED)
        g.text((x + 18, 226), val, font=font(40, True), fill=TEXT)
        g.text((x + 18, 272), wrap(g, note, font(18), bw - 30)[0], font=font(18), fill=MUTED)
    # Outlook at Earth.
    if ser:
        cx0, cx1, cy0, cy1 = 104, W - 56, 334, 496
        t = [datetime.fromisoformat(s[0] + ":00+00:00").timestamp() for s in ser]
        vs = [s[1] for s in ser]
        vmin, vmax = 250, max(700, (max(vs) // 100 + 1) * 100)
        X = lambda tt: cx0 + (tt - t[0]) / (t[-1] - t[0]) * (cx1 - cx0)
        Y = lambda v: cy1 - (v - vmin) / (vmax - vmin) * (cy1 - cy0)
        g.rounded_rectangle([56, 318, W - 40, 590], radius=12, fill=CARD, outline=LINE)
        k = 0
        while k < len(ser):            # far-side stretches, shaded
            if ser[k][3]:
                j = k
                while j + 1 < len(ser) and ser[j + 1][3]:
                    j += 1
                g.rectangle([X(t[k]), cy0, X(t[j]), cy1 + 30], fill=(22, 28, 41))
                k = j
            k += 1
        for lo, hi, lv_ in [(500, 600, "watch"), (600, 750, "high"), (750, vmax, "severe")]:
            if lo < vmax:
                c = STATUS[lv_]
                g.rectangle([cx0, Y(min(hi, vmax)), cx1, Y(lo)], fill=tuple(int(a * .10 + b * .90) for a, b in zip(c, CARD)))
        for v in range(300, vmax + 1, 100):
            g.line([(cx0, Y(v)), (cx1, Y(v))], fill=LINE, width=1)
            g.text((cx0 - 8 - g.textlength(str(v), font=font(16)), Y(v) - 9), str(v), font=font(16), fill=MUTED)
        for i in range(1, len(ser)):   # sector strip
            g.rectangle([X(t[i - 1]), cy1 + 12, X(t[i]) + 1, cy1 + 26], fill=POS if ser[i - 1][2] > 0 else NEG)
        g.line([(X(tt), Y(v)) for tt, v in zip(t, vs)], fill=SPEED, width=4, joint="curve")
        t0 = datetime.fromisoformat(rec["t0"].replace("Z", "+00:00")).timestamp()
        for yy in range(int(cy0), int(cy1 + 28), 10):
            g.line([(X(t0), yy), (X(t0), yy + 5)], fill=TEXT, width=2)
        d0 = datetime.fromisoformat(ser[0][0][:10]).replace(tzinfo=timezone.utc)
        for k in range(0, 11, 2):
            dd = d0 + timedelta(days=k + 1)
            if dd.timestamp() <= t[-1]:
                lab = f"{dd.day} {dd.strftime('%b')}"
                g.text((X(dd.timestamp()) - g.textlength(lab, font=font(16)) / 2, cy1 + 32), lab, font=font(16), fill=MUTED)
        g.text((cx0, 562), "Model wind at Earth, km/s  ·  strip: magnetic sector (gold away, blue towards)  ·  shaded: far-side data",
               font=font(15), fill=MUTED)
    g.text((W - 56 - g.textlength("sr-dash.github.io/heliofield", font=font(20, True)), 596), "sr-dash.github.io/heliofield", font=font(20, True), fill=TEXT)
    img.save(path, optimize=True)


def page(day: str, ev: dict, text: str) -> str:
    """The share page: card tags for the crawlers, and a redirect for people."""
    target = f"{SITE}spaceweather.html?date={day}"
    img = f"{SITE}sw/{day}.png"
    title = f"Space weather {day_label(day)}: {NAME[ev['level']]} | HelioField"
    e = lambda s: html.escape(s, quote=True)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(text)}">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="{e(target)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="HelioField">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(text)}">
<meta property="og:url" content="{SITE}sw/{day}.html">
<meta property="og:image" content="{img}">
<meta property="og:image:width" content="{W}">
<meta property="og:image:height" content="{H}">
<meta property="og:image:alt" content="{e(text)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@soumyatheory">
<meta name="twitter:creator" content="@soumyatheory">
<meta name="twitter:title" content="{e(title)}">
<meta name="twitter:description" content="{e(text)}">
<meta name="twitter:image" content="{img}">
<meta name="twitter:image:alt" content="{e(text)}">
<script>location.replace({target!r});</script>
<style>body{{background:#080b14;color:#e8eaf0;font:18px/1.5 system-ui,sans-serif;margin:40px}}a{{color:#9cc0ff}}img{{max-width:100%;border-radius:10px}}</style>
</head>
<body>
<p><a href="{e(target)}">Space weather for {e(day_label(day))} on HelioField →</a></p>
<img src="{day}.png" alt="{e(text)}">
</body>
</html>
"""


def share_text(day: str, ev: dict) -> str:
    """The same sentence the page puts in a post."""
    r = ev["record"]
    when = f"{day_label(day, False)} {day[:4]}"
    if r.get("v") is None:
        return f"Space weather {when} from HelioField's coronal model"
    up = ""
    if r.get("peak7") and r["peak7"][0] >= 500 and r["peak7"][0] - r["v"] > 60:
        up = f", fast wind ~{r['peak7'][0]} km/s around {day_label(r['peak7'][1][:10], False)}"
    return (f"Space weather {when} from HelioField's coronal model: {CLASS(r['v'])} solar wind ~{r['v']} km/s at Earth, "
            f"sector pointing {'away from' if r['sector'] > 0 else 'towards'} the Sun{up}.")


def write(day: str, ev: dict, latest: bool = False):
    OUT.mkdir(exist_ok=True)
    render(day, ev, OUT / f"{day}.png")
    (OUT / f"{day}.html").write_text(page(day, ev, share_text(day, ev)))
    if latest:
        (OUT / "latest.png").write_bytes((OUT / f"{day}.png").read_bytes())
