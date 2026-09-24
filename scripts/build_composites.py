"""Build weekly (ISO, Mon-Sun) and monthly frequency composites from the daily masks.

Each composite is an image where every ~500 m cell is coloured by the number of
days in the period on which floating algae were detected in it. Images are on a
Web Mercator grid so they overlay the web map exactly. Two images per period:
    <id>.png      detailed (~500 m cells), shown when zoomed in
    <id>_lo.png   overview (max over 8x8 cells, ~4 km), shown when zoomed out

Usage (conda base env: geopandas, shapely, numpy, Pillow):
    python scripts/build_composites.py E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS data/composites

Output (upload under <MASK_PREFIX>composites/):
    <out>/weekly/summary.json    {bounds, periods: [{id, start, end, days}]}
    <out>/weekly/2025-W03.png, 2025-W03_lo.png, ...
    <out>/monthly/summary.json, 2025-01.png, 2025-01_lo.png, ...
"""
from __future__ import annotations

import argparse
import json
import math
import re
import struct
import time
from datetime import date, timedelta
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely
from PIL import Image, ImageDraw

CELL_M = 500  # Web Mercator metres per cell (~470 m on the ground at 20°N)
OVERVIEW = 8  # overview cell = 8 x 8 detailed cells
R = 6378137.0
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Frequency classes: lower bound of each class (days), per period type.
CLASSES = {
    "weekly": [1, 2, 3, 4, 5, 6, 7],
    "monthly": [1, 2, 3, 4, 6, 9, 12],
}
# Sequential ramp, dim green -> lime -> pale yellow, readable on the navy ocean.
RAMP = ["#2f6b1c", "#4d9124", "#72b82b", "#9be22f", "#c9ef4b", "#f0f36c", "#fffbd0"]


def mercator(lon, lat):
    x = np.radians(lon) * R
    y = np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R
    return x, y


def inv_mercator(x, y):
    return math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)


def period_of(d: date, kind: str) -> tuple[str, date, date]:
    if kind == "weekly":
        y, w, _ = d.isocalendar()
        start = date.fromisocalendar(y, w, 1)
        return f"{y}-W{w:02d}", start, start + timedelta(days=6)
    start = d.replace(day=1)
    nxt = (start + timedelta(days=32)).replace(day=1)
    return f"{d.year}-{d.month:02d}", start, nxt - timedelta(days=1)


def shp_bbox(path: Path):
    with open(path, "rb") as f:
        head = f.read(100)
    return struct.unpack("<4d", head[36:68]) if len(head) == 100 else None


class Grid:
    def __init__(self, bbox):
        w, s, e, n = bbox
        x0, y0 = mercator(w, s)
        x1, y1 = mercator(e, n)
        # Snap to whole overview blocks so both images share exact bounds.
        block = CELL_M * OVERVIEW
        self.x0, self.y1 = math.floor(x0 / block) * block, math.ceil(y1 / block) * block
        self.width = math.ceil((math.ceil(x1 / block) * block - self.x0) / CELL_M)
        self.height = math.ceil((self.y1 - math.floor(y0 / block) * block) / CELL_M)
        self.x1 = self.x0 + self.width * CELL_M
        self.y0 = self.y1 - self.height * CELL_M

    def bounds_lonlat(self):
        w, s = inv_mercator(self.x0, self.y0)
        e, n = inv_mercator(self.x1, self.y1)
        return [round(w, 6), round(s, 6), round(e, 6), round(n, 6)]

    def rasterize_day(self, shp: Path) -> np.ndarray:
        img = Image.new("1", (self.width, self.height), 0)
        draw = ImageDraw.Draw(img)
        gdf = gpd.read_file(shp)
        if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs(4326)
        for poly in shapely.get_parts(gdf.geometry.values):
            if poly is None or poly.is_empty or poly.geom_type != "Polygon":
                continue
            lon, lat = shapely.get_coordinates(poly.exterior).T
            x, y = mercator(lon, lat)
            px = (x - self.x0) / CELL_M
            py = (self.y1 - y) / CELL_M
            pts = list(zip(px.tolist(), py.tolist()))
            # outline=1 keeps patches smaller than a cell from vanishing.
            draw.polygon(pts, fill=1, outline=1) if len(pts) > 2 else draw.point(pts, fill=1)
        return np.asarray(img, dtype=np.uint8)


def save_png(counts: np.ndarray, kind: str, path: Path) -> None:
    """Paletted PNG: index 0 transparent, 1..7 the frequency classes."""
    classes = np.zeros(counts.shape, dtype=np.uint8)
    for i, lo in enumerate(CLASSES[kind], start=1):
        classes[counts >= lo] = i
    img = Image.fromarray(classes, mode="P")
    palette = [0, 0, 0]
    for hexcol in RAMP:
        palette += [int(hexcol[i:i + 2], 16) for i in (1, 3, 5)]
    img.putpalette(palette + [0, 0, 0] * (256 - len(palette) // 3))
    img.save(path, optimize=True, transparency=0)


def overview(counts: np.ndarray) -> np.ndarray:
    h, w = counts.shape
    return counts.reshape(h // OVERVIEW, OVERVIEW, w // OVERVIEW, OVERVIEW).max(axis=(1, 3))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("daily_dir", type=Path)
    ap.add_argument("out_dir", type=Path)
    args = ap.parse_args()

    days = sorted(p.name for p in args.daily_dir.iterdir() if p.is_dir() and DATE_RE.match(p.name))
    shps = {d: args.daily_dir / d / f"{d}.shp" for d in days}
    shps = {d: p for d, p in shps.items() if p.exists()}

    boxes = [b for b in (shp_bbox(p) for p in shps.values()) if b and b[2] > b[0]]
    bbox = (min(b[0] for b in boxes) - 0.1, min(b[1] for b in boxes) - 0.1,
            max(b[2] for b in boxes) + 0.1, max(b[3] for b in boxes) + 0.1)
    grid = Grid(bbox)
    print(f"grid {grid.width} x {grid.height} cells of {CELL_M} m, bounds {grid.bounds_lonlat()}")

    kinds = ["weekly", "monthly"]
    periods = {k: [] for k in kinds}
    open_ = {k: None for k in kinds}  # (id, start, end, counts, ndays)

    def flush(kind):
        cur = open_[kind]
        if not cur:
            return
        pid, start, end, counts, ndays = cur
        out = args.out_dir / kind
        out.mkdir(parents=True, exist_ok=True)
        save_png(counts, kind, out / f"{pid}.png")
        save_png(overview(counts), kind, out / f"{pid}_lo.png")
        periods[kind].append({"id": pid, "start": start.isoformat(), "end": end.isoformat(),
                              "days": ndays, "max_count": int(counts.max())})
        print(f"  {kind} {pid}: {ndays} days, max {int(counts.max())} days in one cell, "
              f"{(out / f'{pid}.png').stat().st_size / 1e3:.0f} kB", flush=True)
        open_[kind] = None

    t0 = time.time()
    for d, shp in shps.items():
        mask = grid.rasterize_day(shp)
        for kind in kinds:
            pid, start, end = period_of(date.fromisoformat(d), kind)
            if open_[kind] and open_[kind][0] != pid:
                flush(kind)
            if not open_[kind]:
                open_[kind] = (pid, start, end, np.zeros((grid.height, grid.width), np.uint8), 0)
            pid_, s_, e_, counts, n = open_[kind]
            counts += mask
            open_[kind] = (pid_, s_, e_, counts, n + 1)
    for kind in kinds:
        flush(kind)

    for kind in kinds:
        summary = {
            "kind": kind,
            "bounds": grid.bounds_lonlat(),
            "cell_m": CELL_M,
            "classes": CLASSES[kind],
            "ramp": RAMP,
            "periods": periods[kind],
        }
        (args.out_dir / kind / "summary.json").write_text(json.dumps(summary))
    print(f"done in {time.time() - t0:.0f}s -> {args.out_dir}")


if __name__ == "__main__":
    main()
