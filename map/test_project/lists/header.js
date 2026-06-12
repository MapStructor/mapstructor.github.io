const siteFirebase = {
  apiKey:            "AIzaSyC2lueQJPOT2DqZMvGhnXkSHGd1ELXJNYg",
  authDomain:        "meny-firebase.firebaseapp.com",
  projectId:         "meny-firebase",
  storageBucket:     "meny-firebase.appspot.com",
  messagingSenderId: "426318777741",
  appId:             "1:426318777741:web:52cf7896f3f4ed410a81c4",
  measurementId:     "G-H32RX557FG",
};

const siteAnalytics = {
  trackingId:        "UA-159545294-1",
  legacyTrackingId:  "UA-28801666-1",
};

const siteConfig = {
  mapboxUsername:  "nittyjee",
  mobileRedirect:  "./mobile.html",
  desktopRedirect: "./index.html",
};

const siteMeta = {
  title:       "AHM - Discover Ames, Iowa History Map",
  description: "Ames Historical Society is engaging to Discover Ames, Iowa History by Our Interactive Timeline Map",
  themeColor:  "#00A2E5",
  ogImage:     "./icons/AHM.jpg",
  ogUrl:       "https://ameshistory.org/",
  ogSiteName:       "AHM - Ames, Iowa History Map",
  twitterCard:      "ahm_icon",
  twitterImageAlt:  "AHM Icon",
};

const siteLogoLink   = "https://ameshistory.org/";
const siteHeaderText = "Map";

const zoomButtons = [

  {
    label:  "Zoom to Iowa",
    icon:   "fa-location-crosshairs",
    target: "Iowa",
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
    type: "modal",
    id: "about",
  },

  /*
  {
    label: "Visit Site",
    type: "link",
    url: "https://ameshistory.org/",
    newTab: true,   // default true; false opens in same tab
  },
  */
  

];
