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
    assert header["format"] == res.attrs["format"] == "heliofield-export-2"
    assert set(header["variables"]) == set(res)                       # every variable described
    assert all("units" in v or "long_name" in v or v["type"] in ("int",) for v in header["variables"].values())
    with xr.open_dataset(f"{stem}.nc", engine="scipy") as ds:
        assert ds["br_phot"].attrs["units"] == "G"
        assert ("br" in ds) == (kind != "surface") and ("br_scs" in ds) == (kind == "scs")
    text = Path(f"{stem}_README.txt").read_text()
    assert "{{" not in text
    assert f"heliofield_model-2014-03-12_saved-{header['saved_date']}_{kind}.nc" in text       # model date, then save date
    if kind != "surface":
        assert f"heliofield_model-2014-03-12_saved-{header['saved_date']}_surface.nc" in text   # 3D bundles carry the surface maps
    for f in ("plot_surface.py", "plot_3d.py", "compute_corona.py", "heliofield_update.py", "requirements-tested.txt"):
        assert f in text


def test_model_boundary_is_the_smoothed_map(exports):
    """br_phot is what the model uses: the input map expanded to degree 40
    without the monopole, smoother than br_input and with zero net flux."""
    from heliofield_io import load
    res = load(f"{exports['surface']}.nc")
    raw, model = res["br_input"], res["br_phot"]
    assert abs(raw.mean()) < 1e-3 and abs(model.mean()) < 0.02 * np.abs(model).mean()
    assert model.std() < 0.7 * raw.std()
    # A projection: what was removed (the scales above degree 40) is
    # uncorrelated with what was kept.
    assert abs(np.corrcoef(model.ravel(), (raw - model).ravel())[0, 1]) < 0.1
    assert "degree 40" in res.var_attrs["br_phot"]["preprocessing"]


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
    assert np.array_equal(py["br_input"], js["br_input"])
    for k in ["br_phot", "br_ss", "br", "btheta", "bphi"] + (["br_cusp", "br_scs", "btheta_scs", "bphi_scs"] if model == "scs" else []):
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


def test_updater(tmp_path, monkeypatch):
    """heliofield_update.py replaces scripts that differ from the published
    ones, after checking each against the manifest's SHA-256, and keeps the
    old copy as .bak. The site is stubbed with the repository's own files."""
    import hashlib
    import importlib.util
    import shutil
    for f in DL.glob("*"):
        if f.is_file():
            shutil.copy(f, tmp_path / f.name)
    spec = importlib.util.spec_from_file_location("hu", tmp_path / "heliofield_update.py")
    hu = importlib.util.module_from_spec(spec); spec.loader.exec_module(hu)
    man = json.loads((DL / "manifest.json").read_text())
    monkeypatch.setattr(hu, "_get", lambda url, timeout=15: json.dumps(man).encode() if url.endswith("manifest.json")
                        else (DL / url.rsplit("/", 1)[1]).read_bytes())
    assert hu.outdated() == []                                   # the manifest matches the scripts here
    (tmp_path / "plot_3d.py").write_text("# an old copy\n")
    assert hu.outdated() == ["plot_3d.py"]
    assert hu.update(verbose=False) == ["plot_3d.py"]
    assert (tmp_path / "plot_3d.py.bak").read_text() == "# an old copy\n"
    assert hashlib.sha256((tmp_path / "plot_3d.py").read_bytes()).hexdigest() == man["files"]["plot_3d.py"]
    man["files"]["plot_surface.py"] = "0" * 64                   # a corrupted download is refused
    (tmp_path / "plot_surface.py").write_text("# old\n")
    with pytest.raises(RuntimeError):
        hu.update(verbose=False)
    assert isinstance(hu.check_versions(stream=None), list)
