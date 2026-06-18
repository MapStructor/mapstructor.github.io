/* renderRegistry.js — info panel render functions, keyed by layer id (slug).
   Supabase stores layer config as pure JSON and cannot hold functions; the
   db→config loader (platform/configLoader.js) reattaches these by slug.
   Ships with the platform, not with any project's lists — the DB never holds
   executable code. Same pattern as AHM's js/lists/renderRegistry.js
   (2026-04-23). */

var renderRegistry = {
  "prev-builds": function(_props, f) {
    return `
      <div class="panel-hero">${f("field-main-image", "hero")}</div>
      <h3><a href="${f("node-url")}" target="_blank">${f("node-title") || "Building"}</a></h3>
      <hr/>
      ${f()}
    `;
  },
  "curr-builds": function(_props, f) {
    return `
      <div class="panel-hero">${f("field-main-image", "hero")}</div>
      <h3><a href="${f("node-url")}" target="_blank">${f("node-title") || "Building"}</a></h3>
      <hr/>
      ${f()}
    `;
  },
  // Generic fallback for layers that link to an encyclopedia but have no custom render
  // (e.g. user-drawn layers configured with a base URL in the editor): show the linked
  // title + a hero image if present + the full rendered entity. configLoader uses this
  // when there's no slug-specific render.
  "_default": function(_props, f) {
    var hero = f("field-main-image", "hero");
    return `
      ${hero ? '<div class="panel-hero">' + hero + '</div>' : ''}
      <h3><a href="${f("node-url")}" target="_blank">${f("node-title") || "Details"}</a></h3>
      <hr/>
      ${f()}
    `;
  },
};
