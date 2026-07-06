const siteAnalytics = {
  trackingId: "G-XXXXXXXXXX", // Replace with your Google Analytics measurement ID
};

const siteConfig = {
  mapboxUsername:  "mapbox", // Use "mapbox" for public styles; replace with your username for custom styles
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

const siteLogoLink   = "../index.html";   // the MapStructor home page (default; a map can override via raw_config.headerLink)
const siteHeaderText = "Map";

const zoomButtons = [

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
