#!/usr/bin/env python3
"""Inputs for computing any date since 2010 in the browser.

    python scripts/build_history.py            # new rotations and fleet years
    python scripts/build_history.py --all      # rebuild everything

Writes data/history/:

    index.json        rotations with their time span, and the fleet years
    cr/NNNN.bin.gz    one HMI Carrington-rotation synoptic map per rotation
                      (hmi.Synoptic_Mr_small, or hmi.Synoptic_Mr where only
                      that exists), block-averaged to 180 x 360,
                      little-endian int16 in units of 0.1 G, row 0 = south,
                      rows uniform in sin(latitude), column j centred on
                      Carrington longitude j + 0.5 deg, monopole removed
    fleet/YYYY.json   Earth's L0/B0 and every body's Carrington lon/lat/r at
                      12:00 UTC each day, from HelioFleet's ephemerides

The browser fetches one map (~80 kB) and solves PFSS itself, so the archive
stays around 20 MB for the whole HMI era instead of a product per day.
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
import warnings
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_day as bd  # noqa: E402  (shared fetch, fleet list and constants)

OUT = bd.DATA / "history"
JSOC = "https://jsoc1.stanford.edu/data/hmi/synoptic/"
SCALE = 0.1          # G per int16 unit
FIRST_DAY = date(2010, 5, 1)
# Bodies whose positions stop meaning anything: STEREO-B lost contact.
END = {"stb": date(2014, 10, 1)}


def tai(s: str) -> datetime:
    """UTC of an HMI time string such as 2025.07.16_17:08:58_TAI."""
    # Seconds can read 60 (TAI strings near leap seconds), so add them rather
    # than parse them.
    t = datetime.strptime(s[:16], "%Y.%m.%d_%H:%M") + timedelta(seconds=float(s[17:19]))
    return (t - timedelta(seconds=37 if t.year >= 2017 else 36 if t.year >= 2015 else 35)).replace(tzinfo=timezone.utc)


def rotation(cr: int, raw: bytes) -> tuple[bytes, dict]:
    from astropy.io import fits
    import io
    with fits.open(io.BytesIO(raw)) as f:
        hdu = f[0] if f[0].data is not None else f[1]
        h, d = hdu.header, hdu.data.astype(float)
    ny, nx = d.shape
    # CRVAL1 is Carrington time (360*CR - lon) and CDELT1 is negative, so
    # longitude rises along x; the first column's longitude:
    lon0 = (360 * h["CAR_ROT"] - (h["CRVAL1"] + (1 - h["CRPIX1"]) * h["CDELT1"])) % 360
    by, bx = ny // 180, nx // 360                 # 2x2 for the small maps, 8x10 for full
    d = np.nanmean(d.reshape(180, by, 360, bx), axis=(1, 3))
    lon0 = (lon0 + (bx - 1) / 2 * abs(h["CDELT1"])) % 360   # centre of the first block
    d = np.roll(d, int(round(lon0 - 0.5)), axis=1)
    d = np.nan_to_num(d - np.nanmean(d))
    q = np.clip(np.round(d / SCALE), -32767, 32767).astype("<i2")
    meta = dict(cr=int(cr), start=tai(h["T_START"]).isoformat()[:19] + "Z",
                stop=tai(h["T_STOP"]).isoformat()[:19] + "Z", file=f"cr/{cr}.bin.gz")
    return gzip.compress(q.tobytes(), 9, mtime=0), meta


def build_rotations(rebuild: bool) -> list[dict]:
    listing = bd._get(JSOC, 120, tries=4).decode("utf-8", "replace")
    small = {int(c) for c in re.findall(r"hmi\.Synoptic_Mr_small\.(\d{4})\.fits", listing)}
    # A few rotations (2012) exist only at full resolution; average those down.
    full = {int(c) for c in re.findall(r"hmi\.Synoptic_Mr\.(\d{4})\.fits", listing)}
    crs = sorted(small | full)
    idx_path = OUT / "index.json"
    have = {r["cr"]: r for r in json.loads(idx_path.read_text())["rotations"]} if idx_path.exists() else {}
    (OUT / "cr").mkdir(parents=True, exist_ok=True)
    for cr in crs:
        if cr in have and not rebuild and (OUT / have[cr]["file"]).exists():
            continue
        try:
            name = f"hmi.Synoptic_Mr_small.{cr}.fits" if cr in small else f"hmi.Synoptic_Mr.{cr}.fits"
            raw = bd._get(JSOC + name, 300, tries=4)
            blob, meta = rotation(cr, raw)
        except Exception as e:
            print(f"  CR {cr}: {type(e).__name__}: {e}")
            continue
        (OUT / meta["file"]).write_bytes(blob)
        have[cr] = meta
        print(f"  CR {cr}: {meta['start'][:10]} to {meta['stop'][:10]}, {len(blob) / 1e3:.0f} kB")
    return [have[c] for c in sorted(have)]


def build_fleet(rebuild: bool) -> list[int]:
    """Daily Carrington positions, one file per year."""
    import astropy.units as u
    from astropy.coordinates import HeliocentricMeanEcliptic, SkyCoord
    from astropy.time import Time
    from sunpy.coordinates import HeliographicCarrington, sun

    (OUT / "fleet").mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).date()
    years = list(range(FIRST_DAY.year, today.year + 2))
    done = []
    for year in years:
        path = OUT / "fleet" / f"{year}.json"
        # Past years never change; this year and next are refreshed.
        if path.exists() and not rebuild and year < today.year:
            done.append(year)
            continue
        d0 = max(date(year, 1, 1), FIRST_DAY)
        days = [d0 + timedelta(days=k) for k in range((date(year + 1, 1, 1) - d0).days)]
        t = Time([datetime(d.year, d.month, d.day, 12) for d in days], scale="utc")
        jd = t.jd
        earth = np.array([bd._at("earth", j, year) if bd._at("earth", j, year) is not None else [np.nan] * 3 for j in jd])
        ok = ~np.isnan(earth[:, 0])
        if not ok.any():
            continue
        frame = HeliographicCarrington(observer="earth", obstime=t)
        out = dict(start=d0.isoformat(), step_days=1, n=len(days),
                   L0=np.round(sun.L0(t).to_value("deg"), 2).tolist(),
                   B0=np.round(sun.B0(t).to_value("deg"), 2).tolist(),
                   CR=[int(c) for c in np.floor(sun.carrington_rotation_number(t))],
                   bodies={})
        for key, name in bd.FLEET.items():
            v = np.array([bd._at(key, j, year) if bd._at(key, j, year) is not None else [np.nan] * 3 for j in jd])
            if key.endswith("_geo"):
                v = earth + v / bd.AU_KM
            good = ~np.isnan(v[:, 0])
            if key in END:
                good &= np.array([d < END[key] for d in days])
            if not good.any():
                continue
            c = SkyCoord(*(np.nan_to_num(v).T * u.au), representation_type="cartesian",
                         frame=HeliocentricMeanEcliptic(equinox="J2000", obstime=t))
            h = c.transform_to(frame)
            lon = np.where(good, np.round(h.lon.to_value("deg") % 360, 2), np.nan)
            lat = np.where(good, np.round(h.lat.to_value("deg"), 2), np.nan)
            r = np.where(good, np.round(h.radius.to_value("au"), 4), np.nan)
            nan2none = lambda a: [None if np.isnan(x) else float(x) for x in a]
            out["bodies"][key.replace("_geo", "")] = dict(
                name=name, planet=key in bd.PLANETS, lon=nan2none(lon), lat=nan2none(lat), r=nan2none(r))
        path.write_text(json.dumps(out, separators=(",", ":")))
        print(f"  fleet {year}: {len(out['bodies'])} bodies, {path.stat().st_size / 1e3:.0f} kB")
        done.append(year)
    return done


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--no-fleet", action="store_true")
    a = ap.parse_args()
    warnings.filterwarnings("ignore")
    OUT.mkdir(parents=True, exist_ok=True)
    rots = build_rotations(a.all)
    idx_path = OUT / "index.json"
    old = json.loads(idx_path.read_text()) if idx_path.exists() else {}
    years = old.get("fleet_years", []) if a.no_fleet else build_fleet(a.all)
    idx = dict(source="SDO/HMI hmi.Synoptic_Mr_small (JSOC)", shape=[180, 360], scale_G=SCALE,
               rows="sin(latitude), south first", cols="Carrington longitude j + 0.5 deg",
               first_day=FIRST_DAY.isoformat(), rotations=rots, fleet_years=years)
    if idx != old:
        idx_path.write_text(json.dumps(idx, separators=(",", ":")))


if __name__ == "__main__":
    main()
