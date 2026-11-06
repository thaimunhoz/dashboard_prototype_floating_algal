"""Copies daily masks into the layout the other scripts and the dashboard read.

    <src>/20250101/north_america_20250101.shp  ->  <out>/2025-01-01/2025-01-01.shp

The source folder is not changed. Days already copied (same file sizes) are skipped,
so an interrupted run can be repeated.

Usage:
    python scripts/prepare_masks.py Z:/.../NORTH_AMERICA/daily_masks data/north-america-v2/masks
"""
from __future__ import annotations

import argparse
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DAY_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")
SHAPEFILE_PARTS = {".shp", ".shx", ".dbf", ".prj", ".cpg"}


def copy_day(src_day: Path, out: Path) -> str | None:
    """Returns a problem description, or None when the day is complete."""
    m = DAY_RE.match(src_day.name)
    date = f"{m[1]}-{m[2]}-{m[3]}"
    parts = [f for f in src_day.iterdir() if f.is_file() and f.suffix.lower() in SHAPEFILE_PARTS]
    shps = [f for f in parts if f.suffix.lower() == ".shp"]
    if len(shps) != 1:
        return f"{src_day.name}: expected one .shp, found {len(shps)}"
    day_out = out / date
    day_out.mkdir(parents=True, exist_ok=True)
    for f in parts:
        target = day_out / f"{date}{f.suffix.lower()}"
        if not target.exists() or target.stat().st_size != f.stat().st_size:
            shutil.copyfile(f, target)
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    days = sorted(p for p in args.src.iterdir() if p.is_dir() and DAY_RE.match(p.name))
    with ThreadPoolExecutor(8) as pool:
        problems = [p for p in pool.map(lambda d: copy_day(d, args.out), days) if p]
    for p in problems:
        print(f"warning: {p}")
    print(f"copied {len(days) - len(problems)} of {len(days)} days to {args.out}")


if __name__ == "__main__":
    main()
