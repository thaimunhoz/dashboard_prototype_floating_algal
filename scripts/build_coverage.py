"""Daily observation coverage, expressed on the Sentinel-2 tile grid.

A day's masks only say something where a scene was acquired, so an empty area can
mean "not observed" rather than "no algae". This script records, per day, which
Sentinel-2 tiles were observed by Sentinel-2 and which parts of them were
observed by Landsat (Landsat WRS-2 footprints are split along the S2 grid).

Observation = a scene exists for that tile/path-row on that date (from the
inference file names). The rasters have no nodata band, so clouds and swath
edges inside a scene are not excluded.

Usage (conda base env has geopandas/shapely):
    python scripts/build_coverage.py --out data/coverage \
        --s2-tiles E:/post_processing/DATASET/shapefiles/Sentinel_tiles_Caribbean_Sea.shp \
        --s2-dir   E:/post_processing/DATASET/Caribbean_Sentinel_inferences \
        --ls-tiles E:/post_processing/DATASET/shapefiles/Landsat_tiles_Caribbean_Sea.shp \
        --ls-dir   E:/post_processing/DATASET/Caribbean_Landsat_inferences

Output (upload under <MASK_PREFIX>coverage/):
    <out>/2025-01-13.geojson  features:
        {kind: "observed"}                     merged observed area (fill)
        {kind: "tile", tile, sensors}          S2 tile (or its Landsat-covered part) outlines
    <out>/summary.json        {days: {date: {s2_tiles, landsat_scenes, tiles, observed_km2}}}
"""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import geopandas as gpd
import shapely

EQUAL_AREA = "EPSG:6933"
PRECISION = 1e-4  # ~10 m; keeps the GeoJSON small
S2_RE = re.compile(r"^S2[ABC]_MSIL2A_(\d{4})(\d{2})(\d{2})T\d+_.*_T(\w{5})_.*_refined\.tif$")
LS_RE = re.compile(r"^L[COT]0[89]_L2SP_(\d{3})(\d{3})_(\d{4})(\d{2})(\d{2})_.*_refined\.tif$")


def scan(root: Path, pattern: re.Pattern, parse) -> dict[str, set[str]]:
    """date -> set of tile/scene ids with an inference that day."""
    out: dict[str, set[str]] = defaultdict(set)
    for f in root.rglob("*_refined.tif"):
        m = pattern.match(f.name)
        if m:
            date, tile = parse(m)
            out[date].add(tile)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--s2-tiles", type=Path, required=True)
    ap.add_argument("--s2-dir", type=Path, required=True)
    ap.add_argument("--ls-tiles", type=Path, required=True)
    ap.add_argument("--ls-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("data/coverage"))
    args = ap.parse_args()

    s2 = gpd.read_file(args.s2_tiles).to_crs(4326)[["Name", "geometry"]].rename(columns={"Name": "tile"})
    s2["geometry"] = shapely.force_2d(s2.geometry.values)  # the tile shapefiles carry a useless Z
    ls = gpd.read_file(args.ls_tiles).to_crs(4326)[["Name", "geometry"]].rename(columns={"Name": "scene"})
    ls["geometry"] = shapely.force_2d(ls.geometry.values)

    # Landsat footprints split along the S2 grid: one piece per (scene, S2 tile).
    pieces = gpd.overlay(ls, s2, how="intersection", keep_geom_type=True)
    ls_pieces: dict[str, list[tuple[str, object]]] = defaultdict(list)
    for scene, tile, geom in zip(pieces["scene"], pieces["tile"], pieces.geometry):
        ls_pieces[scene].append((tile, geom))
    s2_geom = dict(zip(s2["tile"], s2.geometry))
    print(f"{len(s2)} S2 tiles, {len(ls)} Landsat scenes -> {len(pieces)} Landsat pieces on the S2 grid")

    s2_days = scan(args.s2_dir, S2_RE, lambda m: (f"{m[1]}-{m[2]}-{m[3]}", m[4]))
    ls_days = scan(args.ls_dir, LS_RE, lambda m: (f"{m[3]}-{m[4]}-{m[5]}", f"{int(m[1])}_{int(m[2])}"))
    missing = {t for d in s2_days.values() for t in d} - s2_geom.keys()
    missing |= {s for d in ls_days.values() for s in d} - ls_pieces.keys()
    if missing:
        print(f"warning: no footprint for {sorted(missing)[:10]}{'...' if len(missing) > 10 else ''}")

    args.out.mkdir(parents=True, exist_ok=True)
    summary = {}
    for date in sorted(set(s2_days) | set(ls_days)):
        # Per S2 tile: the geometry observed that day and which sensors saw it.
        tiles: dict[str, dict] = {}
        for t in s2_days.get(date, ()):
            if t in s2_geom:
                tiles[t] = {"geoms": [s2_geom[t]], "sensors": {"S2"}}
        for scene in ls_days.get(date, ()):
            for t, g in ls_pieces.get(scene, ()):
                entry = tiles.setdefault(t, {"geoms": [], "sensors": set()})
                entry["sensors"].add("Landsat")
                if "S2" not in entry["sensors"]:  # S2 already covers the whole tile
                    entry["geoms"].append(g)

        features = []
        tile_geoms = []
        for t, e in sorted(tiles.items()):
            g = shapely.set_precision(shapely.union_all(e["geoms"]), PRECISION)
            if g.is_empty:
                continue
            tile_geoms.append(g)
            features.append({"type": "Feature", "properties": {
                "kind": "tile", "tile": t, "sensors": "+".join(sorted(e["sensors"], reverse=True))},
                "geometry": shapely.geometry.mapping(g)})
        observed = shapely.set_precision(shapely.union_all(tile_geoms), PRECISION) if tile_geoms else None
        if observed is not None and not observed.is_empty:
            features.insert(0, {"type": "Feature", "properties": {"kind": "observed"},
                                "geometry": shapely.geometry.mapping(observed)})
        km2 = float(gpd.GeoSeries([observed], crs=4326).to_crs(EQUAL_AREA).area.iloc[0] / 1e6) if observed else 0.0

        (args.out / f"{date}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}))
        summary[date] = {"s2_tiles": len(s2_days.get(date, ())), "landsat_scenes": len(ls_days.get(date, ())),
                         "tiles": len(tiles), "observed_km2": round(km2)}

    (args.out / "summary.json").write_text(json.dumps({"days": summary}))
    sizes = [f.stat().st_size for f in args.out.glob("*.geojson")]
    print(f"wrote {len(summary)} days to {args.out} "
          f"(median {sorted(sizes)[len(sizes) // 2] / 1e3:.0f} kB, max {max(sizes) / 1e3:.0f} kB per day)")


if __name__ == "__main__":
    main()
