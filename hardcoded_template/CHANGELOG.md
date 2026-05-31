# Changelog

Stripping log from AHM → generic Mapstructor template.

## Steps completed

- **Remove Firebase** — removed both Firebase script blocks and `firebaseui-auth-container` div from `index.html`
- **Remove draw tool** — removed `draw/sketchMarkup.js` and `draw/controls.js` script tags from `index.html`
- **Remove restrictedToken** — removed `js/lists/restrictedToken.js` script tag from `index.html` and deleted the file
- **Genericize header.js** — removed `siteFirebase`, replaced all AHM-specific values with placeholders, removed legacy analytics ID

## Steps remaining

- Genericize `mapData.js`
- Genericize `modalinfo.js`
- Genericize `layersList.js`
- Genericize `sliderDates.js`
- Replace `js/mapbox-token.js` with a placeholder setup file
- Add icons placeholders
- Write README setup documentation
