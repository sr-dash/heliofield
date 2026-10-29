"""The descriptions of HelioField for people, search engines and agents
(llms.txt, api.json, the guide, the pages' metadata) against the code, so a
change to a URL parameter or a release cannot leave them behind. The slow
test runs `compute_corona.py --date ... --plot` end to end, against the
repository's own files instead of the site, so it works offline.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from conftest import ROOT

API = json.loads((ROOT / "api.json").read_text())
LLMS = (ROOT / "llms.txt").read_text()
GUIDE = (ROOT / "guide.html").read_text()
MAIN = (ROOT / "js" / "main.js").read_text()
INDEX = (ROOT / "index.html").read_text()


def url_params_in_code():
    names = set(re.findall(r'params\.(?:get|has)\("([a-z]+)"\)', MAIN))
    names |= set(re.findall(r'q\.get\("([a-z]+)"\)', INDEX))
    return names


def test_api_parameters_match_the_code():
    api = {p["name"] for p in API["viewer"]["parameters"]}
    assert api == url_params_in_code()


def test_layers_match_the_code():
    layers = re.search(r"const LAYERS = \{(.*?)\};", MAIN, re.S).group(1)
    keys = set(re.findall(r"(\w+):", layers))
    api = next(p for p in API["viewer"]["parameters"] if p["name"] == "layers")
    assert set(api["items"]) == keys
    default = re.search(r"const DEFAULT_ON = \[(.*?)\]", MAIN).group(1)
    assert api["default"] == re.findall(r'"(\w+)"', default)
    for k in keys:
        assert f"`{k}`" in LLMS, k
        assert re.search(rf"<code>[^<]*\b{k}\b[^<]*</code>", GUIDE), k


def test_every_parameter_is_documented():
    table = GUIDE.split("<th>Parameter</th>")[1].split("</table>")[0]
    for p in API["viewer"]["parameters"]:
        assert re.search(rf"`{p['name']}(=[^`]*)?`", LLMS), p["name"]
        assert f"<code>{p['name']}</code>" in table, p["name"]


def test_pages_point_to_the_descriptions():
    for page in ("index.html", "guide.html", "series.html"):
        head = (ROOT / page).read_text().split("</head>")[0]
        assert 'href="https://sr-dash.github.io/heliofield/llms.txt"' in head, page
        assert 'rel="service-desc"' in head and "api.json" in head, page


def test_versions_agree():
    zen = json.loads((ROOT / ".zenodo.json").read_text())["version"]
    cff = re.search(r"^version: (\S+)", (ROOT / "CITATION.cff").read_text(), re.M).group(1)
    ld = json.loads(INDEX.split('<script type="application/ld+json">')[1].split("</script>")[0])
    app = next(n for n in ld["@graph"] if n.get("@type") == "WebApplication")
    assert zen == cff == app["softwareVersion"] == API["version"]
    assert app["potentialAction"]["target"]["urlTemplate"].startswith("https://sr-dash.github.io/heliofield/?date=")


def test_listed_scripts_exist():
    for f in API["scripts"]["files"]:
        assert (ROOT / "download" / f).exists(), f
        assert f in LLMS and f in GUIDE, f
    manifest = json.loads((ROOT / "download" / "manifest.json").read_text())
    assert set(API["scripts"]["files"]) <= set(manifest["files"])


@pytest.mark.slow
def test_compute_by_date(tmp_path):
    """The no-browser route: inputs fetched for a date (here from the
    repository, as file:// URLs), the corona solved, figures written. The
    inputs must be the ones the page uses."""
    import rotations
    sys.path.insert(0, str(ROOT / "download"))
    from heliofield_io import body_keys, fetch_inputs
    site = ROOT.as_uri() + "/"
    src = fetch_inputs("2014-03-12", site)
    assert np.array_equal(src["br_input"], rotations.load_cr(2148))
    fleet = json.loads((ROOT / "data" / "history" / "fleet" / "2014.json").read_text())
    i = 70                                     # 2014-03-12 is day 70 of the year file (from 1 January)
    assert abs(src.attrs["L0_deg"] - fleet["L0"][i]) < 1e-9 and "earth" in body_keys(src)
    p = subprocess.run([sys.executable, str(ROOT / "download" / "compute_corona.py"), "--date", "2014-03-12", "--site", site,
                        "--plot", "--view", "earth", "--out", str(tmp_path / "run")], capture_output=True, text=True, timeout=600)
    assert p.returncode == 0, p.stderr[-2000:]
    for f in ("run.nc", "run_3d.png", "run_3d.pdf", "run_surface.png", "run_surface.pdf"):
        assert (tmp_path / f).stat().st_size > 10_000, f
    assert json.loads((tmp_path / "run_header.json").read_text())["date"] == "2014-03-12"
