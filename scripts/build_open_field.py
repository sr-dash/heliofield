#!/usr/bin/env python3
"""Open-field footprints on the photosphere: where the model puts coronal holes.

    python scripts/build_open_field.py          # new rotations and daily products
    python scripts/build_open_field.py --all    # rebuild everything

A field line is traced from every cell of a 1-deg grid (rows uniform in
sin latitude) at 1.001 R_sun; it either closes or reaches the source
surface. Written as 360 x 180 grey PNGs, north row first, column j centred
on Carrington longitude j + 0.5 deg: 0 closed, 255 open outward, 128 open
inward.

    data/history/open/NNNN.png   one per HMI rotation map (scripts/rotations.py)
    data/<date>/open.png         one per daily product whose input map is in
                                 cache/, as it is right after build_day.py
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rotations as R  # noqa: E402

DATA = R.ROOT / "data"
OPEN_DIR = DATA / "history" / "open"


def to_png(cls: np.ndarray, path: Path) -> None:
    """Sin-lat class grid (south first) -> equirectangular grey PNG (north first)."""
    from PIL import Image
    ny = cls.shape[0]
    lat = np.radians(np.linspace(90 - 0.5, -90 + 0.5, 180))
    eq = cls[np.clip(np.floor((np.sin(lat) + 1) / 2 * ny).astype(int), 0, ny - 1)]
    img = np.where(eq > 0, 255, np.where(eq < 0, 128, 0)).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img, "L").save(path, optimize=True)


def rotation_maps(rebuild: bool, recent: int) -> None:
    rots = R.rotation_index()
    for r in rots[-recent:] if recent else rots:
        path = OPEN_DIR / f"{r['cr']}.png"
        if path.exists() and not rebuild:
            continue
        cls = R.solve(r["cr"], r["start"])["open"]
        to_png(cls, path)
        print(f"  CR {r['cr']}: open fraction {np.mean(cls != 0):.3f}")


def daily_maps(rebuild: bool) -> None:
    import build_day as bd
    for meta_path in sorted(DATA.glob("20??-??-??/meta.json")):
        dest = meta_path.parent / "open.png"
        # build_day.py rebuilds yesterday each night; follow its product.
        if dest.exists() and not rebuild and dest.stat().st_mtime >= meta_path.stat().st_mtime:
            continue
        meta = json.loads(meta_path.read_text())
        src = meta["source"]
        if src.get("short", "GONG") == "GONG":
            if not (bd.CACHE / src["file"]).exists():
                continue
            m = bd.load_map(src["url"])
        else:
            # The HMI fallback keeps only the latest frame; load_hmi checks its date.
            if not (bd.CACHE / "hmi_daily.fits").exists():
                continue
            got = bd.load_hmi(date.fromisoformat(meta["date"]))
            if got is None:
                continue
            m = got[0]
        cls = R.solve_map(m)["open"]
        to_png(cls, dest)
        print(f"  {meta['date']}: open fraction {np.mean(cls != 0):.3f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--recent", type=int, default=0, help="look only at the last N rotations")
    a = ap.parse_args()
    warnings.filterwarnings("ignore")
    rotation_maps(a.all, a.recent)
    daily_maps(a.all)


if __name__ == "__main__":
    main()
