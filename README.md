# AgriView

A browser-based satellite time-series viewer for agricultural and environmental monitoring, powered by the [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/).

## What it does

AgriView lets you click anywhere on the map and instantly see:

- **Sentinel-2 imagery** for that location (True Color or False Color)
- **NDVI time series** — all cloud-masked observations from 2015 to today, plotted as an interactive chart
- **Climate time series** — daily temperature, precipitation, and evapotranspiration from ERA5 (via Open-Meteo), shown as optional layers

## Features

### Map
- Click any point on the globe to open the inspector panel
- Basemap switcher: Satellite, Terrain, Hybrid
- Search by place name or lat/lon coordinates
- Shareable URL — current location and date are encoded in the link

### Inspector panel (right side)
- Opens at 50% of the screen when you click the map
- **Imagery** — zoomable/pannable Sentinel-2 preview tile; palette buttons update the rendering per active layer (True, False, and climate-specific modes)
- **Available scenes** — list of cloud-free Sentinel-2 acquisitions in the selected date range, sorted newest first; clicking a date updates the imagery
- **NDVI time series** — scatter chart with cloud masking applied (SCL classes 3, 7–11 excluded); hover any dot to see the exact date and value

### Layers panel (▤ button)
Toggle additional time series in the inspector:

| Layer | Source | Chart |
|---|---|---|
| Temperature (2 m) | ERA5 / Open-Meteo | Scatter |
| Precipitation | ERA5 / Open-Meteo | Bar |
| Evapotranspiration (ET₀) | ERA5 / Open-Meteo | Scatter |

Each climate chart has palette buttons (3 color options) and a matching imagery card showing the current value on a gradient scale with min/avg/max statistics.

### Date range
Use the date pill in the toolbar to pick a preset range (1 y, 2 y, 5 y, full archive) or enter custom start/end dates. All charts update automatically.

## Data sources

| Data | Provider | Notes |
|---|---|---|
| Sentinel-2 L2A imagery | Microsoft Planetary Computer | Both 2A and 2B satellites |
| Sentinel-2 band statistics | PC TiTiler point API | Used to compute NDVI |
| Climate variables | Open-Meteo archive API | ERA5 reanalysis, daily resolution |
| Geocoding | OpenStreetMap Nominatim | Place name search |

## Running locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Tech stack

Vue 3 · Vite · TypeScript · Leaflet · uPlot · Pinia · Cloudflare Workers (deployment)
