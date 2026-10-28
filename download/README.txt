HelioField results: {{TITLE}}
{{RULE}}

Model date: {{MODELDATE}}   (the date the field is computed for)
Saved:      {{SAVED}}   (the date it was computed and downloaded in your browser,
            {{CREATED}} UTC, https://sr-dash.github.io/heliofield/)
Model:      {{MODEL}}
Input:      {{SOURCE}}
Product:    {{PRODUCT}}

Files
-----
{{FILES}}

Getting started
---------------
Python 3.9 or newer with NumPy, SciPy and Matplotlib:

    pip install -r requirements.txt

{{STEPS}}

Each plot script writes both a PNG and a PDF next to the file it reads. Run
a script with --help for its options (camera, theme, wind speed, which lines).

Preprocessing of the magnetogram
--------------------------------
The files hold two photospheric maps:

  br_input  {{PREP_INPUT}}.

  br_phot   {{PREP_MODEL}}

The field lines, the source surface and everything above come from br_phot,
not from the finer-grained br_input. plot_surface.py shows br_phot by
default; --input shows br_input instead. plot_3d.py colours the Sun with
br_input, as the web page does; --model-surface uses br_phot instead.

Package versions: please read
-----------------------------
The scripts were tested with the versions in requirements-tested.txt. Newer
releases of NumPy, SciPy and Matplotlib usually work, but they can change or
remove functions that the scripts use. If a script fails:

  1. It looks for an updated copy of the scripts on the HelioField site,
     checks it against the published checksums, keeps your copy as
     <name>.py.bak, and runs again with the update. The scripts are checked
     against the newest package releases every month and fixed when needed.
     To turn this off, set HELIOFIELD_NO_UPDATE=1.
  2. If there is no update yet, install the tested versions in a fresh
     environment:
         python -m venv hf && . hf/bin/activate
         pip install -r requirements-tested.txt
     and please report the problem: https://github.com/sr-dash/heliofield/issues

You can also update the scripts at any time with:
    python heliofield_update.py

The results file
----------------
{{NCNAME}} is a NetCDF-3 (classic) file. Any NetCDF reader opens it: xarray,
netCDF4, SciPy, Panoply, ParaView. The header file {{HEADERNAME}} lists every
variable with its dimensions, units and meaning, and records the
preprocessing, the model settings and the view that was on screen when the
file was saved.

    import xarray as xr
    ds = xr.open_dataset("{{NCNAME}}", engine="scipy")

    from heliofield_io import load          # NumPy and SciPy only
    res = load("{{NCNAME}}")

Conventions
-----------
- Carrington heliographic frame, rotating with the Sun. Cartesian x points to
  Carrington longitude 0 and z along the rotation axis.
- Lengths are in solar radii (R_sun = 695700 km) and fields in gauss. B_theta
  is positive southward and B_phi eastward.
- Surface maps (lat, lon) use the input map's grid: rows uniform in
  sin(latitude), south first, and columns at longitude j + 0.5 degrees. The 3D
  grid (r, lat_g, lon_g) is uniform in ln r, with latitude cell centres south
  first and longitude nodes every 2 degrees.
- With the Schatten current-sheet model, the *_scs field is unsigned (it
  points outward everywhere). A field line's sign is the sign of PFSS B_r
  where it crosses the cusp surface. polarity_out gives the sign near the
  outer edge.

Methods, validation and limitations:
https://sr-dash.github.io/heliofield/guide.html#methods

Please cite: {{CITATION}}
and the magnetogram the field is built from ({{SOURCE}}).
The scripts are released under the MIT licence.
