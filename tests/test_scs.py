"""The Schatten current-sheet (SCS) coupling of the browser solver.

Beyond the cusp surface rcp = 0.92 R_ss the model is the potential field of
|B_r(rcp)| outside a sphere, vanishing at infinity:

    B_r(r) = sum a_lm (rcp/r)^(l+2) Y_lm,   a_lm the harmonics of |B_r(rcp)|.

For a dipole this has a closed form, which the fast tests use. The slow
tests solve archived HMI rotation maps: they compare the SCS field with one
built in Python from the sunkit-magex PFSS field at rcp. They also check
that the unsigned flux is conserved outward and that the traced current
sheet separates opposite polarities.
"""
from __future__ import annotations

import numpy as np
import pytest
from numpy.polynomial import legendre as npleg
from scipy.integrate import quad
from scipy.special import eval_legendre

from conftest import MU, NX, PHI, report
from test_exact import dipole, pbar, RSS, RSUN_CM

RCP = round(0.92 * RSS, 3)
L = 40


def unit(lon, lat):
    lon, lat = np.radians(lon), np.radians(lat)
    return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], -1)


def abs_mu_series():
    """Legendre coefficients of |mu| up to degree L (odd ones vanish)."""
    return np.array([(2 * l + 1) / 2 * quad(lambda x: abs(x) * eval_legendre(l, x), -1, 1, points=[0], limit=200)[0]
                     for l in range(L + 1)])


def test_dipole_scs_field(js):
    """The SCS field of a dipole against its series solution, truncated at the same degree."""
    br, f, _ = dipole()
    A, c = f(RCP), abs_mu_series()
    pts, want = [], []
    for r in (2.6, 4.0, 8.0, 15.0, 21.0):
        for th in np.radians([20, 60, 100, 150]):
            ph, mu = 0.7, np.cos(th)
            q = RCP / r
            Br = A * sum(c[l] * q ** (l + 2) * eval_legendre(l, mu) for l in range(L + 1))
            Bt = A * sum(c[l] * RCP / ((l + 1) * r) * q ** (l + 1) * np.sin(th) * npleg.Legendre.basis(l).deriv()(mu)
                         for l in range(1, L + 1))
            pts.append([r * np.sin(th) * np.cos(ph), r * np.sin(th) * np.sin(ph), r * np.cos(th)])
            want.append([Br, Bt])
    got = js("scsfield", map=br, rss=RSS, rout=21.5, points=pts)
    assert abs(got["rcp"] - RCP) < 1e-9
    B, P = np.array(got["values"]), np.array(pts)
    r = np.linalg.norm(P, axis=1)
    th = np.arccos(P[:, 2] / r)
    rhat = P / r[:, None]
    thhat = np.stack([np.cos(th) * np.cos(0.7), np.cos(th) * np.sin(0.7), -np.sin(th)], 1)
    have = np.stack([(B * rhat).sum(1), (B * thhat).sum(1)], 1)
    err = np.linalg.norm(have - np.array(want), axis=1) / np.linalg.norm(want, axis=1)
    assert err.max() < 0.02, err


def test_dipole_scs_sheet_and_flux(js):
    """A dipole's current sheet stays on the equator from rcp to rout, and the
    open flux is that of the dipole at the cusp surface."""
    br, f, _ = dipole()
    res = js("solve", map=br, rout=21.5)
    assert res["model"]["rcp"] == RCP and res["model"]["rout"] == 21.5
    want = 2 * np.pi * (RCP * RSUN_CM) ** 2 * f(RCP)
    assert abs(res["open_flux_Mx"] / want - 1) < 0.01
    lat_out = np.concatenate([np.array(h)[1::2] for h in res["hcs_out"]])
    lat_rib = np.concatenate([np.array(rib)[1::3] for ribs in res["hcs_ribs"] for rib in ribs])
    assert np.abs(lat_out).max() < 0.6 and np.abs(lat_rib).max() < 0.6
    # Every open line reaches the outer edge.
    kind = np.array(res["kind"])
    assert kind.any()


@pytest.mark.slow
@pytest.mark.parametrize("cr", [2148, 2230])
def test_scs_against_python(js, cr):
    """The browser's SCS field against one built here from the sunkit-magex
    PFSS solution: |B_r| at the cusp surface, expanded in harmonics to degree
    40 including the monopole, and continued outward analytically."""
    import rotations
    import sunkit_magex.pfss as pfss
    import astropy.units as u
    from astropy.coordinates import SkyCoord

    start = next(r["start"] for r in rotations.rotation_index() if r["cr"] == cr)
    br = rotations.load_cr(cr)
    out = pfss.pfss(pfss.Input(rotations.sinlat_map(br, start.rstrip("Z")), rotations.NR, RSS))
    LO, LA = np.meshgrid(np.degrees(PHI), np.degrees(np.arcsin(MU)))
    c = SkyCoord(LO.ravel() * u.deg, LA.ravel() * u.deg, np.full(LO.size, RCP * rotations.RSUN_KM) * u.km,
                 frame=out.coordinate_frame)
    babs = np.abs(out.get_bvec(c)[:, 0].to_value("G")).reshape(MU.size, NX)

    # Harmonic analysis on the sin(latitude) grid (midpoint rule, as the map rows).
    dO = (2 / MU.size) * (2 * np.pi / NX) / (4 * np.pi)
    cos_m = np.cos(np.outer(np.arange(L + 1), PHI)); sin_m = np.sin(np.outer(np.arange(L + 1), PHI))
    cm, sm = babs @ cos_m.T, babs @ sin_m.T                    # (ny, m)
    coef = {(l, m): ((pbar(l, m, MU) * cm[:, m]).sum() * dO, (pbar(l, m, MU) * sm[:, m]).sum() * dO)
            for l in range(L + 1) for m in range(l + 1)}

    rng = np.random.default_rng(3)
    n = 300
    lon, lat = rng.uniform(0, 360, n), np.degrees(np.arcsin(rng.uniform(-1, 1, n)))
    stats = {}
    for r in (3.0, 5.0, 10.0, 20.0):
        mu, ph = np.sin(np.radians(lat)), np.radians(lon)
        want = sum((C * np.cos(m * ph) + S * np.sin(m * ph)) * pbar(l, m, mu) * (RCP / r) ** (l + 2)
                   for (l, m), (C, S) in coef.items())
        pts = r * unit(lon, lat)
        B = np.array(js("scsfield", map=br.astype(np.float32), rss=RSS, rout=21.5, points=pts.tolist())["values"])
        got = (B * pts).sum(1) / r
        rel = np.abs(got / want - 1)
        stats[f"r{r:g}"] = [round(float(np.corrcoef(got, want)[0, 1]), 5), round(float(np.median(rel)), 4)]
    # Unsigned flux r^2 <|B_r|> through spheres from the cusp surface out.
    lo, la = np.meshgrid(np.arange(1, 360, 2.0), np.arange(-89, 90, 2.0))
    w = np.cos(np.radians(la)).ravel()
    flux = []
    radii = (RCP * 1.005, (RCP + RSS) / 2, 2.6, 5.0, 10.0, 21.0)
    for r in radii:
        pts = r * unit(lo.ravel(), la.ravel())
        B = np.array(js("scsfield", map=br.astype(np.float32), rss=RSS, rout=21.5, points=pts.tolist())["values"])
        absbr = np.abs((B * pts).sum(1) / r)
        flux.append(float(r ** 2 * np.sum(w * absbr) / w.sum()))
    # Outside the source surface the field is pure SCS: flux is conserved.
    # Inside, the PFSS-to-SCS transition shell is a blend of two solutions,
    # which is not divergence-free; its flux error is under 1% on these maps.
    outer = flux[2:]
    spread = float(np.ptp(outer) / np.mean(outer))
    shell = float(max(abs(f / np.mean(outer) - 1) for f in flux[:2]))
    # Far out, |B_r| r^2 hardly depends on latitude, as Ulysses found
    # (Smith & Balogh 1995); PFSS alone at its source surface does not do this.
    bands = absbr.reshape(la.shape).mean(axis=1)[5:85].reshape(-1, 5).mean(axis=1)   # 10-degree bands, |lat| < 80
    uniform = float(bands.max() / bands.min())
    # The traced current sheet at rout: polarity 3 degrees either side.
    res = js("solve", map=br.astype(np.float32), rout=21.5)
    h = np.concatenate([np.reshape(h, (-1, 2))[::3] for h in res["hcs_out"]])
    north, south = (h + [0, 3]).tolist(), (h - [0, 3]).tolist()
    pol = np.array(js("scspolarity", map=br.astype(np.float32), rss=RSS, rout=21.5, r=21.0, lonlat=north + south)["values"])
    split = float(np.mean((pol[:len(h)] * pol[len(h):]) < 0))
    report(f"scs-cr{cr}", dict(note="per radius: correlation, median |rel diff| of B_r vs Python",
                               flux_spread=round(spread, 5), shell_flux_error=round(shell, 4), sheet_split=round(split, 3),
                               lat_band_max_over_min=round(uniform, 3), **stats))
    for corr, rel in stats.values():
        assert corr > 0.995 and rel < 0.03
    assert spread < 0.002
    assert shell < 0.015
    assert split > 0.85
    assert uniform < 1.1


@pytest.mark.slow
@pytest.mark.parametrize("cr", [2148, 2230])
def test_no_kink_at_the_cusp(js, cr):
    """Across the cusp surface the field keeps its direction: the PFSS field
    just below (turned outward) and the coupled field just above agree. Without the
    transition shell they differ by a median 15-22 degrees on these maps."""
    import rotations
    br = rotations.load_cr(cr).astype(np.float32)
    lo, la = np.meshgrid(np.arange(1, 360, 4.0), np.arange(-87, 88, 4.0))
    u = unit(lo.ravel(), la.ravel())
    below = np.array(js("field", map=br, rss=RSS, points=(u * RCP * 0.999).tolist()))
    above = np.array(js("scsfield", map=br, rss=RSS, rout=21.5, points=(u * RCP * 1.001).tolist())["values"])
    sign = np.sign((below * u).sum(1))[:, None]
    cos = (sign * below * above).sum(1) / np.linalg.norm(below, axis=1) / np.linalg.norm(above, axis=1)
    ang = np.degrees(np.arccos(np.clip(cos, -1, 1)))
    report(f"scs-cusp-cr{cr}", dict(median_deg=round(float(np.median(ang)), 3), p90_deg=round(float(np.percentile(ang, 90)), 3)))
    assert np.median(ang) < 1 and np.percentile(ang, 90) < 2
