## What this changes

<!-- A short description of the change and why it is needed. Link the issue it addresses, e.g. "Closes #12". -->

## How it was checked

<!-- What you looked at: which dates (a daily product and a past date computed in the browser), themes and screen sizes; any comparison with sunkit-magex, another PFSS code or observations. Screenshots help for visual changes. -->

## Checklist

- [ ] After any change in `css/` or `js/`, I ran `python3 scripts/stamp_assets.py` and committed the files it rewrote
- [ ] The page works on a phone-sized screen and in the light and dark themes, with no errors in the browser console
- [ ] A past date computed in the browser still loads (try one before 2015)
- [ ] After any change to `js/pfss.js` or `scripts/build_day.py`, `python -m pytest tests -v` passes (or the tolerances and the guide's Validation table were updated, with the reason)
- [ ] Any new or changed colour was validated as described in `js/theme.js` (colour-vision separation and 3:1 contrast in both themes)
- [ ] New controls, link parameters or methods are described in the README and on the guide page
- [ ] I have read the [contributing guidelines](https://github.com/sr-dash/heliofield/blob/main/CONTRIBUTING.md) and the [code of conduct](https://github.com/sr-dash/heliofield/blob/main/CODE_OF_CONDUCT.md)
