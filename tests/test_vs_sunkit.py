"""The browser solver against the Python pipeline (sunkit-magex) on archived
HMI rotation maps: one near the cycle-24 maximum, one at the 2019-20 minimum
and one in cycle 25. Both sides solve the same 180 x 360 map with a source
surface at 2.5 R_sun. sunkit-magex solves the Laplace equation by finite
differences; the browser expands the map in spherical harmonics to l = 40.
They are independent methods, so the tolerances below are agreement levels,
not round-off.

The Python side of each rotation is cached in cache/solve (the series
pipeline's cache), so a second run takes a fraction of the first. Each
comparison writes its numbers to cache/validation/cr<N>.json.
"""
from __future__ import annotations

import numpy as np
import pytest

from conftest import MU, NX, NY, report

pytestmark = pytest.mark.slow

ROTATIONS = [2148, 2230, 2300]
RSS = 2.5

# A synthetic fleet spread in longitude, latitude and distance. Each body is
# connected at every speed of the footpoint grid (200-900 km/s).
FLEET = {
    "a": dict(lon=30.0, lat=0.0, r=1.0, planet=False),
    "b": dict(lon=120.0, lat=7.0, r=0.3, planet=False),
    "c": dict(lon=210.0, lat=-7.0, r=1.0, planet=False),
    "d": dict(lon=300.0, lat=3.0, r=0.6, planet=False),
}


def to_equirect(ss):
    """A south-first sin(latitude) map resampled to 1-degree latitude rows."""
    s = np.sin(np.radians(-89.5 + np.arange(180)))
    return np.stack([np.interp(s, MU, ss[:, j]) for j in range(ss.shape[1])], axis=1)


def unit(lon, lat):
    lon, lat = np.radians(lon), np.radians(lat)
    return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], -1)


def separation(a, b):
    """Angle [deg] between unit vectors, row by row or all pairs."""
    return np.degrees(np.arccos(np.clip(a @ b.T, -1, 1)))


def contour_points(polys):
    return unit(*np.concatenate([np.reshape(p, (-1, 2)) for p in polys]).T)


@pytest.fixture(scope="module", params=ROTATIONS, ids=lambda cr: f"CR{cr}")
def pair(request, js):
    """The same rotation solved by sunkit-magex and by the browser solver."""
    import rotations
    from build_day import connectivity
    import sunkit_magex.pfss as pfss
    from sunkit_magex.pfss import tracing

    cr = request.param
    start = next(r["start"] for r in rotations.rotation_index() if r["cr"] == cr)
    br = rotations.load_cr(cr)
    py = rotations.solve(cr, start)
    out = pfss.pfss(pfss.Input(rotations.sinlat_map(br, start.rstrip("Z")), rotations.NR, RSS))
    jobs, res = connectivity(out, tracing.PerformanceTracer(), FLEET, RSS, lines=False)
    j = js("solve", map=br.astype(np.float32), fleet=FLEET)
    return cr, dict(py, jobs=jobs, res=res, out=out, br=br), j


def test_field_strength_with_height(pair, js):
    """|B| at random points on shells. Above ~1.1 R_sun both solutions are
    smooth and agree closely (|B| is small near the neutral line at 2.5, where
    the spread is largest). At the photosphere the l = 40 expansion on a
    2-degree grid misses small-scale field that the finite-difference
    solution keeps at the map's 1-degree resolution, so the browser's |B|
    there is smaller, by a median 10-50% on these maps. This is what moves
    f_s (below)."""
    from build_day import b_mag
    cr, py, _ = pair
    rng = np.random.default_rng(1)
    lon, lat = rng.uniform(0, 360, 400), np.degrees(np.arcsin(rng.uniform(-1, 1, 400)))
    stats = {}
    for r in (1.0, 1.1, 1.5, 2.5):
        bj = np.linalg.norm(js("field", map=py["br"].astype(np.float32), rss=RSS,
                               points=(r * unit(lon, lat)).tolist()), axis=1)
        lr = np.log(bj / b_mag(py["out"], lon, lat, r))
        stats[f"r{r}"] = [round(float(np.median(lr)), 3), round(float(np.percentile(np.abs(lr), 90)), 3)]
    report(f"cr{cr}-field", dict(note="per radius: median ln(|B|js/|B|py), 90th pct |ln|", **stats))
    for r in ("r1.1", "r1.5", "r2.5"):
        assert abs(stats[r][0]) < 0.03 and stats[r][1] < 0.15
    assert -1.2 < stats["r1.0"][0] < 0


def test_source_surface_field(pair):
    cr, py, j = pair
    a = to_equirect(py["ss"]).ravel()
    b = np.asarray(j["ss"])
    w = np.repeat(np.cos(np.radians(-89.5 + np.arange(180))), 360)
    corr = float(np.corrcoef(a, b)[0, 1])
    sign = float(np.sum(w * (np.sign(a) == np.sign(b))) / w.sum())
    ratio = float(j["open_flux_Mx"] / py["flux"])
    report(f"cr{cr}-surface", dict(corr=round(corr, 5), sign_agreement=round(sign, 4),
                                   open_flux_ratio=round(ratio, 4), js_seconds=j["seconds"]))
    assert corr > 0.995
    assert sign > 0.97
    assert abs(ratio - 1) < 0.05


def test_current_sheet(pair, js):
    cr, py, j = pair
    a = contour_points(j["hcs"])
    b = contour_points(js("contour", field=to_equirect(py["ss"]).ravel().tolist(), nlat=180, nlon=360))
    d = np.concatenate([separation(a, b).min(axis=1), separation(b, a).min(axis=1)])
    med, p95 = float(np.median(d)), float(np.percentile(d, 95))
    report(f"cr{cr}-hcs", dict(median_deg=round(med, 3), p95_deg=round(p95, 3), max_deg=round(float(d.max()), 3)))
    assert med < 1.0
    assert p95 < 4.0


def test_open_field_map(pair):
    cr, py, j = pair
    py_open = py["open"] != 0                          # equal-area sin(latitude) cells
    js_open = np.reshape(j["open"], (180, 360)).astype(bool)
    rows = np.floor(np.degrees(np.arcsin(MU)) + 90).astype(int)
    js_on_py = js_open[rows]                           # 1-degree rows sampled at the sin-lat centres
    agree = float(np.mean(js_on_py == py_open))
    fpy, fjs = float(py_open.mean()), float(j["open_fraction"])
    report(f"cr{cr}-open", dict(area_py=round(fpy, 4), area_js=round(fjs, 4), cell_agreement=round(agree, 4)))
    # Open area hinges on the small-scale photospheric field, so it differs
    # by up to ~20% even when the source-surface field matches.
    assert abs(fjs / fpy - 1) < 0.25
    assert agree > 0.95


def test_footpoints(pair):
    cr, py, j = pair
    jobs, res, con = py["jobs"], py["res"], j["connect"]
    assert len(con) == len(jobs) == len(res)
    # The same ballistic source-surface point on both sides.
    for job, c in zip(jobs, con):
        assert (job[0], job[1]) == (c["body"], c["v"])
        assert np.allclose(job[2:], c["ss"], atol=0.01)
    both = [(r, c) for r, c in zip(res, con) if r[1] and c["foot"]]
    reached = float(np.mean([bool(r[1]) == bool(c["foot"]) for r, c in zip(res, con)]))
    fp = np.array([r[1] for r, _ in both]), np.array([c["foot"] for _, c in both])
    d = np.diag(separation(unit(*fp[0].T), unit(*fp[1].T)))
    fs = np.log([c["fs"] / r[2] for r, c in both])
    dd = np.abs([c["dchb"] - r[3] for r, c in both])
    dv = np.abs([c["vwsa"] - r[4] for r, c in both])
    # Footpoints next to a separatrix can land in different holes, so the
    # checks are on the median and on the share that agree closely.
    close = float(np.mean(d < 3))
    report(f"cr{cr}-footpoints", dict(
        jobs=len(jobs), both_reach=round(reached, 3), foot_median_deg=round(float(np.median(d)), 3),
        foot_within_3deg=round(close, 3), fs_median_ln_ratio=round(float(np.median(fs)), 3),
        dchb_median_deg=round(float(np.median(dd)), 3), vwsa_median_kms=round(float(np.median(dv)), 1),
        foot_deg=np.round(d, 2).tolist()))
    assert reached > 0.95
    assert np.median(d) < 1.5
    assert close > 0.8
    # f_s inherits the weaker photospheric |B| (test_field_strength_with_height):
    # the browser's is typically 1.5-2.5 times smaller. The WSA speed depends
    # on it only as (1 + f_s)^(-2/9), so the speeds still agree to a few km/s.
    assert -1.2 < np.median(fs) < 0
    assert np.median(dd) < 1.0
    assert np.median(dv) < 20


@pytest.mark.parametrize("rss", [1.5, 2.0, 3.0, 3.5])
def test_other_source_surfaces(js, rss):
    """The viewer's source-surface slider (1.5-3.5 R_sun) re-solves past dates
    in the browser. One map at the minimum (CR 2230) and one near maximum
    (CR 2148), solved by both codes at each height."""
    import rotations
    import sunkit_magex.pfss as pfss
    stats = {}
    for cr in (2148, 2230):
        start = next(r["start"] for r in rotations.rotation_index() if r["cr"] == cr)
        br = rotations.load_cr(cr)
        out = pfss.pfss(pfss.Input(rotations.sinlat_map(br, start.rstrip("Z")), rotations.NR, rss))
        ss = out.source_surface_br.data
        flux = float(np.nansum(np.abs(ss)) * 4 * np.pi * (rss * rotations.RSUN_KM * 1e5) ** 2 / ss.size)
        j = js("solve", map=br.astype(np.float32), rss=rss)
        a, b = to_equirect(ss).ravel(), np.asarray(j["ss"])
        stats[f"cr{cr}"] = dict(corr=round(float(np.corrcoef(a, b)[0, 1]), 5),
                                open_flux_ratio=round(float(j["open_flux_Mx"] / flux), 4),
                                spread=j["ensemble"]["rss"])
    report(f"rss{rss}", dict(rss=rss, **{f"{k}_{q}": v[q] for k, v in stats.items() for q in ("corr", "open_flux_ratio")}))
    for v in stats.values():
        assert v["corr"] > 0.995
        assert abs(v["open_flux_ratio"] - 1) < 0.05
        assert v["spread"] == [round(max(1.3, rss - 0.5), 2), round(rss + 0.5, 2)]
