"""Shared helpers for the HelioField validation suite.

The suite checks the browser solver (js/pfss.js), run under Node through
tests/js/bridge.mjs, against exact solutions and against the Python pipeline
(sunkit-magex). Run it with

    pip install -r requirements.txt -r requirements-test.txt
    python -m pytest tests -v          # everything (under two minutes)
    python -m pytest tests -v -m "not slow"   # exact solutions only (seconds)

Node.js 22.12 or newer must be on PATH. Nothing is downloaded: the maps come
from the repository's own HMI rotation archive (data/history/cr).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "tests" / "js" / "bridge.mjs"
REPORT = ROOT / "cache" / "validation"
sys.path.insert(0, str(ROOT / "scripts"))

NY, NX = 180, 360
# Cell-centre sin(latitude) and longitude [rad] of the map grid.
MU = np.linspace(-1 + 1 / NY, 1 - 1 / NY, NY)
PHI = (np.arange(NX) + 0.5) * 2 * np.pi / NX


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: compares with sunkit-magex on archived rotation maps (under a minute)")


@pytest.fixture(scope="session")
def js(tmp_path_factory):
    """Call the JS solver: js(cmd, map=None, **request) -> parsed reply."""
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is needed to run the browser solver")
    tmp = tmp_path_factory.mktemp("maps")

    def call(cmd, map=None, timeout=900, **req):
        if map is not None:
            path = tmp / f"map{abs(hash(map.tobytes()))}.f32"
            np.asarray(map, "<f4").tofile(path)
            req.update(br=str(path), ny=map.shape[0], nx=map.shape[1])
        p = subprocess.run([node, str(BRIDGE)], input=json.dumps({"cmd": cmd, **req}),
                           capture_output=True, text=True, timeout=timeout)
        if p.returncode:
            raise RuntimeError(p.stderr)
        return json.loads(p.stdout)
    return call


def report(name: str, data: dict):
    """Keep each comparison's numbers in cache/validation/<name>.json and print them."""
    REPORT.mkdir(parents=True, exist_ok=True)
    (REPORT / f"{name}.json").write_text(json.dumps(data, indent=1))
    print(f"\n{name}: " + ", ".join(f"{k}={v}" for k, v in data.items() if not isinstance(v, (list, dict))))
