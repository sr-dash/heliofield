# Contributing to HelioField

Thank you for helping. HelioField is meant to be useful to the whole heliophysics community, so reports, ideas and code are all welcome. Everyone taking part is asked to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report something that looks wrong.** A field line, neutral line, open-flux value or footpoint that disagrees with another model or with observations is the most valuable report there is. Use the [issue forms](https://github.com/sr-dash/heliofield/issues/new/choose) and include the link to the view (every view has one: **Save & share → Copy link**).
- **Suggest a feature** with the feature-request form.
- **Ask for a model or data source** (another magnetogram, an outflow or MHD model, a derived layer such as coronal holes) with the model-or-data form. Say where it is archived and under what licence.
- **Send a pull request** for a fix or feature. For anything larger than a small fix, please open an issue first, so we can agree on the approach before you spend time on it.

Questions about spacecraft positions or missing missions belong to [HelioFleet](https://github.com/sr-dash/heliofleet), which supplies the positions.

## Running the site locally

The site is static and has no build step. Serve the repository root over HTTP:

```bash
python3 -m http.server 8811
```

and open <http://localhost:8811>. Past dates are computed in the browser from `data/history/`, so they work locally too.

The data scripts need Python 3.12 and `pip install -r requirements.txt`:

```bash
python scripts/build_day.py --date 2026-10-17     # one daily product
python scripts/build_history.py                   # new HMI rotation maps and fleet positions
python scripts/make_icons.py                      # icons and the social-preview image
```

## Before you open a pull request

- Run `python3 scripts/stamp_assets.py` after any change in `css/` or `js/`, and commit the files it rewrites. It gives every stylesheet and module a content-hashed URL, so returning visitors never run a mix of old and new files after a deploy (GitHub Pages lets browsers cache them for about ten minutes). A check on every push fails when the stamps are out of date.
- Check a daily product **and** a past date computed in the browser (try one before 2015), in both themes and at phone width, with the browser console open.
- If you change the solver in `js/pfss.js` or the pipeline in `scripts/build_day.py`, run the validation suite. It checks the solver against exact solutions and against sunkit-magex on three archived rotation maps. It needs Node.js 22.12 or newer:

  ```bash
  pip install -r requirements.txt -r requirements-test.txt
  python -m pytest tests -v
  ```

  The scripts in `download/` reach users' machines and update themselves from this site, so keep them reading every file format they ever wrote (`heliofield-export-1` and later). After changing one, run `python3 scripts/stamp_assets.py` to refresh `download/manifest.json`.

  `download/compute_corona.py` is the same solver rewritten in NumPy, which users get with their downloads. A change to the method in `js/pfss.js` must be made there as well; `tests/test_export.py` fails when the two disagree.

  Each run writes its numbers to `cache/validation/`. If a deliberate change moves them, update the tolerances in `tests/` and the table in the guide's Validation section in the same pull request, and say why.
- Colours are not chosen by eye. Any new or changed colour in `js/theme.js` must keep colour-vision separation and at least 3:1 contrast against the background in both themes; the file explains how they were validated.
- New controls, link parameters or methods go into the README and the [guide](https://sr-dash.github.io/heliofield/guide.html).

## Code style

- Plain ES modules in `js/`, no framework and no build step. Match the style of the surrounding code: short functions, descriptive names, and a comment where the reason is not obvious.
- Coordinates are Carrington throughout; convert once, where data enter, not in the renderer.
- Keep the page usable on a phone and readable in both themes.

## Commits and pull requests

- One topic per pull request, with a short description of what changed and why.
- Write commit messages in the imperative ("Add an ADAPT input", "Fix the neutral line at the seam") and keep them brief.
- Pull requests are reviewed by the maintainer. Contributions are released under the [MIT license](LICENSE) of the project.

## Security

Please report security problems privately, as described in the [security policy](SECURITY.md), not in a public issue.
