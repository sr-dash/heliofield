HelioField results: {{TITLE}}
{{RULE}}

Model:   {{MODEL}}
Input:   {{SOURCE}}
Saved:   {{CREATED}} from https://sr-dash.github.io/heliofield/
Product: {{PRODUCT}}

Files
-----
{{FILES}}

Getting started
---------------
Python 3.9 or newer with NumPy, SciPy and Matplotlib:

    pip install -r requirements.txt

{{STEPS}}

Each plot script writes both a PNG and a PDF next to the result file. Run a
script with --help for its options (camera, theme, wind speed, which lines).

The results file
----------------
{{NCNAME}} is a NetCDF-3 (classic) file. Any NetCDF reader opens it: xarray,
netCDF4, SciPy, Panoply, ParaView. The header file {{HEADERNAME}} lists every
variable with its dimensions, units and meaning, and records the model
settings and the view that was on screen when the file was saved.

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
