#!/usr/bin/env python3
"""Solar-cycle series, one value per HMI rotation map, for series.html.

    python scripts/build_series.py          # rotations not yet in the file
    python scripts/build_series.py --all    # every rotation again

Each rotation is solved as in scripts/rotations.py (PFSS, R_ss = 2.5 R_sun)
and reduced to:

    flux      unsigned flux through the source surface [1e22 Mx]
    area      share of the photosphere whose field is open
    tilt_n    highest northern latitude of the source-surface neutral line [deg]
    tilt_s    highest southern latitude, as a positive number [deg]
    polar_n   mean photospheric B_r poleward of 60 deg N [G]
    polar_s   the same for the south [G]

The tilt follows the Wilcox Solar Observatory definition (the neutral line's
maximum extent in each hemisphere), but on a radial-field HMI map with
R_ss = 2.5, so it sits close to, not on, WSO's values. Polar means use HMI's
radial field, which is poorly observed above ~75 deg and seasonally
one-sided as B0 swings by +-7 deg.

    data/series/rotations.json
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rotations as R  # noqa: E402

OUT = R.ROOT / "data" / "series" / "rotations.json"
KEYS = ["cr", "mid", "flux", "area", "tilt_n", "tilt_s", "polar_n", "polar_s"]


def polar_means(br: np.ndarray) -> tuple[float, float]:
    ny = br.shape[0]
    s = np.linspace(-1 + 1 / ny, 1 - 1 / ny, ny)
    lim = np.sin(np.radians(60))
    return float(br[s > lim].mean()), float(br[s < -lim].mean())


def row(r: dict) -> dict:
    res = R.solve(r["cr"], r["start"])
    tn, ts = R.neutral_line_tilt(res["ss"])
    pn, ps = polar_means(R.load_cr(r["cr"]))
    t0, t1 = (datetime.fromisoformat(r[k].rstrip("Z")) for k in ("start", "stop"))
    return dict(cr=r["cr"], mid=(t0 + (t1 - t0) / 2).strftime("%Y-%m-%d"),
                flux=round(res["flux"] / 1e22, 3), area=round(float(np.mean(res["open"] != 0)), 4),
                tilt_n=round(tn, 1), tilt_s=round(ts, 1), polar_n=round(pn, 2), polar_s=round(ps, 2))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    warnings.filterwarnings("ignore")
    old = json.loads(OUT.read_text()) if OUT.exists() and not a.all else None
    rows = {}
    if old:
        rows = {v[0]: dict(zip(KEYS, v)) for v in zip(*[old[k] for k in KEYS])}
    for r in R.rotation_index():
        if r["cr"] in rows:
            continue
        rows[r["cr"]] = row(r)
        print(f"  CR {r['cr']}: {rows[r['cr']]}")
    rows = [rows[c] for c in sorted(rows)]
    doc = dict(source="SDO/HMI hmi.Synoptic_Mr_small rotation maps; PFSS (sunkit-magex), R_ss = 2.5 R_sun, 40 shells",
               units=dict(flux="1e22 Mx", area="fraction of photosphere", tilt_n="deg", tilt_s="deg",
                          polar_n="G", polar_s="G"),
               **{k: [x[k] for x in rows] for k in KEYS})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, separators=(",", ":"))
    if not OUT.exists() or OUT.read_text() != text:
        OUT.write_text(text)


if __name__ == "__main__":
    main()
