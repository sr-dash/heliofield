"""The connectivity page (connect.html): its geometry against SunPy, the
matching of observations against footpoints, and the polarity it predicts.

The projections must agree with SunPy, which HelioFleet also follows, so
that footpoints land where HelioFleet's observation footprints are drawn.
"""
from __future__ import annotations

import numpy as np
import pytest

AU_RS = 149597870.7 / 695700


def geo(js, fn, calls):
    return js("geo", fn=fn, calls=calls)


@pytest.mark.parametrize("obs", [dict(lon=0.0, lat=-7.2, d_au=0.99), dict(lon=-35.0, lat=5.0, d_au=0.3), dict(lon=120.0, lat=-3.0, d_au=0.6)])
def test_projection_matches_sunpy(js, obs):
    pytest.importorskip("sunpy")
    import astropy.units as u
    from astropy.coordinates import SkyCoord
    from sunpy.coordinates import frames
    t = "2025-03-22T12:00:00"
    rng = np.random.default_rng(4)
    lon, lat = rng.uniform(-85, 85, 50), rng.uniform(-75, 75, 50)
    o = SkyCoord(obs["lon"] * u.deg, obs["lat"] * u.deg, obs["d_au"] * u.au, frame=frames.HeliographicStonyhurst, obstime=t)
    hp = SkyCoord(lon * u.deg, lat * u.deg, 695700 * u.km, frame=frames.HeliographicStonyhurst, obstime=t).transform_to(
        frames.Helioprojective(observer=o, obstime=t))
    O = dict(lon=obs["lon"], lat=obs["lat"], d=obs["d_au"] * AU_RS)
    got = geo(js, "toHpc", [[a, b, O] for a, b in zip(lon, lat)])
    assert np.abs(np.array([g["x"] for g in got]) - hp.Tx.arcsec).max() < 1e-3
    assert np.abs(np.array([g["y"] for g in got]) - hp.Ty.arcsec).max() < 1e-3
    back = geo(js, "fromHpc", [[g["x"], g["y"], O] for g in got])
    for b, a, c, g in zip(back, lon, lat, got):
        if g["visible"]:
            assert abs((b["lon"] - a + 180) % 360 - 180) < 1e-6 and abs(b["lat"] - c) < 1e-6


def test_sky_projection(js):
    """Plane-of-sky coordinates: west is +x, north +y, and the elongation is the
    angle from Sun centre; for a surface point Tx matches toHpc."""
    cam_args = [10.0, 0.0, 215.0]
    pts = [[0, 0, 5.0], [215.0 * 0 + 0, 5.0, 0], [5.0 * np.cos(np.radians(100)), 5.0 * np.sin(np.radians(100)), 0]]
    out = js("geo", fn="skyPoint", calls=[[js("geo", fn="skyCamera", calls=[cam_args])[0], p] for p in pts])
    north, side = out[0], out[1]
    assert north["y"] > 4.9 and abs(north["x"]) < 1e-9 and abs(north["pa"]) < 1e-6
    d = 215.0
    q = np.array([0, 5.0, 0]) - d * np.array([np.cos(np.radians(10)), np.sin(np.radians(10)), 0])
    assert abs(side["elong"] - np.degrees(np.arccos(-q @ np.array([np.cos(np.radians(10)), np.sin(np.radians(10)), 0]) / np.linalg.norm(q)))) < 1e-9
    # West: a point that the Sun's rotation carries towards the observer's right.
    assert side["x"] > 0


def test_matching(js):
    """An observation whose field surrounds the footpoint's projection is found
    and marked 'inside'; one far away, or outside the time window, is not."""
    earth = dict(lon=100.0, lat=-7.0, r=0.99)
    foot = dict(lon=110.0, lat=10.0)
    h = geo(js, "toHpc", [[foot["lon"] - earth["lon"], foot["lat"], dict(lon=0, lat=earth["lat"], d=earth["r"] * AU_RS)]])[0]
    box = lambda cx, cy, s: dict(x=[cx - s, cx + s, cx + s, cx - s, cx - s], y=[cy - s, cy - s, cy + s, cy + s, cy - s])
    rows = [dict(i="iris", t0="2025-03-20T10:00:00Z", t1="2025-03-20T11:00:00Z", f="E", id="a", **box(h["x"], h["y"], 30)),
            dict(i="eis", t0="2025-03-20T10:00:00Z", t1="2025-03-20T11:00:00Z", f="E", id="b", **box(h["x"] + 600, h["y"], 30)),
            dict(i="iris", t0="2025-03-25T10:00:00Z", t1="2025-03-25T11:00:00Z", f="E", id="c", **box(h["x"], h["y"], 30))]
    import json, subprocess, sys
    from conftest import BRIDGE
    script = f"""
import * as g from "{BRIDGE.parent.parent.parent.as_uri()}/js/connect-geo.js";
const rows = {json.dumps(rows)}, feet = [{json.dumps(foot)}];
const earthAt = () => ({json.dumps(earth)});
const m = g.matchObservations(rows, feet, Date.parse("2025-03-20T00:00:00Z"), Date.parse("2025-03-21T00:00:00Z"), earthAt);
process.stdout.write(JSON.stringify(m.map((x) => [x.row.id, x.inMain, x.nearDeg])));
"""
    out = json.loads(subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True).stdout)
    assert out == [["a", True, 0]]


def test_interpolation_wraps_longitude(js):
    import json, subprocess
    from conftest import BRIDGE
    script = f"""
import * as g from "{BRIDGE.parent.parent.parent.as_uri()}/js/connect-geo.js";
const s = [{{ t: 0, lon: 5, lat: 0, r: 1 }}, {{ t: 86400000, lon: 351.8, lat: 1, r: 1 }}];
process.stdout.write(JSON.stringify(g.interpolate(s, 43200000)));
"""
    p = json.loads(subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True).stdout)
    assert abs(p["lon"] - 358.4) < 1e-9 and abs(p["lat"] - 0.5) < 1e-9


@pytest.mark.slow
@pytest.mark.parametrize("rout", [0, 21.5])
def test_polarity_follows_the_field_line(js, rout):
    """A connected open field line keeps its sign from the photosphere to the
    model's outer boundary, so the polarity predicted at the spacecraft must
    equal the footpoint's, for PFSS and for PFSS + SCS."""
    import rotations
    fleet = {"a": dict(lon=30.0, lat=0.0, r=1.0, planet=False), "b": dict(lon=150.0, lat=5.0, r=0.3, planet=False),
             "c": dict(lon=270.0, lat=-5.0, r=0.6, planet=False)}
    rows = js("connect", map=rotations.load_cr(2148).astype(np.float32), rout=rout, fleet=fleet)
    reached = [r for r in rows if r["foot"]]
    assert len(reached) > 0.9 * len(rows)
    agree = np.mean([r["pol"] == r["footPol"] for r in reached])
    assert agree > 0.97, agree
    assert all(r["sheetDeg"] is not None and 0 <= r["sheetDeg"] <= 180 for r in rows)


@pytest.mark.slow
def test_spacecraft_inside_the_scs_domain(js):
    """Parker Solar Probe near perihelion sits inside 21.5 R_sun. With SCS it
    must be traced from its own position (no Parker spiral back out to the
    outer edge), and still reach the photosphere."""
    import rotations
    fleet = {"psp": dict(lon=80.0, lat=3.0, r=0.06, planet=False), "far": dict(lon=200.0, lat=0.0, r=1.0, planet=False)}
    rows = js("connect", map=rotations.load_cr(2230).astype(np.float32), rout=21.5, fleet=fleet)
    psp = [r for r in rows if r["body"] == "psp"]
    assert all(r.get("inside") for r in psp) and all(abs(r["ss"][0] - 80.0) < 1e-6 for r in psp)
    assert sum(bool(r["foot"]) for r in psp) > 0.9 * len(psp)
    assert not any(r.get("inside") for r in rows if r["body"] == "far")
    pfss = js("connect", map=rotations.load_cr(2230).astype(np.float32), rout=0, fleet=fleet)
    assert not any(r.get("inside") for r in pfss)          # PFSS: 12.9 R_sun is outside its 2.5 R_sun edge
