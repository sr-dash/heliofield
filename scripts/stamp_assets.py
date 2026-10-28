#!/usr/bin/env python3
"""Stamp the pages' CSS and JavaScript with content hashes.

GitHub Pages lets browsers cache files for about ten minutes, so right after
an update a visitor could otherwise run a mix of old and new modules. This
script adds ?v=<hash> to every stylesheet and entry module in the pages, and
writes an import map that gives every module in js/ its own hashed URL, so a
visitor gets either the whole old set or the whole new set.

Import maps do not reach into a worker or a new URL(...), so the links that
bypass the map are stamped in the source instead: the worker URL in
js/history.js and the worker's imports (./pfss.js, ./export.js, and the
modules export.js loads). Those are
stamped first, so the hashes in the import map cover the stamped files.

It also writes download/manifest.json, the checksums of the Python scripts
that downloads include, which those scripts use to update themselves.

Run it after changing anything in css/, js/ or download/:
    python3 scripts/stamp_assets.py
    python3 scripts/stamp_assets.py --check   # exit 1 if any stamp is stale
"""

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Each page and its entry module (None: stylesheets only)
PAGES = {"index.html": "main.js", "series.html": "series.js", "guide.html": None}
# Libraries the viewer loads from the CDN; versioned already, so not hashed
LIBRARIES = {
    "index.html": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/",
    },
}
# Links inside js/ that the import map cannot reach, in dependency order:
# (file, the module it points to, the pattern that holds the link)
IN_SOURCE = [
    ("export.js", "pfss.js", r'from "\./pfss\.js(\?v=[0-9a-f]*)?"'),
    ("export.js", "netcdf.js", r'from "\./netcdf\.js(\?v=[0-9a-f]*)?"'),
    ("pfss-worker.js", "pfss.js", r'from "\./pfss\.js(\?v=[0-9a-f]*)?"'),
    ("pfss-worker.js", "export.js", r'from "\./export\.js(\?v=[0-9a-f]*)?"'),
    ("history.js", "pfss-worker.js", r'new URL\("\./pfss-worker\.js(\?v=[0-9a-f]*)?"'),
]


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()[:10]


def stamped_sources():
    """Contents of every js/ module with the in-source links stamped."""
    files = {m.name: m.read_text() for m in sorted((ROOT / "js").glob("*.js"))}
    for name, target, pattern in IN_SOURCE:
        link = re.search(pattern, files[name])
        if link is None:
            sys.exit(f"js/{name}: no link to {target} found; update IN_SOURCE in scripts/stamp_assets.py")
        old = link.group(0)
        new = re.sub(r"\?v=[0-9a-f]*", "", old).replace(target, f"{target}?v={digest(files[target])}", 1)
        files[name] = files[name].replace(old, new, 1)
    return files


def stamped_page(page, entry, sources):
    html = (ROOT / page).read_text()
    for css in sorted((ROOT / "css").glob("*.css")):
        html = re.sub(rf'href="css/{re.escape(css.name)}(\?v=[0-9a-f]*)?"',
                      f'href="css/{css.name}?v={digest(css.read_text())}"', html)
    if entry is None:
        return html
    imports = dict(LIBRARIES.get(page, {}))
    imports.update({f"./js/{n}": f"./js/{n}?v={digest(t)}" for n, t in sources.items()})
    html = re.sub(rf'src="js/{re.escape(entry)}(\?v=[0-9a-f]*)?"', f'src="{imports["./js/" + entry][2:]}"', html)
    lines = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in imports.items())
    block = ('<!-- assets:start (written by scripts/stamp_assets.py) -->\n'
             f'<script type="importmap">\n{{ "imports": {{\n{lines}\n}} }}\n</script>\n'
             '<!-- assets:end -->')
    if "<!-- assets:start" in html:
        html = re.sub(r"<!-- assets:start.*?<!-- assets:end -->", lambda _: block, html, flags=re.S)
    elif '<script type="importmap">' in html:
        # First run: replace the hand-written map
        html = re.sub(r'<script type="importmap">.*?</script>', lambda _: block, html, count=1, flags=re.S)
    else:
        # The import map must come before the first module script
        html = html.replace('<script type="module"', f'{block}\n<script type="module"', 1)
    return html


def scripts_manifest():
    """download/manifest.json: the SHA-256 of every script users download, which
    their heliofield_update.py checks updates against."""
    files = sorted([*(ROOT / "download").glob("*.py"), *(ROOT / "download").glob("requirements*.txt")])
    digests = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in files}
    version = hashlib.sha256(json.dumps(digests, sort_keys=True).encode()).hexdigest()[:12]
    return json.dumps({"version": version, "files": digests}, indent=1) + "\n"


def main():
    check = "--check" in sys.argv
    sources = stamped_sources()
    targets = {ROOT / "js" / n: t for n, t in sources.items()}
    targets[ROOT / "download" / "manifest.json"] = scripts_manifest()
    targets.update({ROOT / p: stamped_page(p, e, sources) for p, e in PAGES.items()})
    stale = [path for path, text in targets.items() if not path.exists() or text != path.read_text()]
    if not check:
        for path in stale:
            path.write_text(targets[path])
    names = ", ".join(str(p.relative_to(ROOT)) for p in stale)
    if check:
        if stale:
            print(f"out of date: {names}; run python3 scripts/stamp_assets.py")
            sys.exit(1)
        print("asset stamps are current")
        return
    print(f"stamped: {names or 'nothing changed'}")


if __name__ == "__main__":
    main()
