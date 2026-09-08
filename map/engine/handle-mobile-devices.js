/* LEGACY, AND NOT USED BY THE PLATFORM PAGES (9/8).
 *
 * map/index.html and map/editor.html no longer include this file. It navigates to
 * siteConfig.mobileRedirect on any phone user-agent, and on any window 670px or narrower — and the
 * only mobileRedirect any config in this repo sets is "./mobile.html", which has never existed
 * here. So the live site answered every phone visitor with a raw 404 page: hand somebody a map
 * link, they open it on their phone, and they get "File not found". download.js already stripped
 * this include from the standalone zip, so a downloaded copy behaved better than the live site.
 *
 * The design flaw worth remembering: this trusts a config value NAMING A PAGE, with no check that
 * the page is there, and its failure mode (a dead end) is strictly worse than not running at all.
 * If a phone-specific page is ever built, redirect only after confirming the target exists, and
 * never to the page you are already on.
 *
 * Kept for the legacy standalone projects under map/project/ that ship their own mobile page.
 */
const browserTestRegexp =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|Windows Phone|IEMobile|Opera Mini/i;

if (browserTestRegexp.test(navigator.userAgent)) {
  // true for mobile device
  console.warn("mobile device");
  console.warn("redirect");
  window.location.href = siteConfig.mobileRedirect;
} else {
  // false for not mobile device
  console.warn("not mobile device");
  if (window.innerWidth <= 670) {
    console.warn("but small size");
    console.warn("redirect");
    window.location.href = siteConfig.mobileRedirect;
  } else {
    console.warn("start");
    console.warn("load");
  }
}
