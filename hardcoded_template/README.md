# Mapstructor Template

## What is Mapstructor?

Mapstructor is a tool for building interactive maps that show how a place changed over time.

Imagine being able to look at your town the way it looked in 1920, then slide a bar and watch buildings appear, roads extend, and neighborhoods grow all the way up to the present. That is what a Mapstructor map does.

The map has four main parts:

- **A split screen** — the map is divided left and right, each side showing a different view (for example, a satellite image on the left and a street map on the right). You can drag a divider in the middle to compare them.
- **A timeline slider** — a bar at the bottom that you drag to move through time. As you slide it, things appear and disappear on the map based on when they existed.
- **A layers panel** — a list on the left where you can turn different datasets on and off, like toggling between showing roads, buildings, property boundaries, and so on.
- **Info panels** — click on something on the map and a panel opens with details about it, connected to a database or encyclopedia you provide.

**Who is this for?** Anyone who wants to build a web map. Mapstructor specializes in maps that show change over time — making it especially useful for historians, libraries, museums, universities, researchers, and community organizations — but it can be used for any kind of geographic data you want to share publicly.

**What is this template?** This is the map already built — the full working application, with no data in it yet. You fill it in with your own place, your own data, your own branding. The result is a fully functional, publishable interactive map. No prior experience required.

---

## Table of Contents

- [How to build your map](#how-to-build-your-map)

1. [What is this?](#1-what-is-this)
2. [What you need](#2-what-you-need)
3. [Using Claude to set this up](#3-using-claude-to-set-this-up)
4. [Quick start](#4-quick-start)
5. [Configuration files](#5-configuration-files)
   - [mapbox-token.js](#mapbox-tokenjs)
   - [header.js](#headerjs)
   - [mapData.js](#mapdatajs)
   - [layersList.js](#layerslistjs)
   - [modalinfo.js](#modalinfojs)
   - [sliderDates.js](#sliderdatesjs)
   - [bounds.js](#boundsjs)
   - [icons/](#icons)
   - [index.html](#indexhtml)
6. [Removing optional components](#6-removing-optional-components)
   - [Google Analytics](#google-analytics)
   - [Disclaimer overlay](#disclaimer-overlay)
   - [Header](#header)
   - [Timeline / slider](#timeline--slider)
   - [Layer sidebar](#layer-sidebar)
   - [Info panel](#info-panel)
   - [Swipe / compare panel](#swipe--compare-panel)
7. [Engine files reference](#7-engine-files-reference)

---

## How to set up your map

This template is a folder of files. Setting it up means opening those files in a text editor, replacing placeholder values with your own, and then opening the map in a browser to see the result. No coding experience is required — the files are written to be readable, and you are mostly filling in blanks.

A **text editor** is a program for editing plain text files. [VS Code](https://code.visualstudio.com/) is free and recommended. If you are using Claude Code, it handles the editing for you.

**Step 1 — Get the template**
Fork or download this repository from GitHub. Forking creates your own copy of the project under your GitHub account, which makes it easy to publish later with GitHub Pages and track your changes over time. To fork, click the **Fork** button at the top of the repository page on GitHub. Then clone your fork to your computer, or open it directly in Claude Code.

If you just want to try it out locally, you can also download it as a ZIP file (click **Code → Download ZIP** on GitHub) and unzip it anywhere on your computer.

**Step 2 — Open the folder**
Open this template folder in your text editor or in Claude Code.

**Step 3 — Add your Mapbox token**
Open `project/secrets/mapbox-token.js`. Replace `YOUR_MAPBOX_TOKEN` with your actual token. Save the file. This is what allows the map to load.

**Step 4 — Set your map title and branding**
Open `project/lists/header.js`. Replace the placeholder values — your site title, description, logo link, and analytics ID (if you have one).

**Step 5 — Set your map's starting view**
Open `project/lists/mapData.js`. Set the `center` (the longitude and latitude where the map opens) and `zoom` level. Your Mapbox Studio style ID also goes here if you have a custom style.

**Step 6 — Add your layers**
Open `project/lists/layersList.js`. This is the main file you will edit. It contains commented-out examples — copy one of the examples, uncomment it, and fill in your tileset URL and source layer name (both found in Mapbox Studio). Repeat for each dataset you want to show on the map.

**Step 7 — Set your timeline dates**
Open `project/lists/sliderDates.js`. Set the start and end dates to match your data's time range.

**Step 8 — Write your About text**
Open `project/lists/modalinfo.js`. Replace the placeholder About text with a description of your map.

**Step 9 — Open the map**
Open `index.html` in a web browser (double-click it, or drag it into a browser window). No server or internet connection is required to run it locally. If the map loads and your layers appear, you are done.

**Step 10 — Publish**
Copy the entire folder to any web host — GitHub Pages, Netlify, Vercel, or any web server. The map will work the same way online as it does on your computer.

---

## 1. What is this?

Mapstructor is a web-based interactive map that lets people explore a place across time.

Here is what the map looks like and what it does:

- **Split screen** — the screen is divided left and right, each showing a different map style (for example, satellite imagery on the left and a street map on the right). A draggable divider in the middle lets you swipe between them to compare.
- **Timeline slider** — a slider at the bottom lets you move through time. As you slide, layers on the map appear and disappear based on their historical dates — you can watch a city grow, buildings appear, roads extend.
- **Layer sidebar** — a panel on the left lists all the data layers available. You can turn layers on and off, zoom to them, and read information about them.
- **Info panels** — clicking on a feature on the map (like a building or a property boundary) can open a side panel with detailed encyclopedia-style information about that feature.

This template is a clean, empty starting point. It has no data layers or map styles of your own yet — just the framework. You fill in your own data.

---

## 2. What you need

- A **Mapbox account** (free) — [mapbox.com](https://www.mapbox.com). Mapbox provides the maps, satellite imagery, and the tools to upload your own data.
- A **text editor** — any editor works. [VS Code](https://code.visualstudio.com/) is recommended.
- A **web browser** — the map opens directly as a file. No server or special software needed.

Optional but helpful:
- **QGIS** (free) — for preparing and exporting geographic data to upload to Mapbox.
- **Claude** — see below.

---

## 3. Using Claude Code to set this up

This template can be used with [Claude Code](https://claude.ai/code), Anthropic's AI coding tool (available as a desktop app and VS Code extension).

Claude Code can read all of these files and help you:

- Replace placeholder values with your own content
- Add layers based on your Mapbox tileset URLs
- Write info panel layouts
- Remove components you don't need
- Debug issues

You can describe what you want in plain English — for example: *"Add a layer called Boundaries that shows county lines in blue"* — and Claude Code will make the changes for you.

A `CLAUDE.md` file is included in this repo — Claude Code reads it automatically when you open the project, giving it full context about the Mapstructor template.

---

## 4. Quick start

1. **Get a Mapbox token** — sign up at [mapbox.com](https://www.mapbox.com), go to [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/), and create a token.
2. **Paste your token** into `project/secrets/mapbox-token.js` — replace `YOUR_MAPBOX_TOKEN` with your token.
3. **Open `index.html`** in a browser — the map should load with a world view and no data layers.
4. **Edit the files in `project/lists/`** to add your own content (see below).

The map works directly from your file system — no web server needed.

---

## 5. Configuration files

These are the only files you need to edit for most projects. They live in `project/lists/` and `project/secrets/`.

---

### `mapbox-token.js`

Located in `project/secrets/`. Your Mapbox access token. Get it from [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/).

This file is gitignored — it will never be accidentally committed to a public repository.

```js
const mapboxToken = "YOUR_MAPBOX_TOKEN";
```

---

### `header.js`

Controls the site title, description, branding, analytics, and the buttons in the top-right header.

| Key | What to replace |
|-----|----------------|
| `siteAnalytics.trackingId` | Your Google Analytics measurement ID (e.g. `G-XXXXXXXXXX`) |
| `siteConfig.mapboxUsername` | Your Mapbox username — used to build base map style URLs |
| `siteMeta.title` | Page title shown in the browser tab and social shares |
| `siteMeta.description` | Short description for search engines and social shares |
| `siteMeta.themeColor` | Browser theme/accent color (hex code) |
| `siteMeta.ogImage` | Path to your social share image |
| `siteMeta.ogUrl` | Your site's public URL |
| `siteMeta.ogSiteName` | Site name for social shares |
| `siteMeta.twitterCard` | Twitter card type (use `"summary_large_image"`) |
| `siteMeta.twitterImageAlt` | Alt text for the Twitter share image |
| `siteLogoLink` | URL the header logo links to |
| `siteHeaderText` | Text shown next to the logo |
| `zoomButtons` | Zoom buttons in the sidebar — update `label`, `icon`, and `target` (must match a key in `bounds.js`) |
| `headerButtons` | Buttons in the top-right header — can open a modal (`type: "modal"`) or link to a URL (`type: "link"`) |

---

### `mapData.js`

Controls which base map styles are available in the Maps switcher, and where the map opens.

| Key | What to replace |
|-----|----------------|
| `baseMaps[].id` | Mapbox style ID for each base map (short ID, e.g. `streets-v12`) — combined with `siteConfig.mapboxUsername` from `header.js` |
| `baseMaps[].name` | Display name in the Maps switcher |
| `baseMaps[].lChecked` | `true` if this style should be selected on the left (before) map by default |
| `baseMaps[].rChecked` | `true` if this style should be selected on the right (after) map by default |
| `mapConfig.style` | Full Mapbox style URI for the initial map load (e.g. `mapbox://styles/YOUR_USERNAME/YOUR_STYLE_ID`) |
| `mapConfig.center` | `[longitude, latitude]` — where the map opens |
| `mapConfig.zoom` | Initial zoom level (1 = world, 10 = city, 15 = street level) |

---

### `layersList.js`

The `layers` array defines everything shown in the layer sidebar. It is empty by default. The file contains commented-out examples for all supported structures:

**Standalone layer** — a single layer with optional zoom and info buttons.

**Group** — a collapsible group of related layers shown together under one label.

**Section** — a named divider that organizes groups and standalone layers into categories.

**Info panel layer** — a layer that opens a side panel with encyclopedia data when a feature is clicked.

For each layer, the key values to fill in:

| Key | What to replace |
|-----|----------------|
| `id`, `name` | Unique string identifier (no spaces) |
| `label` | Display name in the sidebar |
| `iconColor` | Hex color for the sidebar icon |
| `iconType` | `"slash"` for lines/railroads, `"square"` for polygons |
| `source.url` | Your Mapbox tileset URL: `mapbox://YOUR_USERNAME.YOUR_TILESET_ID` |
| `"source-layer"` | The source layer name inside your tileset (found in Mapbox Studio) |
| `type` | Mapbox layer type: `"line"`, `"fill"`, or `"circle"` |
| `paint` | Mapbox paint properties (color, width, opacity, etc.) |
| `zoomCenter` | `[lng, lat]` — where the zoom button flies to |
| `zoomLevel` | Zoom level for the zoom button |
| `infoId` | Key that must match an entry in `modalinfo.js` |
| `checked` | `true` if the layer should be on by default |
| `panel.encyclopediaBase` | Base URL of your Drupal encyclopedia site |
| `panel.nidProp` | The feature property that holds the encyclopedia node ID |
| `panel.render` | A function returning the panel HTML — use the `f()` helper to pull field values from the encyclopedia |

---

### `modalinfo.js`

Controls the content of the **About** modal (opened from the header) and any **layer info** modals (opened from the ⓘ button next to a layer).

Each modal needs two entries — a header and HTML content:

```js
modal_header_text["about"] = "ABOUT";
modal_content_html["about"] = `<p>Your description here.</p>`;
```

For layer info modals, the key must match the layer's `infoId` in `layersList.js`:

```js
modal_header_text["my-layer-info"] = "My Layer";
modal_content_html["my-layer-info"] = `<p>Where this data comes from.</p>`;
```

Commented-out examples are included in the file.

---

### `sliderDates.js`

Sets the start and end dates of the timeline slider. Use `MM/DD/YYYY` format.

```js
const sliderStartDate = "01/01/1900";
const sliderEndDate   = "01/01/2025";
```

---

### `bounds.js`

Named geographic bounds used by the zoom buttons defined in `header.js`. Each entry maps a name to a bounding box `[[west, south], [east, north]]`.

Replace `"Region"` with your area name and coordinates, and update the matching `zoomButtons` entry in `header.js`.

```js
const boundsList = {
  "Region": [[-100, 35], [-90, 45]],
  "USA":    [[-125.4, 23.7], [-66.5, 49.9]],
  "World":  [[-179, -59], [135, 77]],
};
```

---

### `icons/`

Located in `project/icons/`.

| File | What it is |
|------|-----------|
| `favicon.ico` | Icon shown in the browser tab |
| `icon.png` | Default app icon |
| `banner_thumbnail.png` | Logo image shown in the header |
| `icon_57x57.png` … `icon_512x512.png` | Sized icons for mobile home screen bookmarks |

Replace these with your own images. The sizes listed in `index.html` are standard Apple/Android home screen icon dimensions.

---

### `index.html`

Most of `index.html` is driven automatically by `header.js`. You generally do not need to edit it. Exceptions:

- `manifest.json` — update with your app name and icons for PWA/home screen support
- The disclaimer overlay (the pop-up shown on first load) — edit or remove it (see below)

---

## 6. Removing optional components

Each component below can be removed independently. Work through the steps in order.

---

### Google Analytics

1. In `index.html`, delete the `<!-- Google Analytics -->` block — the inline `<script>` tag containing `gtag` and the dynamically appended script
2. Delete `<script src="engine/google-analytics.js">` from `index.html`
3. Remove `siteAnalytics` from `header.js`

---

### Disclaimer overlay

In `index.html`, delete the `<!-- Disclaimer -->` block:

```html
<div id="disclaimer-overlay">...</div>
```

---

### Header

1. In `index.html`, delete the `<!-- HEADER -->` block (`div.header` and its children)
2. In `engine/engine.css`, remove header-related styles (`.header`, `.headerText`, `.header-right`, `#logo-img-wide`, `#header-right-buttons`)
3. `siteLogoLink`, `siteHeaderText`, and `headerButtons` in `header.js` become unused — remove them

---

### Timeline / slider

1. In `index.html`, delete:
   - `<div id="datepanel">`
   - `<div id="footer">` (contains the slider and ruler)
2. Remove these `<script>` tags from `index.html`:
   - `project/lists/sliderDates.js`
   - The jQuery UI CDN script
   - The touch-punch CDN script
   - The `moment.js` CDN script
3. Remove the jQuery UI CDN stylesheet link from `index.html`
4. Delete `project/lists/sliderDates.js`
5. In `engine/index.js`, remove the slider initialization block (`$("#slider").slider(...)`) and `sliderStart`/`sliderEnd` variables
6. In `engine/mapinit.js`, remove the `changeDate()` call inside `addLayersToMap`

---

### Layer sidebar

1. In `index.html`, delete:
   - `<button id="view-hide-layer-panel">`
   - `<div id="studioMenu">` and all its children
   - `<div id="mobi-view-sidebar">`
2. Remove these `<script>` tags from `index.html`:
   - `engine/generateLayers.js`
   - `engine/refreshLayers.js`
   - `engine/addMapLayer.js`
   - `engine/addLayers.js`
   - `engine/generateMaps.js`
3. `project/lists/layersList.js`, `bounds.js`, and `mapData.js` become unused — remove them and their script tags

---

### Info panel

1. In `index.html`, delete `<div id="rightInfoBar">`
2. Remove `<script src="engine/infoPanel.js">` from `index.html`
3. Remove any `panel` configs from layers in `layersList.js`

---

### Swipe / compare panel

⚠️ This requires changes to the engine — the entire map is built around two side-by-side maps (`beforeMap` / `afterMap`) controlled by `mapboxgl.Compare`. Removing the swipe means refactoring `mapinit.js` to use a single map.

High-level steps:
1. Replace `<div id="comparison-container">` and its `before`/`after` children with a single `<div id="map" class="map">`
2. Remove `mapbox-gl-compare.js` script and `mapbox-gl-compare.css` link from `index.html`
3. Rewrite `engine/mapinit.js` to create one `mapboxgl.Map` instead of two
4. Update all `beforeMap` / `afterMap` references throughout the engine to use a single `map` variable

Using Claude for this is strongly recommended.

---

## 7. Engine files reference

These files power the map. You generally do not need to edit them unless removing components (see above) or making structural changes.

| File | What it does |
|------|-------------|
| `mapinit.js` | Initializes the before/after maps and swipe comparison |
| `infoPanel.js` | Handles click-to-open info panels connected to an encyclopedia |
| `addLayers.js` | Reads `layersList.js` and adds layers to the map |
| `addMapLayer.js` | Low-level layer addition for both before/after maps |
| `generateLayers.js` | Builds the layer sidebar UI from `layersList.js` |
| `generateMaps.js` | Builds the base map switcher UI from `mapData.js` |
| `refreshLayers.js` | Shows/hides layers based on checkbox state and current date |
| `eventsHandle.js` | Sidebar toggle, mobile behavior, layer click events |
| `sliderpopups.js` | Timeline slider popup labels |
| `index.js` | Page initialization — slider setup, modal triggers, header buttons |
| `utils.js` | Shared utility functions |
| `handle-mobile-devices.js` | Mobile detection and redirect logic |
| `google-analytics.js` | Loads Google Analytics (configured by `header.js`) |
