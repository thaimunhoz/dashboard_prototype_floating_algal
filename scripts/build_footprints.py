"""Region footprints for the dashboard's region detection (shared/footprints.json).

Each region's footprint is the union of its Sentinel-2 tiles, simplified. The map shows the
region whose footprint contains the map centre (after regions that use a priority box, such as
the Caribbean; see shared/regions.ts). The continental tile lists don't share tiles, so the
footprints split overlapping regions (e.g. North and South America) along the tile boundary.

Usage (conda base env):
    python scripts/build_footprints.py europe=Z:/.../S2_Europe.shp \
        north-america=Z:/.../S2_North_America.shp south-america=Z:/.../S2_South_America.shp
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import geopandas as gpd
import shapely

SIMPLIFY_DEG = 0.1  # only used to decide which region the map centre is in
OUT = Path(__file__).resolve().parent.parent / "shared" / "footprints.json"


def main() -> None:
    pairs = [a.split("=", 1) for a in sys.argv[1:]]
    if not pairs or any(len(p) != 2 for p in pairs):
        print(__doc__)
        sys.exit(1)
    out = {}
    for region, path in pairs:
        tiles = gpd.read_file(path).to_crs(4326)
        shape = shapely.union_all(shapely.force_2d(tiles.geometry.values))
        shape = shapely.set_precision(shapely.simplify(shape, SIMPLIFY_DEG, preserve_topology=True), 1e-3)
        polys = [p for p in shapely.get_parts(shape) if p.geom_type == "Polygon" and not p.is_empty]
        geom = shapely.geometry.mapping(shapely.MultiPolygon(polys))
        out[region] = {"type": "MultiPolygon", "coordinates": geom["coordinates"]}
        print(f"{region}: {len(tiles)} tiles -> {len(polys)} polygons, "
              f"{sum(len(p.exterior.coords) for p in polys)} vertices")
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
