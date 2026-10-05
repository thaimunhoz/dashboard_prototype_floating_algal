/** Regions shown in the atlas. Each lives in its own folder of the R2 bucket with the same layout:
 *  <prefix>summary.json, <prefix><date>/<date>.shp, <prefix>composites/, coverage/, cells/.
 *  Order matters where boxes overlap: the map shows the first region whose box contains the map
 *  centre, so the Caribbean (listed first) wins inside its box over the wider North America. */
export const REGIONS = [
  {
    id: 'caribbean',
    name: 'Caribbean Sea',
    prefix: 'caribbea-sea-masks/',
    /** [west, south, east, north] of the masks, for the initial view and region detection. */
    bbox: [-88.9, 7.77, -58.75, 27.09],
  },
  {
    id: 'europe',
    name: 'Europe',
    prefix: 'europe-masks-2025/',
    bbox: [-13.91, 32.6, 41.36, 62.25],
  },
  {
    id: 'north-america',
    name: 'North America',
    prefix: 'north-america-masks-2025/',
    bbox: [-150.43, 4.84, -49.66, 62.26],
  },
] as const satisfies readonly { id: string; name: string; prefix: string; bbox: readonly [number, number, number, number] }[]

export type RegionId = (typeof REGIONS)[number]['id']
export type Region = (typeof REGIONS)[number]

export const DEFAULT_REGION: RegionId = 'caribbean'

export function getRegion(id: string | null | undefined): Region | undefined {
  return REGIONS.find((r) => r.id === id)
}
