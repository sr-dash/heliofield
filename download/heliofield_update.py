#!/usr/bin/env python3
"""Keep the HelioField scripts working as Python packages change.

The scripts were tested with the package versions in requirements-tested.txt.
Every script calls install() first. It:

  - warns once if NumPy, SciPy or Matplotlib is older than the scripts
    support, or newer than the versions they were tested with;
  - if the script then fails, looks for an updated copy of the scripts on
    the HelioField site (download/manifest.json), checks each file against
    the published SHA-256, keeps your copy as <name>.bak, and runs the
    script again with the update. The site's scripts are tested against the
    newest package releases every month and fixed when they break.

Set HELIOFIELD_NO_UPDATE=1 to turn the automatic update off. To update by
hand, or just to see whether an update exists:

    python heliofield_update.py            # update the scripts in this folder
    python heliofield_update.py --check    # only report

This module uses only the Python standard library, so it keeps working when
a package does not.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import traceback
import urllib.request
from pathlib import Path

SITE = "https://sr-dash.github.io/heliofield/download/"
ISSUES = "https://github.com/sr-dash/heliofield/issues"
HERE = Path(__file__).resolve().parent
PACKAGES = ("numpy", "scipy", "matplotlib")
_warned = False


def _version(s: str) -> tuple:
    out = []
    for part in s.split(".")[:3]:
        num = "".join(ch for ch in part if ch.isdigit())
        out.append(int(num) if num else 0)
    return tuple(out)


def _pins(name: str) -> dict:
    """{package: version} from a requirements file in this folder."""
    pins = {}
    path = HERE / name
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.split("#")[0].strip()
            for op in ("==", ">="):
                if op in line:
                    k, v = line.split(op, 1)
                    pins[k.strip().lower()] = v.split(",")[0].strip()
    return pins


def check_versions(stream=sys.stderr) -> list[str]:
    """Notes on installed versions outside the supported or tested range."""
    global _warned
    from importlib import metadata
    lowest, tested, notes = _pins("requirements.txt"), _pins("requirements-tested.txt"), []
    for pkg in PACKAGES:
        try:
            have = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            notes.append(f"{pkg} is not installed: pip install -r requirements.txt")
            continue
        if pkg in lowest and _version(have) < _version(lowest[pkg]):
            notes.append(f"{pkg} {have} is older than the lowest supported version {lowest[pkg]}")
        elif pkg in tested and _version(have)[:2] > _version(tested[pkg])[:2]:
            notes.append(f"{pkg} {have} is newer than the version tested ({tested[pkg]})")
    if notes and not _warned and stream is not None:
        _warned = True
        print("HelioField scripts: " + "; ".join(notes) + ".\n"
              "  They usually work, but if a script fails see 'Package versions' in README.txt.", file=stream)
    return notes


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _get(url: str, timeout: float = 15) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "heliofield-scripts", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def manifest() -> dict:
    return json.loads(_get(SITE + "manifest.json"))


def outdated(man: dict | None = None) -> list[str]:
    """Scripts in this folder that differ from the published ones."""
    man = man or manifest()
    return [name for name, digest in man["files"].items()
            if not (HERE / name).exists() or _sha256(HERE / name) != digest]


def update(verbose: bool = True) -> list[str]:
    """Fetch the published scripts that differ from the copies here. Each
    download must match the manifest's SHA-256; replaced files are kept as
    <name>.bak. Returns the names updated."""
    man = manifest()
    names = outdated(man)
    done = []
    for name in names:
        data = _get(SITE + name)
        if hashlib.sha256(data).hexdigest() != man["files"][name]:
            raise RuntimeError(f"{name}: checksum does not match the manifest; not updated")
        path = HERE / name
        if path.exists():
            path.replace(path.with_name(path.name + ".bak"))
        path.write_bytes(data)
        done.append(name)
    if verbose:
        print(f"Updated {', '.join(done)} (version {man.get('version', '?')})." if done
              else "The scripts here are the latest published ones.")
    return done


def _hook(kind, value, tb):
    if issubclass(kind, KeyboardInterrupt):
        return sys.__excepthook__(kind, value, tb)
    traceback.print_exception(kind, value, tb)
    if os.environ.get("HELIOFIELD_NO_UPDATE") or os.environ.get("HELIOFIELD_UPDATED"):
        _advice(after_update=bool(os.environ.get("HELIOFIELD_UPDATED")))
        return
    print("\nThe script failed. Looking for updated HelioField scripts ...", file=sys.stderr)
    try:
        done = update(verbose=False)
    except Exception as e:                        # offline, site down, bad checksum
        print(f"Could not check for updates ({e}).", file=sys.stderr)
        done = []
    if done:
        print(f"Updated {', '.join(done)}; your copies are kept as .bak. Running again ...\n", file=sys.stderr)
        sys.stderr.flush(); sys.stdout.flush()
        os.environ["HELIOFIELD_UPDATED"] = "1"
        os.execv(sys.executable, [sys.executable] + sys.argv)
    _advice()


def _advice(after_update=False):
    tested = ", ".join(f"{k} {v}" for k, v in _pins("requirements-tested.txt").items())
    print(("\nThe updated scripts failed too. " if after_update else "\nNo updated scripts are available yet. ")
          + f"The scripts were tested with {tested or 'the versions in requirements-tested.txt'}. Try them in a fresh environment:\n"
          "    python -m venv hf && . hf/bin/activate && pip install -r requirements-tested.txt\n"
          f"and please report the problem: {ISSUES}", file=sys.stderr)


def install(script: str | None = None):
    """Call first in every script: version notes now, update on failure."""
    check_versions()
    sys.excepthook = _hook


if __name__ == "__main__":
    check_versions(stream=sys.stdout)
    try:
        if "--check" in sys.argv:
            names = outdated()
            print("Updates available for: " + ", ".join(names) if names else "The scripts here are the latest published ones.")
        else:
            update()
    except OSError as e:
        sys.exit(f"Could not reach {SITE}: {e}")
