const siteAnalytics = {
  trackingId: "G-XXXXXXXXXX", // Replace with your Google Analytics measurement ID
};

const siteConfig = {
  mapboxUsername:  "YOUR_MAPBOX_USERNAME",
  mobileRedirect:  "./mobile.html",
  desktopRedirect: "./index.html",
};

const siteMeta = {
  title:           "Your Map Title",
  description:     "A short description of your map.",
  themeColor:      "#00A2E5",
  ogImage:         "./icons/banner_thumbnail.png",
  ogUrl:           "https://your-site.com/",
  ogSiteName:      "Your Map Title",
  twitterCard:     "summary_large_image",
  twitterImageAlt: "Map preview image",
};

const siteLogoLink   = "https://your-site.com/";
const siteHeaderText = "Map";

const zoomButtons = [

  {
    label:  "Zoom to Region", // Replace label and target with your region (defined in bounds.js)
    icon:   "fa-location-crosshairs",
    target: "Region",
  },

  {
    label:  "Zoom to USA",
    icon:   "fa-flag-usa",
    target: "USA",
  },

  {
    label:  "Zoom to World",
    icon:   "fa-globe",
    target: "World",
  },

];

const headerButtons = [

  {
    label: "ABOUT",
    type:  "modal",
    id:    "about",
  },

];
