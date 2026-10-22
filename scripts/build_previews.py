"""True-colour WebP previews of the AQUAVis scenes behind the dashboard's masks.

For every scene (one exported GeoTIFF per Sentinel-2 tile or Landsat path/row and date) this writes a
small RGBA WebP (longest side --size px, no-data transparent) and records where it sits on the map,
so the dashboard can draw it under the masks of that day.

Bands in the exports: 1 = blue (B02), 2 = green (B03), 3 = red (B04), 4 = NIR, int16 reflectance x 10000.
Contrast: by default each image is stretched on its own (1st-95th percentile of its water pixels, i.e. low
NIR, one stretch shared by R, G and B so colours stay natural, at least 0.06 reflectance wide, gamma 1.4),
because water is dark and a fixed stretch leaves it nearly black; --fixed-stretch uses the same stretch
for every scene instead.
The exports already mask land, clouds and glint as no-data; those areas are transparent in the previews.

Usage (an environment with rasterio + Pillow, e.g. conda env dl_bloom_env):
    # a whole continent, Sentinel-2 then Landsat (tile lists from the continent shapefiles)
    python scripts/build_previews.py --continent europe
    python scripts/build_previews.py --continent africa --sensor landsat
    python scripts/build_previews.py --continent all          # every continent + the Caribbean
    # single tiles, e.g. to check the result
    python scripts/build_previews.py --sensor sentinel --tiles 19QDA 19QEA
    python scripts/build_previews.py --sensor landsat --tiles 191_20
Stopping (Ctrl+C) and re-running is safe: finished previews are skipped and the index keeps them.

Output (default Z:/guser/tml/global_model/PROTOTYPE/prototype_v2/previews_truecolor; change with --out;
re-running skips previews that already exist):
    <out>/<sensor>/<tile>/<scene>.webp
    <out>/<sensor>/<tile>/index.json   {"<scene>": {"date", "corners": [[lon, lat] x4: TL, TR, BR, BL], "size"}}
    <out>/failed.txt                   scenes that could not be read
"""
from __future__ import annotations

import argparse
import json
import re
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.warp import transform as warp_transform

EXPORTS = Path("Z:/guser/tml/global_model/PROTOTYPE/prototype_v2/AQUAVis_dataset")
OUT_DIR = Path("Z:/guser/tml/global_model/PROTOTYPE/prototype_v2/previews_truecolor")
SENSOR_DIR = {"sentinel": "sentinel_exports", "landsat": "landsat_exports"}
RGB_BANDS = [3, 2, 1]  # red, green, blue
NIR_BAND = 4
WATER_NIR_MAX = 800  # reflectance x 10000 (0.08): below this a pixel counts as water for the auto-contrast;
# high enough to keep bloom-covered water, low enough to leave out land, snow and clouds
P_LOW, P_HIGH = 1, 95  # auto-contrast (default): per-image percentiles of the water pixels, three bands pooled
MIN_RANGE = 600  # auto-contrast: stretch at least 0.06 reflectance wide...
AUTO_GAMMA = 1.4  # ...and lift the dark tones
STRETCH_MAX = 3000  # --fixed-stretch: reflectance x 10000 shown as full brightness (0.30), same for all scenes
GAMMA = 1.8
WEBP_QUALITY = 80
# Full scene names only, so side files in the export folders (e.g. ..._cloud_mask.tif) are skipped.
S2_DATE = re.compile(r"^S2[ABC]_MSIL2A_(\d{4})(\d{2})(\d{2})T\d{6}_(?:N\d{4}_)?R\d{3}_T\w{5}_\d{8}T\d{6}$")
LS_DATE = re.compile(r"^L[COT]0[89]_L2SP_\d{6}_(\d{4})(\d{2})(\d{2})_(?:\d{8}_)?\d{2}_(?:T1|T2|RT)$")


def scene_date(name: str, sensor: str) -> str | None:
    m = (S2_DATE if sensor == "sentinel" else LS_DATE).match(name)
    return f"{m[1]}-{m[2]}-{m[3]}" if m else None


def make_preview(src: Path, dst: Path, size: int, auto_contrast: bool = True) -> dict:
    """Write one WebP; return its index entry (date filled in by the caller)."""
    with rasterio.open(src) as r:
        scale = size / max(r.width, r.height)
        out_h, out_w = max(1, round(r.height * scale)), max(1, round(r.width * scale))
        # masked=True carries the no-data mask through the downsampling
        bands = r.read(RGB_BANDS + [NIR_BAND], out_shape=(4, out_h, out_w), resampling=Resampling.average, masked=True)
        # Map position: the four corners of the raster, in lon/lat (TL, TR, BR, BL, as MapLibre wants)
        left, bottom, right, top = r.bounds
        xs, ys = warp_transform(r.crs, "EPSG:4326", [left, right, right, left], [top, top, bottom, bottom])

    rgb = bands[:3]
    valid = ~np.ma.getmaskarray(rgb).any(axis=0)
    data = np.ma.filled(rgb, 0).astype("float32")
    nir = np.ma.filled(bands[3], 10000).astype("float32")
    stretch = None
    if auto_contrast and valid.sum() >= 100:
        # Per-image stretch, shared by the three bands so colours stay natural (a per-band stretch
        # turned water purple and exaggerated detector stripes). The statistics come from water only
        # (low NIR): some exports leave land, snow or clouds unmasked, and those would set the top of
        # the stretch and leave the sea nearly black. Bright land then saturates, which is fine.
        water = valid & (nir < WATER_NIR_MAX)
        sample = water if water.sum() >= 1000 else valid
        pooled = data[:, sample]
        lo, hi = float(np.percentile(pooled, P_LOW)), float(np.percentile(pooled, P_HIGH))
        # Water spans a narrow range; stretching it all the way exaggerates colour casts (clear water
        # turned neon green), so the range is at least MIN_RANGE and a gamma lifts the dark tones.
        hi = max(hi, lo + MIN_RANGE)
        img = np.clip((data - lo) / (hi - lo), 0, 1) ** (1 / AUTO_GAMMA)
        stretch = [int(lo), int(hi)]
    else:
        img = np.clip(data / STRETCH_MAX, 0, 1) ** (1 / GAMMA)
    rgba = np.dstack([(img * 255).round().astype("uint8").transpose(1, 2, 0), (valid * 255).astype("uint8")])
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp")
    Image.fromarray(rgba, "RGBA").save(tmp, "WEBP", quality=WEBP_QUALITY, method=4)
    tmp.replace(dst)  # only complete files get the final name, so an interrupted run never leaves a broken one
    entry = {
        "corners": [[round(x, 6), round(y, 6)] for x, y in zip(xs, ys)],
        "size": [out_w, out_h],
        "valid": round(float(valid.mean()), 3),
    }
    if stretch:
        entry["stretch"] = stretch  # [low, high] reflectance x 10000, shared by R, G, B
    return entry


def job(src: str, dst: str, size: int, auto_contrast: bool) -> tuple[str, dict | None, str | None]:
    try:
        return src, make_preview(Path(src), Path(dst), size, auto_contrast), None
    except Exception as e:  # noqa: BLE001 - logged and reported, the run goes on
        return src, None, f"{type(e).__name__}: {e}"


# Tile lists per continent (the same shapefiles as the dashboard regions); "Name" holds the
# Sentinel-2 tile or Landsat path_row, matching the export folder names.
CONTINENTS_DIR = "Z:/guser/tml/global_model/data_management/shapefiles/continents"
CONTINENTS = {
    "europe": ("S2_Europe", "L89_Europe"),
    "north-america": ("S2_North_America", "L89_North_America"),
    "south-america": ("S2_South_America", "L89_South_America"),
    "asia": ("S2_Asia", "L89_Asia"),
    "africa": ("S2_Africa", "L89_Africa"),
    "oceania": ("S2_Oceania", "L89_Oceania"),
    # the Caribbean region's own tile lists (its tiles may also be in the Americas' lists;
    # previews already made are skipped)
    "caribbean": ("E:/post_processing/DATASET/shapefiles/Sentinel_tiles_Caribbean_Sea",
                  "E:/post_processing/DATASET/shapefiles/Landsat_tiles_Caribbean_Sea"),
}


def tile_names(shapefile: str | Path, column: str = "Name") -> list[str]:
    """The tile names in a shapefile's attribute table, read straight from its .dbf (no geopandas needed)."""
    import struct

    data = Path(shapefile).with_suffix(".dbf").read_bytes()
    n_records, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields, offset, pos = [], 1, 32  # each record starts with a 1-byte deletion flag
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0")[0].decode("latin-1")
        fields.append((name, offset, data[pos + 16]))
        offset += data[pos + 16]
        pos += 32
    match = [f for f in fields if f[0].lower() == column.lower()]
    if not match:
        raise ValueError(f"{shapefile}: no '{column}' column (has {[f[0] for f in fields]})")
    _, start, width = match[0]
    names = []
    for i in range(n_records):
        rec = header_len + i * record_len
        if data[rec:rec + 1] == b"*":  # deleted record
            continue
        names.append(data[rec + start:rec + start + width].decode("latin-1").strip())
    return names


def continent_shapefile(name: str) -> str:
    return f"{name}.shp" if "/" in name else f"{CONTINENTS_DIR}/{name}.shp"


def run_sensor(args, sensor: str, tiles: list[str], label: str) -> None:
    root = args.exports / SENSOR_DIR[sensor]
    todo, indexes, skipped, missing = [], {}, 0, []
    for tile in dict.fromkeys(tiles):
        folder = root / tile
        if not folder.is_dir():
            missing.append(tile)
            continue
        out_dir = args.out / sensor / tile
        index_path = out_dir / "index.json"
        index = json.loads(index_path.read_text()) if index_path.exists() else {}
        indexes[tile] = (index_path, index)
        for f in sorted(folder.glob("*.tif")):
            date = scene_date(f.stem, sensor)
            if not date or not date.startswith(args.year):
                continue
            dst = out_dir / f"{f.stem}.webp"
            if not args.overwrite and dst.exists() and f.stem in index:
                skipped += 1
                continue
            todo.append((tile, f, dst, date))

    print(f"\n[{label} / {sensor}] {len(indexes)} tiles, {len(todo)} previews to make, {skipped} already done"
          f"{f', {len(missing)} tiles without exports' if missing else ''}", flush=True)
    if not todo:
        return
    args.out.mkdir(parents=True, exist_ok=True)
    failed_log = args.out / "failed.txt"
    every = 10 if len(todo) < 1000 else 200

    t0 = time.time()
    done = failed = 0
    by_src = {str(f): (tile, date) for tile, f, _, date in todo}
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(job, str(f), str(dst), args.size, not args.fixed_stretch) for _, f, dst, _ in todo]
        for fut in as_completed(futures):
            src, entry, err = fut.result()
            tile, date = by_src[src]
            done += 1
            if err:
                failed += 1
                with failed_log.open("a") as log:
                    log.write(f"{src}\t{err}\n")
                print(f"  failed {Path(src).name}: {err}", flush=True)
            else:
                index_path, index = indexes[tile]
                index[Path(src).stem] = {"date": date, **entry}
                # write the index as we go, so an interrupted run keeps what it finished
                index_path.write_text(json.dumps(dict(sorted(index.items())), separators=(",", ":")))
            if done % every == 0 or done == len(todo):
                rate = (time.time() - t0) / done
                left = rate * (len(todo) - done) / 3600
                print(f"  {done}/{len(todo)}  {rate:.2f} s/scene, ~{left:.1f} h left", flush=True)

    sizes = [p.stat().st_size for tile in indexes for p in (args.out / sensor / tile).glob("*.webp")]
    print(f"[{label} / {sensor}] done in {(time.time() - t0) / 3600:.1f} h: {len(sizes)} previews"
          f"{f', {failed} failed (see {failed_log})' if failed else ''}, total {sum(sizes) / 1e9:.2f} GB", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--continent", nargs="*", choices=[*CONTINENTS, "all"],
                    help="every tile of these continents, both sensors unless --sensor is given")
    ap.add_argument("--sensor", choices=["sentinel", "landsat"], help="required with --tiles / --tiles-from")
    ap.add_argument("--tiles", nargs="*", default=[], help="tile / path_row folder names, e.g. 19QDA or 100_16")
    ap.add_argument("--tiles-from", type=Path, help="tile shapefile; its Name column lists the tiles")
    ap.add_argument("--year", default="2025")
    ap.add_argument("--size", type=int, default=1024, help="longest side in pixels")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--exports", type=Path, default=EXPORTS)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--fixed-stretch", action="store_true",
                    help="same stretch for every scene instead of per-image auto-contrast")
    ap.add_argument("--overwrite", action="store_true", help="redo previews that already exist")
    args = ap.parse_args()

    runs: list[tuple[str, str, list[str]]] = []  # (label, sensor, tiles)
    if args.continent:
        names = list(CONTINENTS) if "all" in args.continent else args.continent
        for name in names:
            s2, ls = CONTINENTS[name]
            if args.sensor in (None, "sentinel"):
                runs.append((name, "sentinel", tile_names(continent_shapefile(s2))))
            if args.sensor in (None, "landsat"):
                runs.append((name, "landsat", tile_names(continent_shapefile(ls))))
    if args.tiles or args.tiles_from:
        if not args.sensor:
            ap.error("--tiles / --tiles-from need --sensor")
        tiles = list(args.tiles) + (tile_names(args.tiles_from) if args.tiles_from else [])
        runs.append(("tiles", args.sensor, tiles))
    if not runs:
        ap.error("give --continent, or --sensor with --tiles / --tiles-from")

    for label, sensor, tiles in runs:
        run_sensor(args, sensor, tiles, label)


if __name__ == "__main__":
    main()
