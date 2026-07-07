const baseMaps = [
  {
    id: "satellite-v9", // Mapbox public style — replace with your own style ID if needed
    name: "Satellite",
    lChecked: false,
    rChecked: true,
  },
  {
    id: "streets-v12", // Mapbox public style — replace with your own style ID if needed
    name: "Streets",
    lChecked: true,
    rChecked: false,
  },
];

// Map sections (basemaps can be grouped under sections — no groups, since maps are mutually exclusive).
// Each section: { id, name }. A map joins a section via its `section` (= section id); unsectioned maps render first.
const mapSections = [];

const mapConfig = {
  style: "mapbox://styles/mapbox/streets-v12", // Starting style for the map
  center: [-27.5, 11], // [longitude, latitude] — default world view for new maps (#1.4/11/-27.5)
  zoom: 1.4,
};
