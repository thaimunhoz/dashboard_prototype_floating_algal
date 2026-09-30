/** Regions shown in the atlas. Each lives in its own folder of the R2 bucket with the same layout:
 *  <prefix>summary.json, <prefix><date>/<date>.shp, <prefix>composites/, coverage/, cells/. */
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
    bbox: [-15.0, 32.45, 41.36, 62.25],
  },
] as const satisfies readonly { id: string; name: string; prefix: string; bbox: readonly [number, number, number, number] }[]

export type RegionId = (typeof REGIONS)[number]['id']
export type Region = (typeof REGIONS)[number]

export const DEFAULT_REGION: RegionId = 'caribbean'

export function getRegion(id: string | null | undefined): Region | undefined {
  return REGIONS.find((r) => r.id === id)
}
