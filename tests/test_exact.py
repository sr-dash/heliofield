"""The browser solver against exact results: Legendre functions, harmonic
analysis, and the PFSS dipole (field, field lines, open flux, neutral line)."""
import numpy as np
from scipy.special import gammaln, lpmv

from conftest import MU, PHI, NY, NX

RSS, RSUN_CM = 2.5, 6.957e10


def pbar(l, m, mu):
    """4-pi-normalised associated Legendre function without the Condon-Shortley phase."""
    norm = np.sqrt((2 - (m == 0)) * (2 * l + 1) * np.exp(gammaln(l - m + 1) - gammaln(l + m + 1)))
    return norm * (-1) ** m * lpmv(m, l, mu)


def test_legendre(js):
    L, mu = 40, [-0.93, -0.4, 0.0, 0.31, 0.88]
    got = np.array(js("alf", mu=mu, L=L)).reshape(len(mu), L + 1, L + 1)
    want = np.array([[[pbar(l, m, u) if m <= l else 0 for m in range(L + 1)] for l in range(L + 1)] for u in mu])
    assert np.max(np.abs(got - want)) < 1e-9 * np.max(np.abs(want))


def test_harmonic_round_trip(js):
    L, terms = 40, {(1, 0): (1.0, 0), (2, 1): (0.6, -0.3), (5, 3): (0.2, 0.4), (9, 7): (-0.5, 0.1)}
    br = sum(pbar(l, m, MU)[:, None] * (c * np.cos(m * PHI) + s * np.sin(m * PHI))[None, :]
             for (l, m), (c, s) in terms.items())
    r = js("analyse", map=br, L=L)
    C, S = np.array(r["C"]).reshape(L + 1, L + 1), np.array(r["S"]).reshape(L + 1, L + 1)
    for (l, m), (c, s) in terms.items():
        assert abs(C[l, m] - c) < 0.01 and abs(S[l, m] - s) < 0.01
        C[l, m] = S[l, m] = 0
    # Leakage into other degrees. The solver integrates in latitude with the
    # midpoint rule on the map rows, which is not exact for high degrees: a
    # degree-9 term leaks about 4% of its amplitude. Kept as a documented
    # limit (a Gauss-Legendre resampling would remove it), so any regression shows.
    assert max(np.abs(C).max(), np.abs(S).max()) < 0.05


def dipole():
    """B_r(1) = cos(theta): the l = 1 PFSS solution is known in closed form."""
    q = RSS ** -3
    f = lambda r: (q + 2 * r ** -3) / (q + 2)          # B_r(r) / cos(theta)
    g = lambda r: (r * q - r ** -2) / (q + 2)          # potential factor
    return np.repeat(MU[:, None], NX, axis=1), f, g


def test_dipole_field(js):
    br, f, g = dipole()
    pts, want = [], []
    for r in (1.1, 1.5, 2.0, 2.4):
        for th in np.radians([20, 60, 100, 150]):
            ph = 1.3
            pts.append([r * np.sin(th) * np.cos(ph), r * np.sin(th) * np.sin(ph), r * np.cos(th)])
            want.append([np.cos(th) * f(r), -np.sin(th) * g(r) / r])
    B = np.array(js("field", map=br, points=pts))
    P = np.array(pts)
    r = np.linalg.norm(P, axis=1)
    rhat = P / r[:, None]
    th = np.arccos(P[:, 2] / r)
    thhat = np.stack([np.cos(th) * np.cos(1.3), np.cos(th) * np.sin(1.3), -np.sin(th)], 1)
    got = np.stack([(B * rhat).sum(1), (B * thhat).sum(1)], 1)
    err = np.linalg.norm(got - np.array(want), axis=1) / np.linalg.norm(want, axis=1)
    assert err.max() < 0.02, err


def test_dipole_field_lines(js):
    """The flux function r^2 f(r) sin^2(theta) is constant along a field line."""
    br, f, _ = dipole()
    seeds = [[1.05 * np.sin(t), 0, 1.05 * np.cos(t)] for t in np.radians([30, 50, 70])]
    for t in js("trace", map=br, seeds=seeds):
        p = np.array(t["pts"])
        r = np.linalg.norm(p, axis=1)
        psi = r ** 2 * f(r) * (p[:, 0] ** 2 + p[:, 1] ** 2) / r ** 2
        assert np.ptp(psi) / psi.mean() < 0.01


def test_dipole_open_flux_and_neutral_line(js):
    br, f, _ = dipole()
    res = js("solve", map=br)
    want = 2 * np.pi * (RSS * RSUN_CM) ** 2 * f(RSS)
    assert abs(res["open_flux_Mx"] / want - 1) < 0.01
    lat = np.concatenate([np.array(h)[1::2] for h in res["hcs"]])
    assert np.abs(lat).max() < 0.6                     # the current sheet lies on the equator


def test_wsa_formula_matches_python(js):
    import build_day
    pairs = [[f, d] for f in (1, 4, 10, 40, 200) for d in (0.2, 1, 3, 8)]
    got = js("wsa", pairs=pairs)
    assert np.allclose(got, [build_day.wsa_speed(f, d) for f, d in pairs], atol=1e-6)
