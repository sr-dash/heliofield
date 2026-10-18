# HelioField

The Sun's coronal magnetic field in 3D, updated daily, with the heliophysics
fleet placed in it. A static site: plain ES modules and three.js, no build step.
Companion to [HelioFleet](https://sr-dash.github.io/heliofleet/), which supplies
the spacecraft positions.

What the page shows, for each day:

- the photospheric radial field (GONG zero-point-corrected synoptic map, or SDO/HMI when GONG is unreachable) on the Sun
- PFSS field lines, closed and open, with open lines coloured by polarity
- the source surface (2.5 R☉) coloured by B<sub>r</sub>, and its neutral line
- the heliospheric current sheet: the neutral line carried outward and wound
  into a Parker spiral at the chosen solar-wind speed
- planets and spacecraft, each with its Parker spiral back to the source
  surface and the PFSS field line from there to its photospheric footpoint

## Run it

```bash
python3 -m http.server 8811
```

Then open <http://localhost:8811/>. URL state: `?date=2026-10-17&v=500`.

## Data

```bash
pip install -r requirements.txt
python scripts/build_day.py                                 # today (UTC)
python scripts/build_day.py --date 2026-10-01 --to 2026-10-17
python scripts/build_day.py --prune                         # thin old history
```

Each day writes `data/<date>/` (about 340 kB):

| File | Content |
|---|---|
| `meta.json` | map provenance, Carrington rotation, L0/B0, open flux, HCS polylines, fleet positions, footpoints |
| `br.png` | photospheric B<sub>r</sub>, 360×180 equirectangular, 8-bit, ±20 G, north up, column *j* at Carrington longitude *j*+0.5° |
| `ss.png` | source-surface B<sub>r</sub>, same grid, ±`ss_scale` G |
| `lines.bin` | every polyline as little-endian int16 Carrington *xyz* in units of 10⁻⁴ R☉; lengths in `meta.counts` (field lines first, then one per `meta.connect` entry) |

Everything is in the Carrington frame, so the page does no coordinate
transforms. Spacecraft positions are read from HelioFleet's published
ephemerides (heliocentric J2000 ecliptic) and converted for the map time.

Model choices: PFSS by [sunkit-magex](https://github.com/sunpy/sunkit-magex)
on the native GONG grid (180×360, 40 radial shells, R<sub>ss</sub> = 2.5 R☉),
monopole removed. 740 lines per day, seeded by equal area near the surface,
by |B<sub>r</sub>|<sup>1.5</sup>, and on the source surface so open field is
sampled evenly. Connectivity is ballistic: a body at (r, φ) maps to the source
surface at φ + Ω(r − R<sub>ss</sub>)/v, with Ω the Carrington sidereal rate,
for v = 300–800 km/s.

Input: the last GONG mrzqs map of the day. GONG's server does not answer
GitHub's cloud runners, so when it cannot be reached within 15 s the build uses
the SDO/HMI daily synoptic frame from JSOC
(`hmi.Mrdailysynframe_small_720s_nrt`), provided its record date is that day.
JSOC keeps only the latest frame at that path, so the fallback serves the
nightly build; backfills need GONG. The frame's header is rebuilt (its CUNIT2
is `sin(deg)`, and CRVAL1 is Carrington time with longitude increasing along
x) and it is averaged 2×2 onto GONG's 180×360 grid. `meta.source` records which
was used and the page shows it as a badge beside the date. On 2026-10-17 the two
agree in longitude to within a pixel (r = 0.72 between the maps).

GONG maps do not start at Carrington longitude 0 (CRVAL1 moves with the map);
`to_equirect` rolls the columns using the map's own WCS, and the flux-weighted
seeds are offset the same way.

`.github/workflows/daily.yml` rebuilds yesterday and today at 23:40 UTC and
keeps every day for 120 days, then one per Carrington rotation.

## Credits

Magnetograms: NSO/GONG and SDO/HMI (JSOC). Ephemerides: JPL Horizons via HelioFleet.
PFSS: sunkit-magex (SunPy project).
