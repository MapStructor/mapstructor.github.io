# Mapstructor Template — Claude Instructions

## On first conversation

Before doing anything else, ask the user:

> "What do you want to use Mapstructor for? Go into as much detail as you want — the place you're mapping, the kind of data you have, what you'd like people to be able to do with the map."

Use their answer to guide everything that follows.

---

## What this project is

Mapstructor is a Mapbox GL JS map template with a timeline slider, before/after swipe comparison, layer sidebar, and optional info panels connected to an encyclopedia. It is meant to be configured entirely through the files in `js/lists/` — the engine files in `js/engine/` generally do not need to be touched.

---

## Project structure

### Configure these (`js/lists/`)

| File | What it controls |
|------|-----------------|
| `header.js` | Site title, branding, analytics, header buttons, zoom buttons |
| `mapData.js` | Base map styles, map center and zoom |
| `mapbox-token.js` | Mapbox access token — gitignored, never commit |
| `layersList.js` | All map layers — the main thing users will edit |
| `sliderDates.js` | Timeline start and end dates |
| `modalinfo.js` | About modal and layer info modal content |
| `bounds.js` | Named geographic bounds for zoom buttons |

### Do not edit these unless removing components (`js/engine/`)

`mapinit.js`, `infoPanel.js`, `addLayers.js`, `addMapLayer.js`, `generateLayers.js`, `generateMaps.js`, `refreshLayers.js`, `eventsHandle.js`, `sliderpopups.js`, `index.js`, `utils.js`, `handle-mobile-devices.js`, `google-analytics.js`

---

## Adding layers

Layers go in the `layers` array in `js/lists/layersList.js`. The file has commented-out examples for all supported types: standalone layer, group, section, and info panel layer.

Each layer needs:
- A Mapbox tileset URL: `mapbox://USERNAME.TILESET_ID`
- A `"source-layer"` name (found in Mapbox Studio)
- A Mapbox layer `type`: `"line"`, `"fill"`, or `"circle"`
- A `paint` block matching the type

If a layer has an `infoId`, add a matching entry in `modalinfo.js`.

---

## Removing components

Full removal instructions are in `README.md` section 6. The components that can be removed are:
- Google Analytics
- Disclaimer overlay
- Header
- Timeline / slider
- Layer sidebar
- Info panel
- Swipe / compare panel (requires engine refactor — use Claude)

---

## Key things to know

- The map works via `file://` — no server needed
- `js/mapbox-token.js` is gitignored — the user must copy it manually to any new folder
- The template uses two side-by-side maps (`beforeMap`, `afterMap`) controlled by `mapboxgl.Compare` — this is the swipe comparison
- Layer visibility is controlled by date filtering — each feature needs `DayStart` and `DayEnd` properties in the tileset for the timeline to affect it
- The info panel requires a Drupal encyclopedia endpoint — if the user has no encyclopedia, remove `panel` configs from layers
- `ahm_twin/` in the same folder is a working example (Ames History Museum) — refer to it when the user needs to see how something is done in practice
