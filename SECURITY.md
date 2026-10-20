# Security policy

HelioField is a static website: HTML, CSS, JavaScript modules and data files served by GitHub Pages, with no server-side code, user accounts or stored personal data. Past dates are computed in the visitor's browser from files in this repository. Its GitHub Actions workflow fetches public magnetograms from NSO/GONG and SDO/HMI (JSOC) and spacecraft positions from HelioFleet, and commits the results to this repository.

## Supported versions

Only the current version of the site, built from the `main` branch and published at <https://sr-dash.github.io/heliofield/>, receives fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub instead: open the repository's [Security tab](https://github.com/sr-dash/heliofield/security) and choose **Report a vulnerability** (or go straight to the [reporting form](https://github.com/sr-dash/heliofield/security/advisories/new)). Only the maintainer can see the report, and the fix can be discussed and prepared there in private. If you cannot use GitHub, write to the maintainer, Soumyaranjan Dash, at <sdash@nso.edu>.

Please include:

- what the problem is and where it is (a page, a script, a workflow or a data file);
- how to reproduce it;
- what an attacker could do with it, if you know.

You should receive a reply within a week. Once the problem is confirmed, a fix will be published as soon as practical, and you will be credited in the commit unless you prefer otherwise.

## What is in scope

- Code on the site that could run attacker-controlled script, for example through link parameters, `postMessage` from a host page, or the embed mode.
- The GitHub Actions workflow, its permissions and the scripts it runs.
- Data files that could be altered to mislead users of the site.

Problems in the external services the site reads from or links to (NSO/GONG, JSOC, HelioFleet, Google Analytics, jsDelivr or cdnjs) should be reported to those services directly.
