#!/usr/bin/env python3
"""Add the input map (map.bin.gz) to daily products made before the build
wrote it, from the very map each product names in meta.json:

    python scripts/backfill_maps.py

GONG maps come from GONG's archive by file name. An HMI daily frame is no
longer at the path the nightly build reads (JSOC keeps only the latest
there), so its record is looked up by T_REC and fetched from JSOC's storage.
Products already holding a map are left alone. Runs where GONG answers,
which GitHub's runners are not.
"""
from __future__ import annotations

import json
import sys
import tempfile
import urllib.parse
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_day as bd  # noqa: E402

JSOC_INFO = "http://jsoc.stanford.edu/cgi-bin/ajax/jsoc_info"
JSOC_ROOT = "http://jsoc.stanford.edu"


def hmi_record(file: str):
    """The map of a source name like hmi.Mrdailysynframe_small_720s_nrt[T_REC]."""
    series, trec = file.rstrip("]").split("[")
    ds = f"{series}[{trec.replace('.000', '')}]"
    names = ["T_REC", "CAR_ROT", "CRVAL1", "CRPIX1", "CDELT1"]
    q = urllib.parse.urlencode(dict(ds=ds, op="rs_list", key=",".join(names), seg="data"))
    info = json.loads(bd._get(f"{JSOC_INFO}?{q}", 60, tries=3))
    paths = info["segments"][0]["values"] if info.get("count") else []
    if not paths or not paths[0].startswith("/SUM"):
        raise RuntimeError(f"{ds}: not online at JSOC")
    # The stored file has the data only; its keywords live in JSOC's database.
    keys = {k["name"]: k["values"][0] for k in info["keywords"]}
    for k in names[1:]:
        keys[k] = float(keys[k])
    raw = bd._get(JSOC_ROOT + paths[0], 120, tries=3)
    with tempfile.NamedTemporaryFile(suffix=".fits") as f:
        f.write(raw)
        f.flush()
        return bd.hmi_map(Path(f.name), keys=keys)[0]


def main():
    warnings.filterwarnings("ignore")
    done = failed = 0
    for meta_path in sorted(bd.DATA.glob("20??-??-??/meta.json")):
        dest = meta_path.parent / "map.bin.gz"
        if dest.exists():
            continue
        src = json.loads(meta_path.read_text())["source"]
        try:
            m = bd.load_map(src["url"]) if src.get("short", "GONG") == "GONG" else hmi_record(src["file"])
            bd.write_map(dest, m)
            done += 1
            print(f"{meta_path.parent.name}: {src['file']}")
        except Exception as e:
            failed += 1
            print(f"{meta_path.parent.name}: {type(e).__name__}: {e}")
    bd.write_index()
    print(f"{done} maps added, {failed} failed")


if __name__ == "__main__":
    main()
