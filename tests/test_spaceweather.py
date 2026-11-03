"""The space-weather page (spaceweather.html): the physics in js/sw-model.js
against known results, and the page's parameters against its descriptions.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess

import pytest

from conftest import ROOT

MODEL = (ROOT / "js" / "sw-model.js").as_uri()


def run(body: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is needed to run the page's model")
    script = f'import * as M from "{MODEL}";\nconst out = (() => {{ {body} }})();\nprocess.stdout.write(JSON.stringify(out));'
    p = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, check=True)
    return json.loads(p.stdout)


def test_russell_mcpherron():
    """Sectors towards the Sun are most southward near 5 April at 22 UT,
    sectors away near 5 October at 10 UT (Russell & McPherron 1973)."""
    out = run("""
      const day = (d, pol) => M.bzDay(Date.parse(d + "T00:00:00Z"), pol);
      return { aprT: day("2026-04-05", -1), aprA: day("2026-04-05", 1), octA: day("2026-10-05", 1), octT: day("2026-10-05", -1),
               junT: day("2026-06-21", -1) };""")
    assert out["aprT"]["mean"] < -0.25 and out["aprA"]["mean"] > 0.25
    assert out["octA"]["mean"] < -0.25 and out["octT"]["mean"] > 0.25
    assert out["aprT"]["minHour"] in (21, 22, 23) and out["octA"]["minHour"] in (9, 10, 11)
    assert abs(out["junT"]["mean"]) < 0.15            # solstices: little preference


def test_hux_keeps_uniform_wind_and_steepens_streams():
    out = run("""
      const flat = M.hux(new Float64Array(360).fill(420), 2.5, 215);
      const step = new Float64Array(360).map((_, j) => (j >= 100 && j < 160 ? 700 : 350));
      const far = M.hux(step, 2.5, 215), jump = (v) => Math.max(...v.map((x, j) => Math.abs(v[(j + 1) % 360] - x)));
      const near = M.hux(step, 2.5, 20);
      return { flat: [Math.min(...flat.v), Math.max(...flat.v)], vmax: Math.max(...far.v), vmin: Math.min(...far.v),
               jumpNear: jump(near.v), jumpFar: jump(far.v), meanIn: step.reduce((a, b) => a + b) / 360, meanOut: far.v.reduce((a, b) => a + b) / 360 };""")
    assert out["flat"] == [420, 420]
    assert out["vmax"] <= 700 + 1e-9 and out["vmin"] >= 350 - 1e-9      # upwind scheme: no new extremes
    assert out["jumpFar"] > 30                                            # the stream interface survives as a front
    assert abs(out["meanOut"] - out["meanIn"]) < 60


def test_series_follows_earth_and_finds_boundaries():
    """A ring with one outward half: Earth's longitude falls 13.2 deg/day, so
    in 27.3 days it crosses both boundaries once."""
    out = run("""
      const v = new Float64Array(360).fill(400), b = new Float64Array(360).map((_, j) => (j < 180 ? 1 : -1));
      const rings = M.propagate(v, b, 2.5, 1.0), t0 = Date.parse("2026-01-01T00:00:00Z");
      const ser = M.series(rings, 200, t0, t0, t0 + 27.27 * 86400000, 3600000);
      return { cross: M.crossings(ser).length, lon1: ser[24].lon, v: ser[10].v };""")
    assert out["cross"] == 2
    assert abs(out["lon1"] - (200 - 360 / 27.2753)) < 1e-6
    assert abs(out["v"] - 400) < 1e-9


def test_drag_based_model():
    out = run("""
      const AU = 149597870.7, r0 = 21.5 * 695700;
      return { same: M.dbm(450, 450, 0, 450 * 86400), fast: M.dbm(1500, 400, r0, AU), slow: M.dbm(300, 450, r0, AU) };""")
    assert abs(out["same"]["t"] - 86400) < 1 and abs(out["same"]["v"] - 450) < 1e-6
    # A 1500 km/s CME slows towards the wind: faster than the wind, slower than ballistic.
    ballistic = (149597870.7 - 21.5 * 695700) / 1500
    assert ballistic < out["fast"]["t"] < (149597870.7 - 21.5 * 695700) / 400 and 400 < out["fast"]["v"] < 1500
    assert 300 < out["slow"]["v"] < 450


def test_geometry_helpers():
    out = run("""
      return { loc: M.parseLocation("S12E40"), name: M.stonyhurst(-35.4, -7.6), ang: M.angle(10, 0, 40, 0),
               cone: M.cmeGeometry({ lon: 0, lat: 0, half: 30 }, { lon: 35, lat: 0 }).hit, conn: [M.connection(20), M.connection(45), M.connection(80)],
               arr: M.arrivalDays(100, 100, 400, 1, 2.5) };""")
    assert out["loc"] == {"lat": -12, "lon": -40}
    assert out["name"] == "S08E35" and abs(out["ang"] - 30) < 1e-9
    assert out["cone"] == "flank" and out["conn"] == ["good", "partial", "poor"]
    # Wind from straight below Earth arrives after the spiral winding (~57 deg at 400 km/s) has rotated past.
    assert 4.0 < out["arr"] < 4.6


def test_open_regions():
    """Two separate holes, one crossing longitude 0: wrapping joins it."""
    out = run("""
      const cls = new Int8Array(360 * 180);
      for (let i = 85; i < 95; i++) { for (let j = 355; j < 360; j++) cls[i * 360 + j] = 1; for (let j = 0; j < 5; j++) cls[i * 360 + j] = 1; }
      for (let i = 0; i < 20; i++) for (let j = 0; j < 360; j++) cls[i * 360 + j] = -1;       // polar cap, no low-latitude part
      return M.openRegions(cls, 35).map((r) => ({ pol: r.pol, low: r.lowArea, lon: r.lon ?? null }));""")
    assert len(out) == 2
    eq = next(r for r in out if r["pol"] == 1)
    assert eq["low"] > 0 and (eq["lon"] < 1 or eq["lon"] > 359)
    assert next(r for r in out if r["pol"] == -1)["low"] == 0


def test_page_parameters_are_documented():
    code = (ROOT / "js" / "spaceweather.js").read_text()
    names = set(re.findall(r'params\.get\("([a-z]+)"\)', code))
    api = json.loads((ROOT / "api.json").read_text())["spaceweather"]
    assert {p["name"] for p in api["parameters"]} == names
    llms = (ROOT / "llms.txt").read_text()
    for n in names:
        assert re.search(rf"`{n}(=[^`]*)?`", llms), n
    head = (ROOT / "spaceweather.html").read_text().split("</head>")[0]
    assert "llms.txt" in head and "api.json" in head
    for page in ("index.html", "guide.html", "series.html", "connect.html", "spaceweather.html"):
        assert 'href="spaceweather.html"' in (ROOT / page).read_text(), page
    assert 'id="spaceweather"' in (ROOT / "guide.html").read_text()


def test_python_hux_matches_the_page():
    """scripts/calibrate_wsa.py refits the speeds with its own HUX; it must be
    the page's scheme, step for step."""
    import numpy as np
    import calibrate_wsa as C
    rng = np.random.default_rng(3)
    v0 = 300 + 400 * rng.random(360)
    b0 = rng.choice([-1.0, 1.0], 360)
    js = run(f"const o = M.hux(Float64Array.from({json.dumps(v0.tolist())}), 2.5, 213.4, [Float64Array.from({json.dumps(b0.tolist())})]);"
             " return { v: Array.from(o.v), b: Array.from(o.q[0]) };")
    v, (b,) = C.hux(v0, 2.5, 213.4, [b0])
    assert np.abs(v - np.array(js["v"])).max() < 1e-9 and np.abs(b - np.array(js["b"])).max() < 1e-9


def test_measured_daily_means():
    import sw_record as R
    hours = {"2026-10-01": [dict(v=400.0 + h, b=5.0, bz=-1.0, s=1 if h < 18 else -1, kp=2.0 + (h == 5), dst=-10.0 - h) for h in range(24)],
             "2026-10-02": [dict(v=500.0, b=None, bz=None, s=None, kp=None, dst=None) for _ in range(6)]}
    out = R.daily(hours)
    assert set(out) == {"2026-10-01"}                         # too few hours on the 2nd
    d = out["2026-10-01"]
    assert d["v"] == 411.5 and d["v_min"] == 400 and d["v_max"] == 423 and d["n"] == 24
    assert d["away"] == 0.75 and d["kp_max"] == 3.0 and d["dst_min"] == -33.0
    assert R.sector_sign(-3.0, 3.0) == 1 and R.sector_sign(3.0, -3.0) == -1


def test_record_of_a_product():
    """The daily record of a real product, through the same Node entry point
    the workflow uses."""
    import sw_record as R
    days = json.loads((ROOT / "data" / "index.json").read_text())["dates"]
    p = next((R.product(d) for d in reversed(days) if (ROOT / "data" / d / "wsa.png").exists()), None)
    if p is None:
        pytest.skip("no daily product with a speed map")
    rec = R.evaluate(dict(p, events=None))["record"]
    assert rec["date"] == p["day"] and len(rec["fc_v"]) == 9 and len(rec["fc_b"]) == 9
    assert 200 <= rec["v"] <= 900 and rec["sector"] in (-1, 1)
    assert all(v is None or 200 <= v <= 900 for v in rec["fc_v"])


def test_share_card_and_page(tmp_path, monkeypatch):
    """A day's card is 1200 x 630 and its share page names it in the tags
    the networks read, and forwards to the assessment."""
    from PIL import Image
    import sw_card as C
    import sw_record as R
    days = json.loads((ROOT / "data" / "index.json").read_text())["dates"]
    day = next((d for d in reversed(days) if (ROOT / "data" / d / "wsa.png").exists()), None)
    if day is None:
        pytest.skip("no daily product with a speed map")
    out = R.evaluate(dict(R.product(day), events=None))
    assert out["level"] in ("good", "watch", "high", "severe") and out["record"]["level"] == out["level"]
    monkeypatch.setattr(C, "OUT", tmp_path)
    C.write(day, out, latest=True)
    assert Image.open(tmp_path / f"{day}.png").size == (1200, 630)
    assert (tmp_path / "latest.png").read_bytes() == (tmp_path / f"{day}.png").read_bytes()
    page = (tmp_path / f"{day}.html").read_text()
    for tag in ('property="og:image" content="https://sr-dash.github.io/heliofield/sw/', 'name="twitter:image"',
                'name="twitter:card" content="summary_large_image"', f"spaceweather.html?date={day}"):
        assert tag in page, tag
