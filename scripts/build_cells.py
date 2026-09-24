"""Per-cell daily algal bloom area on the 4 km fishnet, for the dashboard's click-for-time-series.

For every day, each mask polygon is split along the fishnet and its area summed per cell
(Web Mercator area corrected by cos²(latitude) to km² on the ground). A cell counts as
observed on a day when its centre lies in that day's observed footprint
(scripts/build_coverage.py), or when algae were detected in it.

The fishnet is a regular EPSG:3857 grid (left/top/row_index/col_index), the same projection
as the web map, so the browser finds the clicked cell arithmetically; only the numbers are stored,
in blocks of CHUNK x CHUNK cells fetched on demand.

Usage (conda base env: geopandas, shapely, numpy):
    python scripts/build_cells.py \
        --fishnet Z:/guser/tml/global_model/PROTOTYPE/prototype_v2/shapefiles/caribbean_4km_fishnet.shp \
        --masks   E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS \
        --coverage data/coverage --out data/cells

Output (upload under <MASK_PREFIX>cells/):
    <out>/grid.json          {x0, y0, cell, cols, rows, chunk, dates: [...]}
    <out>/<cr>_<cc>.json     {patterns: [base64 bitmask of observed days],
                              cells: {"<row>_<col>": [pattern_index, day_index, km2, day_index, km2, ...]}}
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
import time
from collections import defaultdict
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely

R = 6378137.0
CHUNK = 64
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def to_mercator(coords: np.ndarray) -> np.ndarray:
    lon, lat = coords[:, 0], np.clip(coords[:, 1], -85, 85)
    return np.column_stack([np.radians(lon) * R, np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) * R])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fishnet", type=Path, required=True)
    ap.add_argument("--masks", type=Path, required=True)
    ap.add_argument("--coverage", type=Path, default=Path("data/coverage"))
    ap.add_argument("--out", type=Path, default=Path("data/cells"))
    args = ap.parse_args()
    t0 = time.time()

    # ── grid ──────────────────────────────────────────────────────
    net = gpd.read_file(args.fishnet, columns=["left", "top", "right", "row_index", "col_index"], ignore_geometry=True)
    cell = float((net["right"] - net["left"]).iloc[0])
    # Grid origin (top-left corner of row 0 / col 0) from the attribute table.
    x0 = float((net["left"] - net["col_index"] * cell).mode()[0])
    y0 = float((net["top"] + net["row_index"] * cell).mode()[0])
    rows_i = net["row_index"].to_numpy(int)
    cols_i = net["col_index"].to_numpy(int)
    ncols, nrows = int(cols_i.max()) + 1, int(rows_i.max()) + 1
    keys = rows_i * ncols + cols_i
    index_of = {int(k): i for i, k in enumerate(keys)}
    print(f"fishnet: {len(net)} cells, {ncols} x {nrows}, origin ({x0}, {y0}), {cell:.0f} m")

    # Cell centres in lon/lat for the observation test; cos² for the Mercator area correction.
    cx = x0 + (cols_i + 0.5) * cell
    cy = y0 - (rows_i + 0.5) * cell
    lon_c = np.degrees(cx / R)
    lat_c = np.degrees(2 * np.arctan(np.exp(cy / R)) - np.pi / 2)
    row_lat = np.degrees(2 * np.arctan(np.exp((y0 - (np.arange(nrows) + 0.5) * cell) / R)) - np.pi / 2)
    row_k = np.cos(np.radians(row_lat)) ** 2  # Mercator m² -> ground m², per grid row

    dates = sorted(p.name for p in args.masks.iterdir() if p.is_dir() and DATE_RE.match(p.name))
    ndays = len(dates)
    observed = np.zeros((len(net), ndays), dtype=bool)
    areas: dict[int, list[tuple[int, float]]] = defaultdict(list)  # cell index -> [(day, km2)]

    for d, date in enumerate(dates):
        # ── observation: cell centre inside the day's observed footprint ──
        cov = args.coverage / f"{date}.geojson"
        if cov.exists():
            feats = json.loads(cov.read_text())["features"]
            obs = [shapely.geometry.shape(f["geometry"]) for f in feats if f["properties"].get("kind") == "observed"]
            if obs:
                g = obs[0]
                shapely.prepare(g)
                observed[:, d] = shapely.contains_xy(g, lon_c, lat_c)

        # ── algal area per cell ──
        shp = args.masks / date / f"{date}.shp"
        if not shp.exists():
            continue
        polys = shapely.get_parts(gpd.read_file(shp).geometry.values)
        polys = polys[shapely.get_type_id(polys) == 3]  # Polygon
        if not len(polys):
            continue
        polys = shapely.transform(polys, to_mercator)
        b = shapely.bounds(polys)
        c0 = np.floor((b[:, 0] - x0) / cell).astype(int)
        c1 = np.floor((b[:, 2] - x0) / cell - 1e-9).astype(int)
        r0 = np.floor((y0 - b[:, 3]) / cell).astype(int)
        r1 = np.floor((y0 - b[:, 1]) / cell - 1e-9).astype(int)

        day_area: dict[int, float] = defaultdict(float)
        single = (c0 == c1) & (r0 == r1)
        # Most patches sit inside one cell: vectorised.
        a = shapely.area(polys[single])
        for r, c, v in zip(r0[single], c0[single], a):
            day_area[r * ncols + c] += v * row_k[min(max(r, 0), nrows - 1)]
        # The rest are clipped to each cell they touch.
        for i in np.flatnonzero(~single):
            p = polys[i]
            for r in range(r0[i], r1[i] + 1):
                for c in range(c0[i], c1[i] + 1):
                    xmin = x0 + c * cell
                    ymax = y0 - r * cell
                    part = shapely.clip_by_rect(p, xmin, ymax - cell, xmin + cell, ymax)
                    if not part.is_empty:
                        day_area[r * ncols + c] += part.area * row_k[min(max(r, 0), nrows - 1)]

        kept = 0
        for key, m2 in day_area.items():
            i = index_of.get(int(key))
            if i is None:  # outside the fishnet (e.g. inland water not in the grid)
                continue
            km2 = round(m2 / 1e6, 4)
            if km2 > 0:
                areas[i].append((d, km2))
                observed[i, d] = True
                kept += 1
        if d % 30 == 0 or d == ndays - 1:
            print(f"  {date}: {len(polys)} patches -> {kept} cells  ({time.time() - t0:.0f}s)", flush=True)

    # ── write blocks ──────────────────────────────────────────────
    args.out.mkdir(parents=True, exist_ok=True)
    packed = np.packbits(observed, axis=1)  # one bit per day, per cell
    chunks: dict[str, dict] = defaultdict(lambda: {"patterns": [], "_pat": {}, "cells": {}})
    for i in range(len(net)):
        r, c = int(rows_i[i]), int(cols_i[i])
        ch = chunks[f"{r // CHUNK}_{c // CHUNK}"]
        pat = base64.b64encode(packed[i].tobytes()).decode()
        pi = ch["_pat"].get(pat)
        if pi is None:
            pi = ch["_pat"][pat] = len(ch["patterns"])
            ch["patterns"].append(pat)
        entry: list = [pi]
        for d, km2 in areas.get(i, ()):
            entry += [d, km2]
        ch["cells"][f"{r}_{c}"] = entry

    sizes = []
    for name, ch in chunks.items():
        path = args.out / f"{name}.json"
        path.write_text(json.dumps({"patterns": ch["patterns"], "cells": ch["cells"]}, separators=(",", ":")))
        sizes.append(path.stat().st_size)
    grid = {"x0": x0, "y0": y0, "cell": cell, "cols": ncols, "rows": nrows, "chunk": CHUNK,
            "chunks": sorted(chunks), "dates": dates}
    (args.out / "grid.json").write_text(json.dumps(grid, separators=(",", ":")))

    with_algae = len(areas)
    print(f"done in {time.time() - t0:.0f}s: {len(chunks)} blocks, median {sorted(sizes)[len(sizes) // 2] / 1e3:.0f} kB, "
          f"max {max(sizes) / 1e3:.0f} kB, total {sum(sizes) / 1e6:.1f} MB; "
          f"{with_algae} cells had algae on at least one day")


if __name__ == "__main__":
    main()
