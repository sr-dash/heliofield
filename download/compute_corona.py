#!/usr/bin/env python3
"""Compute the 3D coronal magnetic field from a HelioField surface-map download.

This is the browser solver of HelioField (js/pfss.js) in NumPy, so it gives
the same results as the web page:

  PFSS   potential field between the photosphere (the downloaded input map
         br_input) and a spherical source surface R_ss: spherical harmonics
         up to degree lmax (80) with a Gaussian taper (l0 = 42, a smoothing
         of FWHM 3.8 deg that avoids ringing), evaluated on a grid uniform in
         ln r, theta, phi (36 x 90 x 180) and traced by RK4.
  SCS    with --scs ROUT, the Schatten current-sheet model beyond a cusp
         surface R_cp = 0.92 R_ss, out to ROUT: the potential field of
         |B_r(R_cp)| outside the sphere, blended from the outward-turned PFSS
         field across the shell R_cp..R_ss, each line taking the sign of
         B_r where it crossed the cusp surface.

It writes a result file in the format of a 3D download (NAME.nc and
NAME_header.json), which plot_3d.py and plot_surface.py read. The input is
either a surface-map download, or a date: the script then fetches the same
inputs the web page uses (the archived SDO/HMI rotation map covering the date
and the spacecraft positions) from the HelioField site, so no browser is
needed. --plot also draws the 3D view and the maps as PNG and PDF.

    python compute_corona.py --date 2014-03-12 --plot
    python compute_corona.py --date 2020-05-08 --scs 21.5 --plot --view earth
    python compute_corona.py SURFACE.nc --rss 2.0 --scs 21.5 --out my_run
    python plot_3d.py my_run.nc

It takes from a few seconds to about a minute. Needs numpy and scipy.
Method and validation: https://sr-dash.github.io/heliofield/guide.html#methods
"""
from __future__ import annotations

import heliofield_update                 # first: package-version notes, and an update if the script fails
heliofield_update.install()

import argparse
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.io import netcdf_file

from heliofield_io import SITE, body_keys, fetch_inputs, load

TAU, DEG = 2 * math.pi, math.pi / 180
RSUN_KM, RSUN_CM = 695700.0, 6.957e10
AU_RS = 149597870.7 / RSUN_KM
OMEGA = TAU / (25.38 * 86400)
VGRID = [200 + 25 * i for i in range(29)]
CUSP_FRAC = 0.92
LMAX, TAPER_L0 = 80, 42          # the browser's defaults (js/pfss.js)
FORMAT = "heliofield-export-2"
PREP_INPUT = ("SDO/HMI Carrington-rotation synoptic map (hmi.Synoptic_Mr_small, or hmi.Synoptic_Mr averaged), averaged in blocks "
              "to 180 x 360 (rows uniform in sine latitude), missing pixels set to 0, mean removed so the net flux is zero")


def fwhm_deg(L, l0):
    """Width of the smoothing kernel that the series and its taper amount to."""
    from scipy.special import eval_legendre
    g = np.radians(np.linspace(0, 40, 4001))
    l = np.arange(L + 1)
    w = np.exp(-l * (l + 1) / (2 * l0 * l0)) if l0 else np.ones(L + 1)
    K = np.einsum("l,lg->g", (2 * l + 1) * w, np.array([eval_legendre(k, np.cos(g)) for k in l]))
    return 2 * np.degrees(g[np.argmax(K < K[0] / 2)])


def prep_model(L, l0):
    taper_txt = f" with a Gaussian taper exp(-l(l+1)/(2*{l0}^2))" if l0 else ""
    return (f"br_input expanded in spherical harmonics up to degree {L}{taper_txt} and the monopole (l = 0) removed: "
            f"a smoothing with a kernel of FWHM {fwhm_deg(L, l0):.1f} degrees that also guarantees zero net flux. "
            "This is the boundary condition of the PFSS solution.")


def input_map(src):
    """The map to solve from: br_input (files saved since the format-2
    release), or br_phot in older files, where it was the input map."""
    return np.asarray(src["br_input"] if "br_input" in src else src["br_phot"], float)


def today():
    return datetime.now().strftime("%Y-%m-%d")


# ------------------------------------------------------------- harmonics
def alf(mu, L):
    """Fully normalised associated Legendre functions (4-pi norm, no
    Condon-Shortley phase) at mu = cos(theta): array [l, m, len(mu)]."""
    mu = np.atleast_1d(np.asarray(mu, float))
    s = np.sqrt(np.maximum(0, 1 - mu * mu))
    P = np.zeros((L + 1, L + 1, mu.size))
    P[0, 0] = 1
    for m in range(L + 1):
        if m > 0:
            P[m, m] = (math.sqrt(3) if m == 1 else math.sqrt((2 * m + 1) / (2 * m))) * s * P[m - 1, m - 1]
        if m + 1 <= L:
            P[m + 1, m] = math.sqrt(2 * m + 3) * mu * P[m, m]
        for l in range(m + 2, L + 1):
            a = math.sqrt((4 * l * l - 1) / (l * l - m * m))
            b = math.sqrt((((l - 1) ** 2 - m * m) * (2 * l + 1)) / ((l * l - m * m) * (2 * l - 3)))
            P[l, m] = a * mu * P[l - 1, m] - b * P[l - 2, m]
    return P


def analyse(br, L, mono=False):
    """Harmonic coefficients (C, S) of a map on rows uniform in sin(latitude),
    south first, columns at longitude (j + 0.5) 360/nx; monopole removed
    unless mono."""
    ny, nx = br.shape
    mu = -1 + (2 * np.arange(ny) + 1) / ny
    ph = (np.arange(nx) + 0.5) * TAU / nx
    m = np.arange(L + 1)
    cm, sm = br @ np.cos(np.outer(ph, m)), br @ np.sin(np.outer(ph, m))          # (ny, m)
    P = alf(mu, L)
    dO = (2 / ny) * (TAU / nx) / (4 * math.pi)
    C, S = np.einsum("lmi,im->lm", P, cm) * dO, np.einsum("lmi,im->lm", P, sm) * dO
    C[np.triu_indices(L + 1, 1)] = 0; S[np.triu_indices(L + 1, 1)] = 0
    if not mono:
        C[0], S[0] = 0, 0
    return dict(C=C, S=S, L=L, lmin=0 if mono else 1)


def taper(coef, l0=TAPER_L0):
    """Gaussian taper w_l = exp(-l(l+1) / (2 l0^2)) of the coefficients: the
    same as smoothing the map with a Gaussian kernel. Without it the sharp
    end of the series rings around strong active regions. l0 = 0: no taper."""
    if not l0:
        return dict(coef, taper=0)
    l = np.arange(coef["L"] + 1)
    w = np.exp(-l * (l + 1) / (2 * l0 * l0))[:, None]
    return dict(coef, C=coef["C"] * w, S=coef["S"] * w, taper=l0)


def pfss_radial(rss):
    def fn(l, r):
        q = rss ** -(2 * l + 1)
        D = l * q + (l + 1)
        return (l * r ** (l - 1) * q + (l + 1) * r ** -(l + 2)) / D, (r ** l * q - r ** -(l + 1)) / D
    return fn


def exterior(rcp):
    return lambda l, r: ((rcp / r) ** (l + 2), -rcp / (l + 1) * (rcp / r) ** (l + 1))


def field_grid(coef, r0, r1, radial_fn, nr=36, nth=90, nph=180):
    """The field on a grid uniform in ln r (r0..r1), theta (cell centres from
    the north pole) and phi (nodes): Cartesian components for tracing and
    spherical ones for output."""
    C, S, L, l0 = coef["C"], coef["S"], coef["L"], coef["lmin"]
    th = (np.arange(nth) + 0.5) * math.pi / nth
    ph = np.arange(nph) * TAU / nph
    P, eps = alf(np.cos(th), L), 1e-5
    dP = (alf(np.cos(th + eps), L) - alf(np.cos(th - eps), L)) / (2 * eps)
    m = np.arange(L + 1)
    cosm, sinm = np.cos(np.outer(m, ph)), np.sin(np.outer(m, ph))
    st, ct = np.sin(th)[:, None], np.cos(th)[:, None]
    cp, sp = np.cos(ph)[None, :], np.sin(ph)[None, :]
    radii = r0 * np.exp(np.log(r1 / r0) * np.arange(nr) / (nr - 1))
    Bs = np.zeros((nr, nth, nph, 3))
    for ir, r in enumerate(radii):
        f, g = np.zeros(L + 1), np.zeros(L + 1)
        for l in range(l0, L + 1):
            f[l], g[l] = radial_fn(l, r)
        rc, rs = np.einsum("lm,lmk,l->km", C, P, f), np.einsum("lm,lmk,l->km", S, P, f)
        tc, ts = np.einsum("lm,lmk,l->km", C, dP, g), np.einsum("lm,lmk,l->km", S, dP, g)
        pc, ps = np.einsum("lm,lmk,l->km", C, P, g) * m, np.einsum("lm,lmk,l->km", S, P, g) * m
        Bs[ir, ..., 0] = rc @ cosm + rs @ sinm
        Bs[ir, ..., 1] = (tc @ cosm + ts @ sinm) / r
        Bs[ir, ..., 2] = (-pc @ sinm + ps @ cosm) / (r * st)
    Br, Bt, Bp = Bs[..., 0], Bs[..., 1], Bs[..., 2]
    B = np.stack([Br * st * cp + Bt * ct * cp - Bp * sp, Br * st * sp + Bt * ct * sp + Bp * cp, Br * ct - Bt * st], -1)
    return dict(B=B, sph=Bs, nr=nr, nth=nth, nph=nph, r0=r0, r1=r1, rstop=r1, lnr0=math.log(r0),
                lnr=math.log(r1 / r0), radii=radii, near=None, inner="sun")


def field_at(coef, rss, p):
    """The PFSS field straight from the harmonic series (no grid) at points
    p (n, 3), Cartesian. Used for the photospheric field at footpoints."""
    C, S, L, l0 = coef["C"], coef["S"], coef["L"], coef["lmin"]
    p = np.atleast_2d(np.asarray(p, float))
    r = np.linalg.norm(p, axis=1)
    ct = np.clip(p[:, 2] / r, -1, 1)
    th, ph, eps = np.arccos(ct), np.arctan2(p[:, 1], p[:, 0]), 1e-5
    st = np.where(np.sin(th) == 0, 1e-12, np.sin(th))
    P, dP = alf(ct, L), (alf(np.cos(th + eps), L) - alf(np.cos(th - eps), L)) / (2 * eps)
    f, g = np.zeros((L + 1, len(r))), np.zeros((L + 1, len(r)))
    for l in range(l0, L + 1):
        f[l], g[l] = pfss_radial(rss)(l, r)
    m = np.arange(L + 1)[None, :, None]
    cm, sm = np.cos(m * ph), np.sin(m * ph)
    A = C[..., None] * cm + S[..., None] * sm
    D = m * (-C[..., None] * sm + S[..., None] * cm)
    Br = np.einsum("lmn,lmn,ln->n", A, P, f)
    Bt = np.einsum("lmn,lmn,ln->n", A, dP, g) / r
    Bp = np.einsum("lmn,lmn,ln->n", D, P, g) / (r * st)
    cp, sp = np.cos(ph), np.sin(ph)
    return np.stack([Br * st * cp + Bt * ct * cp - Bp * sp, Br * st * sp + Bt * ct * sp + Bp * cp, Br * ct - Bt * st], 1)


def sample(G, p):
    """Trilinear interpolation of the Cartesian field at points p (n, 3)."""
    p = np.asarray(p, float)
    r = np.linalg.norm(p, axis=-1)
    out = _sample1(G, p, r)
    if G["near"] is not None:
        m = r < G["near"]["r1"]
        if m.any():
            out[m] = _sample1(G["near"], p[m], r[m])
    return out


def _sample1(G, p, r):
    nr, nth, nph = G["nr"], G["nth"], G["nph"]
    fr = np.clip((np.log(r) - G["lnr0"]) / G["lnr"] * (nr - 1), 0, nr - 1.000001)
    ft = np.clip(np.arccos(np.clip(p[:, 2] / r, -1, 1)) / math.pi * nth - 0.5, 0, nth - 1.000001)
    fp = (np.arctan2(p[:, 1], p[:, 0]) / TAU) * nph
    fp = np.where(fp < 0, fp + nph, fp)
    i0, j0 = fr.astype(int), ft.astype(int)
    k0 = np.floor(fp).astype(int) % nph
    k1 = (k0 + 1) % nph
    a, b, c = fr - i0, ft - j0, fp - np.floor(fp)
    B = G["B"]
    out = np.zeros_like(p)
    for di in (0, 1):
        for dj in (0, 1):
            for dk in (0, 1):
                w = (a if di else 1 - a) * (b if dj else 1 - b) * (c if dk else 1 - c)
                out += w[:, None] * B[i0 + di, j0 + dj, k1 if dk else k0]
    return out


def trace_dir(G, p0, sign, max_steps=4000):
    """Field lines from many seeds in one direction, by RK4 along the unit
    field, until they leave r0 <= r <= rstop. Returns the polylines and
    the boundary each one ended on ('sun'/'cp' inner, 'ss' outer, 'none')."""
    p = np.array(p0, float).reshape(-1, 3)
    n = len(p)
    rin, rout, inner = G["r0"], G["rstop"], G["inner"]
    hist = [p.copy()]
    alive = np.ones(n, bool)
    last = np.full(n, max_steps, int)
    ends = np.array(["none"] * n, dtype=object)
    clip = {}

    def unit(q):
        v = sample(G, q)
        return sign * v / (np.linalg.norm(v, axis=1, keepdims=True) + (np.linalg.norm(v, axis=1, keepdims=True) == 0))

    for s in range(max_steps):
        idx = np.where(alive)[0]
        if not len(idx):
            break
        q = p[idx]
        r = np.linalg.norm(q, axis=1)
        h = (0.012 * r)[:, None]
        k1 = unit(q); k2 = unit(q + 0.5 * h * k1); k3 = unit(q + 0.5 * h * k2); k4 = unit(q + h * k3)
        nxt = q + h / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
        rn = np.linalg.norm(nxt, axis=1)
        out = (rn <= rin) | (rn >= rout)
        for j in np.where(out)[0]:
            i = idx[j]
            bound = rin if rn[j] <= rin else rout
            t = min(1, max(0, (bound - r[j]) / ((rn[j] - r[j]) or 1e-9)))
            clip[i] = q[j] + t * (nxt[j] - q[j])
            ends[i] = inner if rn[j] <= rin else "ss"
            last[i] = s
            alive[i] = False
        keep = idx[~out]
        p[keep] = nxt[~out]
        step = np.full((n, 3), np.nan)
        step[keep] = p[keep]
        hist.append(step)
    H = np.stack(hist)
    lines = []
    for i in range(n):
        pts = H[: last[i] + 1, i] if ends[i] != "none" else H[:, i]
        pts = pts[np.isfinite(pts[:, 0])]
        if i in clip:
            pts = np.vstack([pts, clip[i]])
        lines.append(pts)
    return lines, list(ends)


def trace(G, seeds):
    f, ef = trace_dir(G, seeds, 1)
    b, eb = trace_dir(G, seeds, -1)
    return [np.vstack([bb[1:][::-1], ff]) for ff, bb in zip(f, b)], list(zip(eb, ef))


def resample(pts, step=0.02, nmax=160):
    if len(pts) < 3:
        return pts
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    n = max(6, min(nmax, int(s[-1] // step)))
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, pts[:, c]) for c in range(3)], 1)


def resample_log(pts, frac=0.015, nmax=180):
    if len(pts) < 3:
        return pts
    r = np.linalg.norm(pts, axis=1)
    s = np.concatenate([[0], np.cumsum(2 * np.linalg.norm(np.diff(pts, axis=0), axis=1) / (r[1:] + r[:-1]))])
    n = max(6, min(nmax, math.ceil(s[-1] / frac) + 1))
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, pts[:, c]) for c in range(3)], 1)


def cart(r, lon, lat):
    lon, lat = np.radians(lon), np.radians(lat)
    return np.stack(np.broadcast_arrays(r * np.cos(lat) * np.cos(lon), r * np.cos(lat) * np.sin(lon), r * np.sin(lat)), -1)


# ------------------------------------------------------------- seeds
def mulberry32(seed):
    state = [seed & 0xFFFFFFFF]

    def imul(a, b):
        return (a * b) & 0xFFFFFFFF

    def rand():
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        s = state[0]
        t = imul(s ^ (s >> 15), 1 | s)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rand


def seeds(br, r_top, nU=260, nF=220, nO=260):
    """The browser's seed pattern: equal-area and |B|^1.5-weighted points at
    1.05 R_sun, and an equal-area set just inside the model's top."""
    ny, nx = br.shape
    golden = math.pi * (1 + math.sqrt(5))
    out = [cart(1.05, (golden * (k + 0.5) / DEG) % 360, math.asin(1 - 2 * (k + 0.5) / nU) / DEG) for k in range(nU)]
    w = np.abs(br.ravel()) ** 1.5
    tot, rand, taken, k = w.sum(), mulberry32(1), set(), 0
    while k < nF and tot > 0:
        u = rand() * tot
        cs = np.cumsum(w)
        i = min(int(np.searchsorted(cs, u, side="left")), len(w) - 1)
        if i in taken:
            if len(taken) >= w.size:
                break
            continue
        taken.add(i); tot -= w[i]; w[i] = 0; k += 1
        iy, ix = divmod(i, nx)
        out.append(cart(1.05, (ix + 0.5) * 360 / nx, math.asin(-1 + (2 * iy + 1) / ny) / DEG))
    out += [cart(r_top * 0.98, ((golden * (k + 0.5) / DEG) + 7) % 360, math.asin(1 - 2 * (k + 0.5) / nO) / DEG) for k in range(nO)]
    return np.array(out)


def line_order(n, seed=7):
    """The viewer's fixed shuffle: its first N lines are the ones drawn."""
    idx = list(range(n))
    for i in range(n - 1, 0, -1):
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        j = int(seed / 4294967296 * (i + 1))
        idx[i], idx[j] = idx[j], idx[i]
    return idx


# ------------------------------------------------------------- surfaces
def surface_br(coef, r, rss, nlat=180, nlon=360, sinlat=False):
    C, S, L = coef["C"], coef["S"], coef["L"]
    f = np.array([0.0] + [pfss_radial(rss)(l, r)[0] for l in range(1, L + 1)])
    mu = -1 + (2 * np.arange(nlat) + 1) / nlat if sinlat else np.sin(np.radians(-90 + (np.arange(nlat) + 0.5) * 180 / nlat))
    P = alf(mu, L)
    am, bm = np.einsum("lm,lmi,l->im", C, P, f), np.einsum("lm,lmi,l->im", S, P, f)
    ph = (np.arange(nlon) + 0.5) * TAU / nlon
    m = np.arange(L + 1)
    return am @ np.cos(np.outer(m, ph)) + bm @ np.sin(np.outer(m, ph))


def zero_contour(F):
    """The browser's neutral-line contouring of an equirectangular field
    (south-first rows, longitude periodic): polylines as (n, 2) lon, lat."""
    nlat, nlon = F.shape
    lon = lambda j: (j + 0.5) * 360 / nlon
    lat = lambda i: -90 + (i + 0.5) * 180 / nlat
    val = lambda i, j: F[i, j % nlon]

    def cross(i0, j0, i1, j1):
        a, b = val(i0, j0), val(i1, j1)
        t = a / (a - b)
        return (lon(j0) + t * (lon(j1) - lon(j0)), lat(i0) + t * (lat(i1) - lat(i0)))
    segs = []
    for i in range(nlat - 1):
        for j in range(nlon):
            v = [val(i, j) > 0, val(i, j + 1) > 0, val(i + 1, j + 1) > 0, val(i + 1, j) > 0]
            e = []
            if v[0] != v[1]: e.append(cross(i, j, i, j + 1))
            if v[1] != v[2]: e.append(cross(i, j + 1, i + 1, j + 1))
            if v[2] != v[3]: e.append(cross(i + 1, j + 1, i + 1, j))
            if v[3] != v[0]: e.append(cross(i + 1, j, i, j))
            if len(e) == 2: segs.append(e)
            elif len(e) == 4: segs += [[e[0], e[1]], [e[2], e[3]]]
    key = lambda p: (round(round(p[0] * 1e4) / 1e4 % 360, 4), round(round(p[1] * 1e4) / 1e4, 4))
    ends = {}
    for k, s in enumerate(segs):
        for p in s:
            ends.setdefault(key(p), []).append(k)
    used, lines = [False] * len(segs), []
    for k0 in range(len(segs)):
        if used[k0]:
            continue
        used[k0] = True
        line = [segs[k0][0], segs[k0][1]]
        for fwd in (True, False):
            while True:
                tip = line[-1] if fwd else line[0]
                nxt = next((k for k in ends.get(key(tip), []) if not used[k]), None)
                if nxt is None:
                    break
                used[nxt] = True
                s = segs[nxt]
                other = s[1] if key(s[0]) == key(tip) else s[0]
                line.append(other) if fwd else line.insert(0, other)
        if len(line) > 2:
            lines.append(np.array([[round(p[0] % 360, 2), round(p[1], 2)] for p in line]))
    return lines


def open_map(G, step=1.0):
    """Open (+1 outward / -1 inward) or closed (0) from just above the
    photosphere, traced outward by RK2 on a 1-degree grid, and the
    coronal-hole boundary points (unit vectors)."""
    nlat, nlon = int(180 / step), int(360 / step)
    la, lo = np.meshgrid(-90 + (np.arange(nlat) + 0.5) * step, (np.arange(nlon) + 0.5) * step, indexing="ij")
    p = cart(1.001, lo.ravel(), la.ravel())
    v = sample(G, p)
    s = np.where((v * p).sum(1) >= 0, 1.0, -1.0)
    pol = np.zeros(len(p), np.int8)
    alive = np.ones(len(p), bool)
    rtop = G["rstop"]
    for _ in range(3000):
        idx = np.where(alive)[0]
        if not len(idx):
            break
        q, sg = p[idx], s[idx][:, None]
        h = (0.012 * np.linalg.norm(q, axis=1))[:, None]
        b = sample(G, q); b /= np.linalg.norm(b, axis=1, keepdims=True) + 1e-30
        mid = q + 0.5 * h * sg * b
        b = sample(G, mid); b /= np.linalg.norm(b, axis=1, keepdims=True) + 1e-30
        q = q + h * sg * b
        p[idx] = q
        r = np.linalg.norm(q, axis=1)
        up, down = r >= rtop, r < 1
        pol[idx[up]] = s[idx[up]].astype(np.int8)
        alive[idx[up | down]] = False
    pol = pol.reshape(nlat, nlon)
    op = pol != 0
    pts = []
    for i in range(nlat):
        for j in range(nlon):
            lon, lat = (j + 0.5) * step, -90 + (i + 0.5) * step
            if op[i, j] != op[i, (j + 1) % nlon]: pts.append(cart(1, lon + step / 2, lat))
            if i + 1 < nlat and op[i, j] != op[i + 1, j]: pts.append(cart(1, lon, lat + step / 2))
    return pol, np.array(pts).reshape(-1, 3)


def wsa_speed(fs, dchb):
    return 285 + 625 / (1 + fs) ** (2 / 9) * (1 - 0.8 * np.exp(-(dchb / 2) ** 2)) ** 3


# ------------------------------------------------------------- SCS
def scs_grid(coef, rss, rcp, rout, nr=40, nr_shell=14):
    absb = np.abs(surface_br(coef, rcp, rss, 180, 360, sinlat=True))
    a = taper(analyse(absb, coef["L"], mono=True), coef.get("taper", 0))
    S = field_grid(a, rss, rout, exterior(rcp), nr=nr)
    sh = field_grid(a, rcp, rss, exterior(rcp), nr=nr_shell)
    P = field_grid(coef, rcp, rss, pfss_radial(rss), nr=nr_shell)
    t = np.arange(nr_shell) / (nr_shell - 1)
    w = (t * t * (3 - 2 * t))[:, None, None, None]
    sg = np.where(P["sph"][..., 0:1] >= 0, 1.0, -1.0)
    sh["B"] = (1 - w) * sg * P["B"] + w * sh["B"]
    # spherical components of the blend, for output
    sh["sph"] = (1 - w) * sg * P["sph"] + w * sh["sph"]
    S["near"], S["r0"], S["inner"] = sh, rcp, "cp"
    sh["inner"] = "cp"
    return S


def cusp_sign(G, p):
    v = sample(G, p)
    return np.where((v * p).sum(1) >= 0, 1, -1)


# ------------------------------------------------------------- solve
def solve(br, rss=2.5, rout=0.0, L=LMAX, taper_l0=TAPER_L0, fleet=None, v_draw=400.0, log=print):
    t0 = time.time()
    coef = taper(analyse(br, L), taper_l0)
    G = field_grid(coef, 1.0, rss, pfss_radial(rss))
    rcp = round(CUSP_FRAC * rss, 3) if rout else None
    r_in = rcp or rss
    S = None
    if rout:
        G["rstop"] = rcp
        S = scs_grid(coef, rss, rcp, rout)
    log(f"field solved ({time.time() - t0:.1f} s)")

    sd = seeds(br, r_in)
    lines_raw, ends = trace(G, sd)
    keep = [i for i, (l, e) in enumerate(zip(lines_raw, ends)) if len(l) >= 3 and "sun" in e]
    lines, kinds, opens = [], [], []
    for i in keep:
        pts, e = lines_raw[i], ends[i]
        if e[0] != "sun":
            pts = pts[::-1]
        opens.append("ss" in e)
        bf = sample(G, pts[:1])[0]
        kinds.append((1 if (bf @ pts[0]) > 0 else -1) if opens[-1] else 0)
        lines.append(pts)
    if S is not None:
        idx = [k for k, o in enumerate(opens) if o]
        starts = np.array([lines[k][-1] * (S["r0"] * 1.0005) / np.linalg.norm(lines[k][-1]) for k in idx]).reshape(-1, 3)
        outs, oe = trace_dir(S, starts, 1, 6000) if len(idx) else ([], [])
        for k, o, e in zip(idx, outs, oe):
            lines[k] = np.vstack([resample(lines[k]), resample_log(o)[1:]]) if e == "ss" else resample(lines[k])
        for k in range(len(lines)):
            if k not in set(idx):
                lines[k] = resample(lines[k])
    else:
        lines = [resample(p) for p in lines]
    log(f"{len(lines)} field lines ({time.time() - t0:.1f} s)")

    ss_eq = surface_br(coef, r_in, rss)
    w = np.cos(np.radians(-90 + np.arange(180) + 0.5))[:, None] * DEG * DEG * (r_in * RSUN_CM) ** 2
    flux = float((np.abs(ss_eq) * w).sum())
    nl = zero_contour(ss_eq)
    pol, bound = open_map(G)
    log(f"open/closed map ({time.time() - t0:.1f} s)")

    res = dict(coef=coef, G=G, S=S, rss=rss, rcp=rcp, rout=rout or None, r_in=r_in, lines=lines, kinds=np.array(kinds, np.int8),
               flux=flux, nl=nl, pol=pol, L=L, taper=taper_l0)
    if S is not None:
        res["ribs"], res["hcs_out"] = hcs_ribs(S, nl, rcp, rout)
        lat_g = 90 - (np.arange(S["nth"]) + 0.5) * 180 / S["nth"]
        LA, LO = np.meshgrid(lat_g[::-1], np.arange(S["nph"]) * 360 / S["nph"], indexing="ij")
        pl, pe = trace_dir(S, cart(rout * 0.98, LO.ravel(), LA.ravel()), -1, 6000)
        endp = np.array([l[-1] for l in pl])
        res["polarity_out"] = np.where(np.array(pe) == "cp", cusp_sign(G, endp), 0).reshape(LA.shape).astype(np.int8)
        log(f"current sheet and polarity at the outer edge ({time.time() - t0:.1f} s)")
    if fleet:
        res["connect"], res["clines"] = connect(res, fleet, bound, v_draw)
        log(f"spacecraft connections ({time.time() - t0:.1f} s)")
    return res


def hcs_ribs(S, nl, rcp, rout, n_rib=24):
    radii = rcp * (rout / rcp) ** (np.arange(n_rib) / (n_rib - 1))
    starts, owner = [], []
    for li, h in enumerate(nl):
        step = max(1, len(h) // 220)
        for i in range(0, len(h), step):
            starts.append(cart(rcp * 1.001, h[i, 0], h[i, 1])); owner.append(li)
    if not starts:
        return [], []
    pls, ends = trace_dir(S, np.array(starts), 1, 6000)
    ribs, out = {}, {}
    for pts, e, li in zip(pls, ends, owner):
        if e != "ss":
            continue
        r = np.linalg.norm(pts, axis=1)
        q = np.stack([np.interp(radii, r, pts[:, c]) for c in range(3)], 1)
        rr = np.linalg.norm(q, axis=1)
        rib = np.stack([np.degrees(np.arctan2(q[:, 1], q[:, 0])) % 360, np.degrees(np.arcsin(q[:, 2] / rr)), radii], 1)
        ribs.setdefault(li, []).append(rib)
    ribs = [np.array(v) for v in ribs.values() if len(v) >= 2]
    out = [r[:, -1, :2] for r in ribs]
    return ribs, out


def connect(res, fleet, bound, v_draw):
    """Each spacecraft joined to the model's top along a Parker spiral at every
    speed of the 200-900 km/s grid, then traced down to the photosphere."""
    G, S, rss, rcp, rout = res["G"], res["S"], res["rss"], res["rcp"], res["rout"]
    r_edge = rout or rss
    jobs = [(k, v) for k, b in fleet.items() if not b["planet"] and np.isfinite(b["lon"]) for v in VGRID]
    if not jobs:
        return [], []
    # A spacecraft inside the SCS domain needs no spiral: its line starts where it is.
    r_sc = np.array([fleet[k]["r"] * AU_RS for k, _ in jobs])
    inside = (S is not None) & (r_sc < r_edge) & (r_sc > (rcp or 0) * 1.01)
    lon = np.array([(fleet[k]["lon"] + (0 if ins else np.degrees(OMEGA * (r - r_edge) * RSUN_KM / v))) % 360
                    for (k, v), r, ins in zip(jobs, r_sc, inside)])
    lat = np.array([np.clip(fleet[k]["lat"], -89, 89) for k, _ in jobs])
    pts_all, ok, top, r_top = [], [], cart(rss, lon, lat), np.full(len(jobs), rss)
    if S is not None:
        sl, se = trace_dir(S, cart(np.where(inside, r_sc, r_edge * 0.995), lon, lat), -1, 6000)
        cusp = np.array([l[-1] for l in sl])
        down, de = trace(G, cusp * (rcp * 0.995) / np.linalg.norm(cusp, axis=1, keepdims=True))
        for j in range(len(jobs)):
            low = down[j]
            if np.linalg.norm(low[0]) > np.linalg.norm(low[-1]):
                low = low[::-1]
            good = se[j] == "cp" and "sun" in de[j]
            pts_all.append(np.vstack([low, sl[j][::-1]]) if se[j] == "cp" else sl[j][::-1])
            ok.append(good)
        top, r_top = cusp, np.full(len(jobs), rcp)
    else:
        down, de = trace(G, cart(rss * 0.995, lon, lat))
        for j in range(len(jobs)):
            p = down[j]
            pts_all.append(p[::-1] if np.linalg.norm(p[0]) > np.linalg.norm(p[-1]) else p)
            ok.append("sun" in de[j])
    rows, clines = [], []
    for j, (k, v) in enumerate(jobs):
        row = dict(body=k, v=v, top=(lon[j], lat[j]), foot=None, fs=np.nan, dchb=np.nan, vwsa=np.nan)
        if ok[j]:
            f = pts_all[j][0]
            flon, flat = np.degrees(np.arctan2(f[1], f[0])) % 360, np.degrees(np.arcsin(f[2] / np.linalg.norm(f)))
            # |B| at the footpoint from the series itself, as the browser does
            fs = np.linalg.norm(field_at(res["coef"], rss, cart(1, flon, flat)[None])[0]) / np.linalg.norm(sample(G, np.asarray(top[j])[None])[0]) / r_top[j] ** 2
            d = np.degrees(np.arccos(np.clip((bound * cart(1, flon, flat)).sum(1).max(), -1, 1))) if len(bound) else np.nan
            row.update(foot=(flon, flat), fs=fs, dchb=d, vwsa=wsa_speed(fs, d))
        rows.append(row)
        if np.isclose(v, v_draw) and len(pts_all[j]) > 2:
            clines.append((k, v, resample_log(pts_all[j], 0.02, 220) if S is not None else resample(pts_all[j], 0.03, 80)))
    return rows, clines


# ------------------------------------------------------------- output
def spherical_out(levels_sph):
    """(nr, nth, nph, 3) from the north to (nr, lat south first, nph) arrays."""
    a = levels_sph[:, ::-1]
    return a[..., 0], a[..., 1], a[..., 2]


def write(out, src, sol, args, view):
    keys = body_keys(src)
    scs = sol["S"] is not None
    G = sol["G"]
    nc = netcdf_file(f"{out}.nc", "w", version=1)
    V = {}

    def var(name, dims, data, dtype="f", **attrs):
        for d, n in zip(dims, np.shape(data)):
            if d not in nc.dimensions:
                nc.createDimension(d, n)
        v = nc.createVariable(name, dtype, dims)
        v[:] = data
        for k, x in attrs.items():
            if x is not None:
                setattr(v, k, x)
        V[name] = dict(dims=list(dims), type={"f": "float", "b": "byte", "i": "int", "c": "char"}[dtype], **{k: x for k, x in attrs.items() if x is not None})

    var("lat", ("lat",), src["lat"], units="degrees_north", long_name="Carrington latitude of the map rows (uniform in sine latitude, south first)")
    var("lon", ("lon",), src["lon"], units="degrees_east", long_name="Carrington longitude of the map columns")
    var("br_input", ("lat", "lon"), input_map(src), units="G", long_name="Input map: the archived magnetogram before the harmonic expansion",
        preprocessing=PREP_INPUT)
    var("br_phot", ("lat", "lon"), surface_br(sol["coef"], 1.0, sol["rss"], *src["br_phot"].shape, sinlat=True), units="G",
        long_name="Photospheric radial field as used by the model (its boundary condition)", preprocessing=prep_model(sol["L"], sol["taper"]))
    var("br_ss", ("lat", "lon"), surface_br(sol["coef"], sol["rss"], sol["rss"], *src["br_phot"].shape, sinlat=True), units="G",
        long_name="PFSS radial field on the source surface", radius_rsun=sol["rss"])
    if scs:
        var("br_cusp", ("lat", "lon"), surface_br(sol["coef"], sol["rcp"], sol["rss"], *src["br_phot"].shape, sinlat=True), units="G",
            long_name="PFSS radial field on the cusp surface, the inner boundary of the SCS model", radius_rsun=sol["rcp"])
    var("lat1", ("lat1",), -89.5 + np.arange(180), units="degrees_north", long_name="Latitude of the 1-degree open/closed map")
    var("lon1", ("lon1",), 0.5 + np.arange(360), units="degrees_east", long_name="Longitude of the 1-degree open/closed map")
    var("open_class", ("lat1", "lon1"), sol["pol"], "b", long_name="Field line from just above the photosphere: 0 closed, 1 open outward, -1 open inward",
        open_means="reaches the cusp surface" if scs else "reaches the source surface")

    def nl(polys, prefix, radius, what):
        pts = np.vstack(polys) if polys else np.full((1, 2), np.nan)
        idx = np.concatenate([np.full(len(p), i) for i, p in enumerate(polys)]) if polys else np.array([-1])
        var(f"{prefix}_lon", (f"{prefix}_pt",), pts[:, 0], units="degrees_east", long_name=f"{what}: longitude", radius_rsun=radius)
        var(f"{prefix}_lat", (f"{prefix}_pt",), pts[:, 1], units="degrees_north", long_name=f"{what}: latitude")
        var(f"{prefix}_line", (f"{prefix}_pt",), idx.astype(np.int32), "i", long_name=f"{what}: index of the polyline each point belongs to")
    nl(sol["nl"], "nl", sol["r_in"], "Neutral line on the cusp surface" if scs else "Neutral line on the source surface")

    if keys:
        var("body_key", ("body", "name_len"), src["body_key"], "c", long_name="Short key of each body (psp, solo, earth, ...)")
        if "body_name" in src:
            var("body_name", ("body", "long_name_len"), src["body_name"], "c", long_name="Name of each body")
        for name in ("body_lon", "body_lat", "body_r"):
            var(name, ("body",), src[name], units=src.var_attrs[name].get("units"), long_name=src.var_attrs[name].get("long_name"))
        var("body_planet", ("body",), src["body_planet"], "b", long_name="1 for a planet, 0 for a spacecraft")
    rows = sol.get("connect") or []
    if rows:
        col = lambda f: np.array([f(r) for r in rows], float)
        var("conn_body", ("conn",), np.array([keys.index(r["body"]) for r in rows], np.int32), "i", long_name="Index into the body dimension")
        var("conn_v", ("conn",), col(lambda r: r["v"]), units="km s-1", long_name="Solar-wind speed of the ballistic Parker-spiral mapping")
        var("conn_top_lon", ("conn",), col(lambda r: r["top"][0]), units="degrees_east", long_name="Where the spiral meets the model's outer boundary: longitude",
            radius_rsun=sol["rout"] or sol["rss"])
        var("conn_top_lat", ("conn",), col(lambda r: r["top"][1]), units="degrees_north", long_name="Where the spiral meets the model's outer boundary: latitude")
        var("foot_lon", ("conn",), col(lambda r: r["foot"][0] if r["foot"] else np.nan), units="degrees_east", long_name="Photospheric footpoint longitude (NaN: line does not reach the photosphere)")
        var("foot_lat", ("conn",), col(lambda r: r["foot"][1] if r["foot"] else np.nan), units="degrees_north", long_name="Photospheric footpoint latitude")
        var("foot_fs", ("conn",), col(lambda r: r["fs"]), units="1", long_name=f"Expansion factor between the photosphere and the {'cusp' if scs else 'source'} surface")
        var("foot_dchb", ("conn",), col(lambda r: r["dchb"]), units="degree", long_name="Angular distance from the footpoint to the nearest coronal-hole boundary")
        var("foot_vwsa", ("conn",), col(lambda r: r["vwsa"]), units="km s-1", long_name="WSA-type speed estimate from f_s and DCHB (illustrative coefficients)")

    var("r", ("r",), G["radii"], units="R_sun", long_name="Radius of the PFSS grid (uniform in ln r)")
    var("lat_g", ("lat_g",), (90 - (np.arange(G["nth"]) + 0.5) * 180 / G["nth"])[::-1], units="degrees_north", long_name="Latitude of the 3D grid (cell centres, south first)")
    var("lon_g", ("lon_g",), np.arange(G["nph"]) * 360 / G["nph"], units="degrees_east", long_name="Longitude of the 3D grid (nodes)")
    br, bt, bp = spherical_out(G["sph"])
    d3 = ("r", "lat_g", "lon_g")
    var("br", d3, br, units="G", long_name="PFSS B_r")
    var("btheta", d3, bt, units="G", long_name="PFSS B_theta (positive southward)")
    var("bphi", d3, bp, units="G", long_name="PFSS B_phi (positive eastward, in the direction of rotation)")
    lines = sol["lines"]
    order = line_order(len(lines))[: view.get("nLines", 250)]
    drawn = np.zeros(len(lines), np.int8); drawn[order] = 1
    counts = np.array([len(p) for p in lines], np.int32)
    pts = np.vstack(lines)
    var("line_start", ("line",), np.concatenate([[0], np.cumsum(counts)[:-1]]).astype(np.int32), "i", long_name="Index of the line's first point in line_pt")
    var("line_count", ("line",), counts, "i", long_name="Number of points in the line")
    var("line_kind", ("line",), sol["kinds"], "b", long_name="0 closed, 1 open outward, -1 open inward")
    var("line_drawn", ("line",), drawn, "b", long_name="1 if the viewer would draw this line (its fixed subset)")
    for c, a in enumerate("xyz"):
        var(f"line_{a}", ("line_pt",), pts[:, c], units="R_sun", long_name=f"Field-line points, Carrington Cartesian {a}, true distance")
    cl = sol.get("clines") or []
    if cl:
        cc = np.array([len(p) for _, _, p in cl], np.int32)
        cp = np.vstack([p for _, _, p in cl])
        var("cline_body", ("cline",), np.array([keys.index(k) for k, _, _ in cl], np.int32), "i", long_name="Index into the body dimension")
        var("cline_v", ("cline",), np.array([v for _, v, _ in cl], float), units="km s-1", long_name="Wind speed of the drawn connection")
        var("cline_start", ("cline",), np.concatenate([[0], np.cumsum(cc)[:-1]]).astype(np.int32), "i")
        var("cline_count", ("cline",), cc, "i")
        for c, a in enumerate("xyz"):
            var(f"cline_{a}", ("cline_pt",), cp[:, c], units="R_sun", long_name=f"Connection field line (outer boundary to photosphere), Cartesian {a}")

    if scs:
        S, sh = sol["S"], sol["S"]["near"]
        r_scs = np.concatenate([sh["radii"], S["radii"][1:]])
        sph = np.concatenate([sh["sph"], S["sph"][1:]])
        var("r_scs", ("r_scs",), r_scs, units="R_sun", long_name="Radius of the SCS grid: the transition shell (cusp to source surface), then the SCS region")
        b1, b2, b3 = spherical_out(sph)
        d3 = ("r_scs", "lat_g", "lon_g")
        var("br_scs", d3, b1, units="G", long_name="SCS B_r (unsigned)", comment="Unsigned SCS field: it points outward everywhere. A line's sign is the sign of PFSS B_r where it crosses the cusp surface (see polarity_out).")
        var("btheta_scs", d3, b2, units="G", long_name="SCS B_theta (unsigned frame)")
        var("bphi_scs", d3, b3, units="G", long_name="SCS B_phi (unsigned frame)")
        var("polarity_out", ("lat_g", "lon_g"), sol["polarity_out"], "b", long_name="Sign of the coupled field near the outer edge (1 outward, -1 inward, 0 unresolved)", radius_rsun=sol["rout"] * 0.98)
        nl([h for h in sol["hcs_out"]], "hcs_out", sol["rout"], "Current sheet at the outer edge (traced from the cusp-surface neutral line)")
        if sol["ribs"]:
            ribs = np.concatenate(sol["ribs"])
            var("rib_line", ("rib",), np.concatenate([np.full(len(r), i) for i, r in enumerate(sol["ribs"])]).astype(np.int32), "i", long_name="Neutral-line polyline the rib starts from")
            for c, (nm, u) in enumerate([("lon", "degrees_east"), ("lat", "degrees_north"), ("r", "R_sun")]):
                var(f"rib_{nm}", ("rib", "rib_level"), ribs[..., c], units=u, long_name=f"Current-sheet ribs (field lines traced out from the cusp-surface neutral line): {nm}")

    model = (f"PFSS + Schatten current sheet (cusp {sol['rcp']} R_sun, outer edge {sol['rout']} R_sun)" if scs
             else f"PFSS (source surface {sol['rss']} R_sun)")
    a = src.attrs
    attrs = dict(title=a.get("title"), format=FORMAT, product="scs" if scs else "pfss", source=a.get("source"), source_file=a.get("source_file"),
                 source_url=a.get("source_url"), date=a.get("date"), obstime=a.get("obstime"), carrington_rotation=a.get("carrington_rotation"),
                 L0_deg=a.get("L0_deg"), B0_deg=a.get("B0_deg"), model=model, rss_rsun=sol["rss"], rcp_rsun=sol["rcp"], rout_rsun=sol["rout"],
                 lmax=sol["L"], taper_l0=sol["taper"], saved_date=a.get("saved_date"), computed_date=today(),
                 preprocessing=f"{PREP_INPUT}. {prep_model(sol['L'], sol['taper'])}", frame=a.get("frame"), length_unit=a.get("length_unit"), open_flux_Mx=sol["flux"],
                 software="HelioField compute_corona.py (NumPy port of js/pfss.js)", references=a.get("references"),
                 history=f"Computed {datetime.now(timezone.utc).isoformat(timespec='seconds')} from {Path(args.file).name}")
    for k, x in attrs.items():
        if x is not None:
            setattr(nc, k, x)
    dims = {k: int(v) for k, v in nc.dimensions.items()}
    nc.close()
    header = dict(format=FORMAT, product=attrs["product"], title=attrs["title"], created=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  software=attrs["software"], citation=src.header.get("citation"), date=a.get("date"), obstime=a.get("obstime"),
                  saved_date=a.get("saved_date"), computed_date=today(),
                  preprocessing=dict(br_input=PREP_INPUT, br_phot=prep_model(sol["L"], sol["taper"])),
                  source=src.header.get("source"),
                  model=dict(name="PFSS + SCS" if scs else "PFSS", rss_rsun=sol["rss"], rcp_rsun=sol["rcp"], rout_rsun=sol["rout"], lmax=sol["L"],
                             grid=dict(pfss=[G["nr"], G["nth"], G["nph"]], scs=[len(r_scs), G["nth"], G["nph"]] if scs else None),
                             cusp_fraction=CUSP_FRAC if scs else None,
                             transition_shell="PFSS (turned outward) blended into SCS from the cusp surface to the source surface (smoothstep in r)" if scs else None),
                  frame=a.get("frame"), length_unit=a.get("length_unit"), earth=src.header.get("earth"), open_flux_Mx=sol["flux"],
                  view=view, dimensions=dims, variables=V)
    Path(f"{out}_header.json").write_text(json.dumps(header, indent=1, default=float))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="HelioField result file with surface maps (.nc); or use --date")
    ap.add_argument("--date", help="YYYY-MM-DD (since 2010-05-01): fetch the inputs for this date from the HelioField site")
    ap.add_argument("--site", default=SITE, help=argparse.SUPPRESS)
    ap.add_argument("--plot", action="store_true", help="also draw the 3D view and the surface maps (PNG and PDF)")
    ap.add_argument("--view", default=None, choices=["home", "earth", "north", "fleet"],
                    help="camera for --plot (default: the saved view, or 'home' as the page opens)")
    ap.add_argument("--theme", choices=["light", "dark"], help="colours for --plot")
    ap.add_argument("--rss", type=float, help="source-surface radius [R_sun] (default: that of the file)")
    ap.add_argument("--scs", type=float, default=None, help="couple the SCS model out to this radius [R_sun], e.g. 21.5 (default: as in the file)")
    ap.add_argument("--pfss", action="store_true", help="PFSS only, even if the file used SCS")
    ap.add_argument("--lmax", type=int, default=LMAX, help=f"highest harmonic degree (default {LMAX}, as in the browser)")
    ap.add_argument("--taper", type=float, default=TAPER_L0,
                    help=f"Gaussian taper scale l0 of the harmonic series (default {TAPER_L0}, as in the browser; 0 for a sharp cut)")
    ap.add_argument("--v", type=float, help="wind speed of the connection lines drawn [km/s] (default: that of the saved view)")
    ap.add_argument("--out", help="output name without extension (default: <file>_<model>)")
    a = ap.parse_args(argv)

    if not a.file and not a.date:
        ap.error("give a surface-map file or --date YYYY-MM-DD")
    src = fetch_inputs(a.date, a.site) if a.date else load(a.file)
    attrs = src.attrs
    rss = a.rss or float(attrs.get("rss_rsun", 2.5))
    rout = 0.0 if a.pfss else (a.scs if a.scs is not None else float(attrs.get("rout_rsun", 0) or 0))
    view = dict(src.header.get("view") or {})
    v = a.v or view.get("vsw", 400.0)
    view["vsw"] = v
    keys = body_keys(src)
    fleet = {k: dict(lon=float(src["body_lon"][i]), lat=float(src["body_lat"][i]), r=float(src["body_r"][i]), planet=bool(src["body_planet"][i]))
             for i, k in enumerate(keys)}
    print(f"{attrs.get('date', '')}: {'PFSS + SCS to ' + format(rout, 'g') if rout else 'PFSS'}, R_ss {rss:g}, lmax {a.lmax}")
    sol = solve(input_map(src), rss=rss, rout=rout, L=a.lmax, taper_l0=a.taper, fleet=fleet, v_draw=v)
    # heliofield_model-<model date>_computed-<today>_<model>, next to the input file
    name = f"heliofield_model-{attrs.get('date', 'unknown')}_computed-{today()}_{'scs' if rout else 'pfss'}"
    out = a.out or (name if a.date else str(Path(a.file).with_name(name)))
    a.file = a.file or f"{SITE} inputs for {a.date}"
    write(out, src, sol, a, view)
    print(f"wrote {out}.nc and {out}_header.json")
    if a.plot:
        import plot_3d
        import plot_surface
        extra = (["--view", a.view] if a.view else []) + (["--theme", a.theme] if a.theme else [])
        plot_3d.main([f"{out}.nc", *extra])
        plot_surface.main([f"{out}.nc", *(["--theme", a.theme] if a.theme else [])])


if __name__ == "__main__":
    main()
