#!/usr/bin/env python3
"""Keep the space-weather time series: the model's numbers for each daily
product, and the solar wind measured at L1 for the same days.

    python scripts/sw_record.py            # new or rebuilt days, and measurements
    python scripts/sw_record.py --all      # re-record every day still on the site

Writes, under data/spaceweather/:

    daily.json        one row per day: `model` (from the page's own code,
                      js/sw-model.js, run under Node: speed and sector at Earth,
                      the next sector boundary, the week's peak, field strength,
                      Russell-McPherron and Rosenberg-Coleman numbers, and the
                      daily-mean speed and sector predicted for each UTC day from
                      the day before to seven days after) and `measured` (daily
                      means of the L1 solar wind, field and Kp).
    ../sw/<date>.png, .html  the day's share card and the page that carries it
                      (scripts/sw_card.py)
    inputs/YYYY.json  per day, the WSA inputs (f_s, DCHB) and the source-surface
                      field sign along Earth's latitude, kept after the daily
                      products are pruned, so scripts/calibrate_wsa.py can
                      recompute the speeds with other coefficients.

A model row is written once and replaced only when its product is rebuilt
(new map time or source), so each row stays the forecast made that day.
Measurements come from NASA OMNI (hourly, definitive, about a week behind)
and, for the days OMNI does not reach yet, from NOAA SWPC's real-time solar
wind (the last 24 hours); OMNI replaces the real-time values once it has them.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
import sys
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "spaceweather"
UA = {"User-Agent": "heliofield/0.1 (+https://github.com/sr-dash/heliofield)"}
OMNI = ("https://cdaweb.gsfc.nasa.gov/hapi/data?id=OMNI2_H0_MRG1HR"
        "&parameters=ABS_B1800,BX_GSE1800,BY_GSE1800,BZ_GSM1800,V1800,KP1800,DST1800"
        "&time.min={a}T00:00:00Z&time.max={b}T00:00:00Z&format=csv")
RTSW_WIND = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json"
RTSW_MAG = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json"
KP = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"
EVENTS = "https://sr-dash.github.io/heliofleet/data/events.json"
MIN_HOURS = 12          # a day needs this many hourly speeds to count
UNITS = dict(
    v="km/s, model speed at Earth at the map time", sector="+1 away from the Sun, -1 towards",
    peak7="[km/s, time] fastest model wind in the next 7 days", imf_nT="nT, from open flux (lower bound)",
    open_flux="Mx", rm="daily-mean Bz/|B| (GSM) of the spiral field for the current sector",
    rc_away="share of source-surface longitudes at Earth's latitude pointing away",
    fc_v="km/s, model daily-mean speed at Earth for UTC days -1..+7 from the date",
    fc_b="model daily-mean sector (-1..+1) for the same days",
    measured="daily means of hourly values: v, v_min, v_max [km/s], b [nT], bz [nT, GSM], "
             "away (share of hours in the away sector), n (hours), kp_max, dst_min [nT], src")


def _get(url: str, timeout: int = 60) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def grey(path: Path) -> np.ndarray:
    from PIL import Image
    return np.asarray(Image.open(path).convert("L"), dtype=np.float64).ravel()


# ------------------------------------------------------------------ model
def product(day: str) -> dict | None:
    """The decoded product, as the page decodes it."""
    base = DATA / day
    if not (base / "meta.json").exists():
        return None
    meta = json.loads((base / "meta.json").read_text())
    w = meta.get("wsa", {})
    speed = None
    if w.get("map") and (base / w["map"]).exists():
        k = grey(base / w["map"])
        speed = [None if x == 0 else w["vmin"] + (x - 1) / 254 * (w["vmax"] - w["vmin"]) for x in k]
    bss = (grey(base / "ss.png") / 127.5 - 1).tolist()
    cls = None
    if (base / "open.png").exists():
        k = grey(base / "open.png")
        cls = np.where(k == 255, 1, np.where(k == 128, -1, 0)).astype(int).tolist()
    return dict(day=day, meta=meta, speed=speed, bss=bss, cls=cls)


def events() -> dict | None:
    """HelioFleet's DONKI list: the sibling checkout if there is one, else the site."""
    local = ROOT.parent / "heliofleet" / "data" / "events.json"
    try:
        return json.loads(local.read_text() if local.exists() else _get(EVENTS))
    except Exception as e:
        print(f"  events: {e}")
        return None


def evaluate(p: dict) -> dict:
    """{record, level, reasons, card, counts} from the page's model."""
    r = subprocess.run(["node", str(ROOT / "scripts" / "sw_eval.mjs")], input=json.dumps(p),
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def ring_at(grid: np.ndarray, lat: float) -> np.ndarray:
    """Row of a 180 x 360 north-first grid at a latitude, linear between rows."""
    y = min(179.0, max(0.0, 89.5 - lat))
    i0 = int(np.floor(y)); i1 = min(179, i0 + 1); f = y - i0
    return grid[i0] + f * (grid[i1] - grid[i0])


def inputs_entry(p: dict) -> dict | None:
    m = p["meta"]
    ring = m.get("wsa", {}).get("ring")
    if not ring:
        return None
    e = m["fleet"]["earth"]
    b = ring_at(np.asarray(p["bss"]).reshape(180, 360), ring["lat"])
    return dict(t0=m["obstime"], L0=m["L0"], lat=ring["lat"], r=e["r"], rss=m["model"]["rss"],
                fs=ring["fs"], dchb=ring["dchb"], b=[round(float(x), 3) for x in b])


# ------------------------------------------------------------------ measured
def daily(hours: dict) -> dict:
    """Daily summaries from {day: [hourly dicts]}."""
    out = {}
    for day, hs in hours.items():
        v = [h["v"] for h in hs if h.get("v") is not None]
        if len(v) < MIN_HOURS:
            continue
        mean = lambda k: (lambda a: round(float(np.mean(a)), 2) if a else None)([h[k] for h in hs if h.get(k) is not None])
        sec = [h["s"] for h in hs if h.get("s") is not None]
        kp = [h["kp"] for h in hs if h.get("kp") is not None]
        dst = [h["dst"] for h in hs if h.get("dst") is not None]
        out[day] = dict(v=round(float(np.mean(v)), 1), v_min=round(min(v)), v_max=round(max(v)), n=len(v),
                        b=mean("b"), bz=mean("bz"), away=round(float(np.mean([s > 0 for s in sec])), 2) if sec else None,
                        kp_max=max(kp) if kp else None, dst_min=min(dst) if dst else None)
    return out


def sector_sign(bx, by):
    """Away from the Sun when the field lies along an outward Parker spiral:
    -Bx + By > 0 in GSE."""
    return None if bx is None or by is None else (1 if by - bx > 0 else -1)


def omni(a: date, b: date) -> dict:
    text = _get(OMNI.format(a=a.isoformat(), b=b.isoformat()), timeout=120).decode()
    hours = defaultdict(list)
    fill = lambda x, bad: None if x == "" or float(x) >= bad else float(x)
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 8 or not row[0][:4].isdigit():
            continue
        t, B, bx, by, bz, v, kp, dst = row[:8]
        bx, by = fill(bx, 999), fill(by, 999)
        k = fill(kp, 99)
        hours[t[:10]].append(dict(v=fill(v, 9999), b=fill(B, 999), bz=fill(bz, 999), s=sector_sign(bx, by),
                                  kp=None if k is None else round(k / 10, 2), dst=fill(dst, 99999)))
    return {d: dict(m, src="OMNI") for d, m in daily(hours).items()}


def realtime() -> dict:
    """Hourly means of the active L1 spacecraft's 1-minute values."""
    wind = json.loads(_get(RTSW_WIND))
    mag = json.loads(_get(RTSW_MAG))
    hv, hb = defaultdict(list), defaultdict(list)
    for r in wind:
        if r.get("active") and r.get("proton_speed") is not None:
            hv[r["time_tag"][:13]].append(r["proton_speed"])
    for r in mag:
        if r.get("active") and r.get("bt") is not None:
            hb[r["time_tag"][:13]].append((r["bt"], r.get("bx_gse"), r.get("by_gse"), r.get("bz_gsm")))
    kp = defaultdict(list)
    try:
        for r in json.loads(_get(KP)):
            if isinstance(r, dict) and r.get("Kp") is not None:
                kp[r["time_tag"][:10]].append(float(r["Kp"]))
    except Exception as e:                                           # Kp is a bonus
        print(f"  Kp: {e}")
    hours = defaultdict(list)
    for h in sorted(set(hv) | set(hb)):
        b = hb.get(h, [])
        mb = lambda i: float(np.mean([x[i] for x in b if x[i] is not None])) if any(x[i] is not None for x in b) else None
        bx, by = mb(1), mb(2)
        hours[h[:10]].append(dict(v=float(np.mean(hv[h])) if hv.get(h) else None, b=mb(0), bz=mb(3),
                                  s=sector_sign(bx, by), kp=None, dst=None))
    out = daily(hours)
    for d, m in out.items():
        m["kp_max"] = max(kp[d]) if kp.get(d) else None
        m["src"] = "SWPC RTSW"
    return out


# ------------------------------------------------------------------ main
def load(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--all", action="store_true", help="re-record every day still on the site")
    ap.add_argument("--no-measured", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    doc = load(OUT / "daily.json", dict(rows=[]))
    rows = {r["date"]: r for r in doc["rows"]}
    days = json.loads((DATA / "index.json").read_text())["dates"]

    inputs, ev_list, cards = {}, events(), []
    for day in days:
        p = product(day)
        if p is None:
            continue
        old = rows.get(day, {}).get("model")
        src = p["meta"]["source"].get("short", p["meta"]["source"].get("name"))
        if old and not a.all and old["t0"][:16] == p["meta"]["obstime"][:16] and old["src"] == src:
            continue
        out = evaluate(dict(p, events=ev_list))
        rec = out["record"]
        rows.setdefault(day, dict(date=day))["model"] = {k: v for k, v in rec.items() if k != "date"}
        cards.append((day, out))
        e = inputs_entry(p)
        if e:
            inputs.setdefault(day[:4], {})[day] = e
        print(f"  {day}: model {rec['v']} km/s, sector {rec['sector']:+d}")
    # Share cards and pages for the days just recorded; the newest is also the
    # page's own preview image.
    import sw_card
    newest = max(days) if days else None
    for day, out in cards:
        sw_card.write(day, out, latest=day == newest)
    for year, entries in inputs.items():
        path = OUT / "inputs" / f"{year}.json"
        path.parent.mkdir(exist_ok=True)
        cur = load(path, {})
        cur.update(entries)
        path.write_text(json.dumps(dict(sorted(cur.items())), separators=(",", ":")))

    if not a.no_measured and rows:
        first = date.fromisoformat(min(rows))
        today = datetime.now(timezone.utc).date()
        sources = [("SWPC real-time", realtime), ("OMNI", lambda: omni(max(first, today - timedelta(days=120)), today))]
        for name, fetch in sources:                  # in this order: OMNI wins where it has values
            try:
                got = fetch()
            except Exception as e:
                print(f"  {name}: {e}")
                continue
            for day, m in got.items():
                if day < first.isoformat() or day >= today.isoformat():      # complete days only
                    continue
                old = rows.get(day, {}).get("measured")
                if old and old.get("src") == "OMNI" and m["src"] != "OMNI":
                    continue
                if old:          # OMNI fills its field values weeks after its speeds: keep any we have
                    m = {k: (old.get(k) if v is None else v) for k, v in m.items()}
                rows.setdefault(day, dict(date=day))["measured"] = m
        print(f"  measured: {sum('measured' in r for r in rows.values())} days")

    doc = dict(about="HelioField space-weather time series: the model at Earth from each daily product, "
                     "and the solar wind measured at L1. See scripts/sw_record.py and guide.html#spaceweather.",
               units=UNITS, updated=datetime.now(timezone.utc).isoformat(timespec="seconds"),
               rows=[rows[d] for d in sorted(rows)])
    text = json.dumps(doc, separators=(",", ":")).replace('{"date"', '\n{"date"')
    old = (OUT / "daily.json").read_text() if (OUT / "daily.json").exists() else ""
    # Rewrite only when a row changed, so a quiet night leaves nothing to commit.
    if old.split('"rows"')[-1] != text.split('"rows"')[-1]:
        (OUT / "daily.json").write_text(text + "\n")


if __name__ == "__main__":
    sys.exit(main())
