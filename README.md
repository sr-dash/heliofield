# HelioField

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23487231.svg)](https://doi.org/10.5281/zenodo.23487231)

The Sun's coronal magnetic field in 3D for any date since May 2010, with the
heliophysics fleet placed in it. Recent days are computed nightly on the
server; any other date is computed in the browser from an HMI rotation map. A static site: plain ES modules and three.js, no build step.
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

Then open <http://localhost:8811/>. How to use the viewer, and how everything
is computed, is on the guide page: [`guide.html`](https://sr-dash.github.io/heliofield/guide.html).

The URL holds the full state (`date`, `v`, `layers`, `lines`, `ext`, `view` or
`cam`, `rmax`, `scale`, `ss`, `rotate`, `panel`, `theme`), so any view can be linked.

## Any date since 2010

`scripts/build_history.py` keeps `data/history/`: one HMI Carrington-rotation map
per rotation since CR 2096 (`hmi.Synoptic_Mr_small`, or `hmi.Synoptic_Mr` averaged
down where only that exists), stored as gzipped int16 on the 180 × 360 sin-latitude
grid (about 85 kB each, 18 MB in all), and the daily Carrington positions of Earth,
the planets and the spacecraft. A date without a daily product is solved in a Web
Worker by `js/pfss.js`: spherical harmonics to degree 40, a 36 × 90 × 180 field grid,
RK4 tracing, the source-surface neutral line and connectivity, in about a second.
On the GONG map of 2026-10-17 it matches the sunkit-magex pipeline to a
source-surface correlation of 0.9998, a neutral line within 0.6°, open flux within
2%, and footpoints within about 1°. The page asks before computing, because the
current field is cleared first.

## Open field into the heliosphere

PFSS makes the field radial at the source surface, so open lines are extended
beyond it without a second solve: straight out (`ext=radial`) or, by default, as
Parker spirals at the chosen wind speed, the same kinematic continuation as the
current sheet and spacecraft connectivity. Off by default (`layers` with `ext`).

## Open-field footprints

`scripts/build_open_field.py` traces a field line from every cell of a 1° grid
(rows uniform in sine latitude) at 1.001 R☉ and records whether it reaches the
source surface, and with which polarity: 64,800 lines per map, about 3 s with
sunkit-magex. The result is a 360 × 180 grey PNG (0 closed, 128 open inward,
255 open outward, north up), one per daily product (`data/<date>/open.png`,
made from the cached input map right after `build_day.py`) and one per HMI
rotation map (`data/history/open/NNNN.png`, about 4 kB each). The viewer draws
it as the *Open-field footprints* layer (`layers` with `foot`); a day without
its own map, and any computed date, shows the covering rotation's footprints.
These are the model's coronal holes; they are not checked against EUV images.

## Solar-cycle series

`series.html` shows one point per HMI rotation since CR 2096, from
`data/series/rotations.json`, built by `scripts/build_series.py`: open flux
through the source surface, open-field area, the highest latitude of the
source-surface neutral line in each hemisphere (the Wilcox tilt definition,
Hoeksema 1984; the grid tops out at 84°), and the mean photospheric B<sub>r</sub>
poleward of 60°. `scripts/rotations.py` holds the shared solve (sunkit-magex,
R<sub>ss</sub> = 2.5 R☉, 40 shells) and caches each rotation under
`cache/solve/`; a full rebuild of footprints and series takes about 25 minutes,
and the nightly job only solves rotations it has not seen. Limitations: PFSS
open flux is typically half the in-situ value at 1 au (the open flux problem,
Linker et al. 2017); the tilt differs from WSO's line-of-sight values by several
degrees; polar means rest on fields seen at a grazing angle.

## Colours and themes

Dark and light themes; one hue per role in both. The field colours (open +, open −,
closed, current sheet) were validated as an all-pairs set in each theme against
its background: protan/deutan ΔE ≥ 9.8 (OKLab × 100), normal-vision ΔE ≥ 17, and
≥ 3:1 contrast (WCAG 2.1 SC 1.4.11). Values and the reasoning are in `js/theme.js`
and the guide's colour section. Re-validate before changing any of them.
The series charts use a separate blue/orange pair (`chart` in `js/theme.js`),
checked the same way: protan/deutan ΔE ≥ 25, ≥ 3:1 in both themes.

**Save & share → Save PNG / Save PDF** writes the current view with a title band
and legend.

## Embedding

Add `embed=1` to any link for the scene alone, with a slim date bar and a link to
the full site; `controls=0` hides the bar too. **Share → Copy embed code** in the
panel writes the code for the current view:

```html
<iframe src="https://sr-dash.github.io/heliofield/?date=latest&view=earth&embed=1"
        title="HelioField: the Sun's coronal magnetic field in 3D"
        width="100%" height="560" style="border:0;border-radius:12px"
        loading="lazy" allowfullscreen></iframe>
```

A host page can drive the frame without reloading it, and hears back after each
change. A date without a product snaps to the latest one on or before it:

```js
frame.contentWindow.postMessage(
  { type: "heliofield:set", date: "2026-10-17", v: 500, view: "earth" }, "*");
addEventListener("message", (e) => {
  if (e.data?.type === "heliofield:state") console.log(e.data.date, e.data.source);
});
```

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

## Citing HelioField

If HelioField helps your research, please cite it:

> Dash, S. (2026). *HelioField: the Sun's coronal magnetic field in 3D* (Version 1.0.0) [Computer software]. Zenodo. https://doi.org/10.5281/zenodo.23487231

That DOI always resolves to the latest release. Each release also has its own DOI on the [Zenodo record](https://doi.org/10.5281/zenodo.23487231); [10.5281/zenodo.23487232](https://doi.org/10.5281/zenodo.23487232) is version 1.0.0. GitHub's **Cite this repository** button (from [CITATION.cff](CITATION.cff)) and the [guide](https://sr-dash.github.io/heliofield/guide.html#cite) give APA and BibTeX references. Please also cite the data and model the field is built from: NSO/GONG or SDO/HMI, and PFSS (see the guide's references).

## Contributing, licence and citation

Bug reports, feature requests and model or data requests go through the
[issue forms](https://github.com/sr-dash/heliofield/issues/new/choose); see
[CONTRIBUTING.md](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md)
and the [security policy](SECURITY.md). HelioField is released under the
[MIT licence](LICENSE); [CITATION.cff](CITATION.cff) gives the citation.
`scripts/make_icons.py` regenerates the icons and the social-preview image.

HelioField is the companion to [HelioFleet](https://sr-dash.github.io/heliofleet/),
which maps the spacecraft around the Sun and supplies their positions here. Both
are by [Soumyaranjan Dash](https://sr-dash.github.io/).

## Credits

Magnetograms: NSO/GONG and SDO/HMI (JSOC; rotation maps and daily frames). Ephemerides: JPL Horizons via HelioFleet.
PFSS: sunkit-magex (SunPy project).
