# Mapstructor Template

A generic starting point for building a Mapstructor map.

## Quick setup

1. Get a [Mapbox token](https://account.mapbox.com/access-tokens/) and paste it into `js/mapbox-token.js`
2. Edit the files in `js/lists/` to configure your map (see below)
3. Open `index.html` in a browser

## Configuration files (`js/lists/`)

| File | What it controls |
|------|-----------------|
| `header.js` | Site title, description, logo link, analytics ID, header buttons, zoom buttons |
| `mapData.js` | Base map styles, map center and zoom level |
| `mapbox-token.js` | Your Mapbox access token |
| `layersList.js` | Map layers — what data appears on the map |
| `sliderDates.js` | Timeline slider start and end dates |
| `modalinfo.js` | Content for the About modal |
| `bounds.js` | Named geographic bounds used by zoom buttons |

## Engine files (`js/engine/`)

These files power the map and generally do not need to be edited.
