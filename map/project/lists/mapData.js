const baseMaps = [
  {
    id: "satellite-v9", // Mapbox public style — replace with your own style ID if needed
    name: "Satellite",
    lChecked: true,
    rChecked: false,
  },
  {
    id: "streets-v12", // Mapbox public style — replace with your own style ID if needed
    name: "Streets",
    lChecked: false,
    rChecked: true,
  },
];

// Map sections (basemaps can be grouped under sections — no groups, since maps are mutually exclusive).
// Each section: { id, name }. A map joins a section via its `section` (= section id); unsectioned maps render first.
const mapSections = [];

const mapConfig = {
  style: "mapbox://styles/mapbox/streets-v12", // Starting style for the map
  center: [-14.22, 19.28], // [longitude, latitude]
  zoom: 1.87,
};
