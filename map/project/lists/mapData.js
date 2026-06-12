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

const mapConfig = {
  style: "mapbox://styles/mapbox/streets-v12", // Starting style for the map
  center: [-14.22, 19.28], // [longitude, latitude]
  zoom: 1.87,
};
