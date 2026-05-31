# Changelog

Stripping log from AHM → generic Mapstructor template.

## Steps completed

- **May 31, 2026 — Remove Firebase** — removed both Firebase script blocks and `firebaseui-auth-container` div from `index.html`
- **May 31, 2026 — Remove draw tool** — removed `draw/sketchMarkup.js` and `draw/controls.js` script tags from `index.html`
- **May 31, 2026 — Remove restrictedToken** — removed `js/lists/restrictedToken.js` script tag from `index.html` and deleted the file
- **May 31, 2026 — Genericize header.js** — removed `siteFirebase`, replaced all AHM-specific values with placeholders, removed legacy analytics ID
- **May 31, 2026 — Genericize mapData.js** — replaced AHM-specific Mapbox style IDs with public Mapbox styles, replaced Ames coordinates with world-center default
- **May 31, 2026 — Genericize modalinfo.js** — replaced AHM About text with placeholder; added commented-out examples for layer info modals matching layersList.js infoId keys
- **May 31, 2026 — Genericize layersList.js** — replaced all AHM layers with commented-out examples: standalone layer, group (2 layers), section, and info panel pattern
- **May 31, 2026 — Genericize sliderDates.js** — replaced Ames-specific dates with generic 1900–2025 defaults
- **May 31, 2026 — Placeholder mapbox-token.js** — replaced real token with placeholder and setup instructions

- **May 31, 2026 — README** — fleshed out setup guide, layer structure docs, engine file reference

## Steps remaining

- Add Mapstructor logo/icons (deferred — waiting on branding)

## Required (before template is complete)

- PMTiles support — template needs to support PMTiles as an alternative to Mapbox tilesets; reference implementation exists in dev branch of `ames_history_museum`

## Future

- Make swipe/compare panel removable
- Make header removable
- Make timeline removable
- Projection switcher — toggle between projections (naturalEarth, winkelTripel, mercator, etc.); each projection paired with its own base map set
- Animated projection transitions — visual morphing effect when switching (needs experimentation)
- Explore blending globe + winkelTripel at different zoom levels

*Note: this log will be used to update the Mapstructor dev plan.*
