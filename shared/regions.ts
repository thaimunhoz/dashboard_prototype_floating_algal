/** Regions shown in the atlas. Each lives in its own folder of the R2 bucket with the same layout:
 *  <prefix>summary.json, <prefix><date>/<date>.shp, <prefix>composites/, coverage/, cells/.
 *
 *  Which region the map shows (src/components/MapView.vue, regionAt):
 *   1. a region marked `priority` whose box contains the map centre (the Caribbean wins inside its
 *      box over the wider North and South America datasets, which also cover it);
 *   2. otherwise the region whose Sentinel-2 tile footprint contains the centre
 *      (shared/footprints.json, from scripts/build_footprints.py; continents share no tiles);
 *   3. otherwise (open ocean, inland) the current region if its box contains the centre,
 *      else the region in view whose box centre is nearest. */
export const REGIONS = [
  {
    id: 'caribbean',
    name: 'Caribbean Sea',
    prefix: 'caribbea-sea-masks/',
    /** [west, south, east, north] of the masks, for the initial view and region detection. */
    bbox: [-88.9, 7.77, -58.75, 27.09],
    priority: true,
  },
  {
    id: 'europe',
    name: 'Europe',
    prefix: 'europe-masks-2025/',
    bbox: [-13.91, 32.6, 41.36, 62.25],
    priority: false,
  },
  {
    id: 'north-america',
    name: 'North America',
    prefix: 'north-america-masks-2025/',
    bbox: [-150.43, 4.84, -49.66, 62.26],
    priority: false,
  },
  {
    id: 'south-america',
    name: 'South America',
    prefix: 'south-america-masks-2025/',
    bbox: [-82.1, -55.98, -34.74, 14.47],
    priority: false,
  },
] as const satisfies readonly {
  id: string
  name: string
  prefix: string
  bbox: readonly [number, number, number, number]
  priority: boolean
}[]

export type RegionId = (typeof REGIONS)[number]['id']
export type Region = (typeof REGIONS)[number]

export const DEFAULT_REGION: RegionId = 'caribbean'

export function getRegion(id: string | null | undefined): Region | undefined {
  return REGIONS.find((r) => r.id === id)
}
