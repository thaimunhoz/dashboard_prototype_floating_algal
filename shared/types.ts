/** One row of the daily summary: bloom area and patch count for a date. */
export interface DaySummary {
  /** ISO date, YYYY-MM-DD. */
  date: string
  /** Total mask area in km², or null when not yet computed. */
  area_km2: number | null
  /** Number of mask polygons, or null when not yet computed. */
  patches: number | null
}

export interface SummaryResponse {
  region: string
  /** [west, south, east, north] in WGS84, when known. */
  bbox: [number, number, number, number] | null
  /** True when areas came from summary.json; false when only dates were listed. */
  hasAreas: boolean
  days: DaySummary[]
}
