"""The download: the files the browser writes and the Python scripts that ship
with them (download/). For one archived map, each product is exported as the
page would export it. The tests then check that:
  - NetCDF readers open it, and the header describes every variable;
  - the README has no unfilled fields;
  - plot_surface.py and plot_3d.py write their PNG and PDF;
  - compute_corona.py, given only the surface maps, reproduces the browser's
    3D results (PFSS and PFSS + SCS).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from conftest import ROOT

pytestmark = pytest.mark.slow
DL = ROOT / "download"
sys.path.insert(0, str(DL))
FLEET = {
    "psp": dict(name="Parker Solar Probe", lon=30.0, lat=3.0, r=0.3, planet=False),
    "solo": dict(name="Solar Orbiter", lon=200.0, lat=-5.0, r=0.6, planet=False),
    "earth": dict(name="Earth", lon=341.0, lat=-7.2, r=0.99, planet=True),
}


@pytest.fixture(scope="module")
def exports(js, tmp_path_factory):
    import rotations
    d = tmp_path_factory.mktemp("export")
    br = rotations.load_cr(2148).astype(np.float32)
    out = {}
    for kind, rout in (("surface", 0), ("pfss", 0), ("scs", 21.5)):
        stem = d / f"heliofield_2014-03-12_{kind}"
        js("export", map=br, kind=kind, rout=rout, fleet=FLEET, date="2014-03-12", cr=2148, out=str(stem))
        out[kind] = stem
    return out


def run(script, *args):
    p = subprocess.run([sys.executable, str(DL / script), *map(str, args)], capture_output=True, text=True, timeout=600)
    assert p.returncode == 0, p.stderr[-2000:]
    return p.stdout


@pytest.mark.parametrize("kind", ["surface", "pfss", "scs"])
def test_files_read_and_described(exports, kind):
    from heliofield_io import load
    import xarray as xr
    stem = exports[kind]
    res = load(f"{stem}.nc")
    header = json.loads(Path(f"{stem}_header.json").read_text())
    assert header["format"] == res.attrs["format"] == "heliofield-export-1"
    assert set(header["variables"]) == set(res)                       # every variable described
    assert all("units" in v or "long_name" in v or v["type"] in ("int",) for v in header["variables"].values())
    with xr.open_dataset(f"{stem}.nc", engine="scipy") as ds:
        assert ds["br_phot"].attrs["units"] == "G"
        assert ("br" in ds) == (kind != "surface") and ("br_scs" in ds) == (kind == "scs")
    text = Path(f"{stem}_README.txt").read_text()
    assert "{{" not in text and f"heliofield_2014-03-12_{kind}.nc" in text


@pytest.mark.parametrize("kind", ["surface", "pfss", "scs"])
def test_plots(exports, kind):
    stem = exports[kind]
    run("plot_surface.py", f"{stem}.nc", "--dpi", 60)
    for ext in ("png", "pdf"):
        assert Path(f"{stem}_surface.{ext}").stat().st_size > 10_000
    if kind != "surface":
        run("plot_3d.py", f"{stem}.nc", "--size", "800x600", "--dpi", 100)
        for ext in ("png", "pdf"):
            assert Path(f"{stem}_3d.{ext}").stat().st_size > 10_000


@pytest.mark.parametrize("model", ["pfss", "scs"])
def test_compute_corona_reproduces_the_browser(exports, model):
    from heliofield_io import load, polylines
    stem = exports["surface"]
    out = Path(f"{stem}_{model}_py")
    run("compute_corona.py", f"{stem}.nc", "--out", out, *(["--scs", "21.5"] if model == "scs" else []))
    py, js = load(f"{out}.nc"), load(f"{exports[model]}.nc")
    rel = lambda k: float(np.max(np.abs(py[k] - js[k])) / np.max(np.abs(js[k])))
    for k in ["br_ss", "br", "btheta", "bphi"] + (["br_cusp", "br_scs", "btheta_scs", "bphi_scs"] if model == "scs" else []):
        assert rel(k) < 1e-5, k
    assert np.array_equal(py["line_kind"], js["line_kind"]) and np.array_equal(py["line_drawn"], js["line_drawn"])
    ends = [np.linalg.norm(a[-1] - b[-1]) for a, b in zip(polylines(py), polylines(js))]
    assert len(ends) == len(js["line_kind"]) and max(ends) < 1e-3
    assert np.mean(py["open_class"] == js["open_class"]) > 0.999
    ok = np.isfinite(js["foot_lon"])
    assert np.array_equal(ok, np.isfinite(py["foot_lon"]))
    assert np.max(np.abs((py["foot_lon"][ok] - js["foot_lon"][ok] + 180) % 360 - 180)) < 0.05
    assert abs(py.attrs["open_flux_Mx"] / js.attrs["open_flux_Mx"] - 1) < 1e-4
    if model == "scs":
        assert np.mean(py["polarity_out"] == js["polarity_out"]) > 0.99
        assert py["rib_lon"].shape == js["rib_lon"].shape
    run("plot_3d.py", f"{out}.nc", "--size", "800x600", "--dpi", 100)
