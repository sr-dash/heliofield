#!/usr/bin/env python3
"""Calibrate the WSA-type speed against the solar wind measured at L1.

    python scripts/calibrate_wsa.py                 # fit, and report the skill
    python scripts/calibrate_wsa.py --leads 1 2 3   # score these lead times [days]
    python scripts/calibrate_wsa.py --write         # also save data/spaceweather/wsa_fit.json

For every day in data/spaceweather/inputs/, the speed along Earth's latitude
on the source surface is recomputed from the stored f_s and DCHB with trial
coefficients,

    v = v0 + v1 / (1 + f_s)^alpha * (1 - 0.8 exp(-(DCHB / w)^2))^3,

carried to Earth with the same HUX scheme as the page (js/sw-model.js, checked
against it in tests/test_spaceweather.py), and averaged over each UTC day
`lead` days after the map. The coefficients minimise the mean absolute error
against the daily means in data/spaceweather/daily.json. The fit is reported
next to the current (illustrative) coefficients, per lead time; with fewer
than MIN_DAYS measured target days it is reported but not recommended.
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "spaceweather"
RSUN_KM, AU_KM = 695700.0, 149597870.7
OMEGA = 2 * np.pi / (25.38 * 86400)
RATE = 360 / 27.2753
CURRENT = dict(v0=285.0, v1=625.0, alpha=2 / 9, w=2.0)
BOUNDS = dict(v0=(150, 450), v1=(200, 1200), alpha=(0.05, 1.0), w=(0.5, 8.0))
MIN_DAYS = 90


def wsa(fs, dchb, v0, v1, alpha, w):
    return v0 + v1 / (1 + fs) ** alpha * (1 - 0.8 * np.exp(-((dchb / w) ** 2))) ** 3


def fill(r: np.ndarray) -> np.ndarray:
    """NaNs filled from the nearest valid neighbours along the ring."""
    ok = np.isfinite(r)
    if ok.all() or not ok.any():
        return r
    j = np.arange(r.size)
    return np.interp(j, j[ok], r[ok], period=r.size)


def hux(v0: np.ndarray, r0: float, r1: float, tracers=(), dr: float = 1.0):
    """The page's HUX step (sw-model.js hux), vectorised."""
    n = v0.size
    dphi = 2 * np.pi / n
    steps = max(1, int(np.ceil((r1 - r0) / dr)))
    h = (r1 - r0) / steps * RSUN_KM
    v, q = v0.astype(float).copy(), [np.asarray(t, float).copy() for t in tracers]
    for _ in range(steps):
        c = np.minimum(1, OMEGA * h / v / dphi)
        up = np.roll(v, -1)
        q = [t + c * (np.roll(t, -1) - t) for t in q]
        v = v + c * (up - v)
    return v, q


def ring_value(ring: np.ndarray, lon):
    x = np.mod(lon, 360) - 0.5
    j0 = np.floor(x).astype(int)
    f = x - j0
    return ring[j0 % 360] + f * (ring[(j0 + 1) % 360] - ring[j0 % 360])


def daily_means(v_earth: np.ndarray, e: dict, day: str, leads) -> dict:
    """Model daily-mean speed at Earth for UTC days day + lead, sampled every
    2 hours as on the page."""
    t0 = datetime.fromisoformat(e["t0"].replace("Z", "+00:00")).timestamp()
    d0 = datetime.fromisoformat(day + "T00:00:00+00:00").timestamp()
    out = {}
    for k in leads:
        ts = d0 + k * 86400 + np.arange(0, 86400, 7200)
        lon = e["L0"] - RATE * (ts - t0) / 86400
        out[k] = float(np.mean(ring_value(v_earth, lon)))
    return out


def predictions(inputs: dict, p: dict, leads) -> dict:
    """{(map day, lead): model daily mean} for coefficients p."""
    out = {}
    for day, e in inputs.items():
        fs = np.array([np.nan if x is None else x for x in e["fs"]], float)
        dchb = np.array([np.nan if x is None else x for x in e["dchb"]], float)
        v_ss = fill(wsa(fs, dchb, **p))
        v_e, _ = hux(v_ss, e["rss"], e["r"] * AU_KM / RSUN_KM)
        for k, v in daily_means(v_e, e, day, leads).items():
            out[day, k] = v
    return out


def score(pred: dict, meas: dict, leads):
    rows = {}
    for k in leads:
        pairs = [(v, meas[t]) for (d, kk), v in pred.items() if kk == k
                 for t in [(date.fromisoformat(d) + timedelta(days=k)).isoformat()] if t in meas]
        if not pairs:
            continue
        a = np.array(pairs)
        err = a[:, 0] - a[:, 1]
        rows[k] = dict(n=len(a), mae=float(np.mean(np.abs(err))), bias=float(np.mean(err)),
                       r=float(np.corrcoef(a.T)[0, 1]) if len(a) > 2 and a[:, 0].std() > 0 and a[:, 1].std() > 0 else None)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--leads", type=int, nargs="+", default=[1, 2, 3, 4, 5])
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    inputs = {}
    for f in sorted((OUT / "inputs").glob("*.json")):
        inputs.update(json.loads(f.read_text()))
    doc = json.loads((OUT / "daily.json").read_text())
    meas = {r["date"]: r["measured"]["v"] for r in doc["rows"] if r.get("measured", {}).get("v") is not None}
    names = list(CURRENT)

    def cost(x):
        p = {n: float(np.clip(v, *BOUNDS[n])) for n, v in zip(names, x)}
        s = score(predictions(inputs, p, a.leads), meas, a.leads)
        n = sum(r["n"] for r in s.values())
        return sum(r["mae"] * r["n"] for r in s.values()) / n if n else np.inf

    base = score(predictions(inputs, CURRENT, a.leads), meas, a.leads)
    targets = {(date.fromisoformat(d) + timedelta(days=k)).isoformat() for d in inputs for k in a.leads} & set(meas)
    print(f"{len(inputs)} map days, {len(meas)} measured days, {len(targets)} measured target days")
    if not base:
        print("No map day has a measured day at these lead times yet.")
        return
    from scipy.optimize import minimize
    res = minimize(cost, [CURRENT[n] for n in names], method="Nelder-Mead",
                   options=dict(xatol=1e-3, fatol=0.05, maxiter=600))
    fit = {n: float(np.clip(v, *BOUNDS[n])) for n, v in zip(names, res.x)}
    new = score(predictions(inputs, fit, a.leads), meas, a.leads)
    print("coefficients   " + "  ".join(f"{n}={CURRENT[n]:.3g}->{fit[n]:.3g}" for n in names))
    print("lead  pairs   MAE now  MAE fit   bias now  bias fit   r now   r fit")
    for k in a.leads:
        if k in base:
            b, f = base[k], new[k]
            fr = lambda x: "  –  " if x is None else f"{x:5.2f}"
            print(f"{k:>4} {b['n']:>6} {b['mae']:>9.1f} {f['mae']:>8.1f} {b['bias']:>10.1f} {f['bias']:>9.1f}   {fr(b['r'])}   {fr(f['r'])}")
    enough = len(targets) >= MIN_DAYS
    print("Enough data to adopt the fit." if enough else
          f"Too few measured days to adopt the fit (need {MIN_DAYS}); keep collecting.")
    if a.write:
        (OUT / "wsa_fit.json").write_text(json.dumps(dict(
            fitted=fit, current=CURRENT, leads=a.leads, map_days=len(inputs), target_days=len(targets),
            recommended=enough, score_current=base, score_fit=new,
            form="v0 + v1/(1+fs)^alpha * (1 - 0.8 exp(-(dchb/w)^2))^3",
            updated=datetime.now(timezone.utc).isoformat(timespec="seconds")), indent=1) + "\n")


if __name__ == "__main__":
    main()
