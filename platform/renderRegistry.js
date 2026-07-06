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
  // Notes mode: no encyclopedia — render the feature's OWN title + notes (+ optional image), using the
  // SAME panel-hero / h3 / hr structure (and the panel's colour chrome) as the encyclopedia renders, so the
  // styling is identical. Sourced from props, not Drupal fields. WYSIWYG notes (#9) are stored as HTML and
  // rendered raw (script-stripped); legacy plain-text notes are escaped with line breaks preserved.
  "_notes": function(props, _f) {
    function esc(s) { return String(s == null ? "" : s).replace(/[<>&]/g, function(c) { return c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"; }); }
    var img      = props.image_url || props.image || "";
    var title    = props.label || props.name || props.title || "";   // no placeholder "Details" — an untitled feature just has no heading
    var notesRaw = props.notes != null ? props.notes : (props.description != null ? props.description : "");
    var isHtml   = /<[a-z!\/][\s\S]*>/i.test(notesRaw);   // WYSIWYG content carries tags
    var notes    = isHtml ? String(notesRaw).replace(/<script[\s\S]*?<\/script>/gi, "") : esc(notesRaw).replace(/\n/g, "<br/>");
    return `
      ${img ? '<div class="panel-hero"><img src="' + esc(img) + '" alt=""></div>' : ''}
      ${title ? '<h3>' + esc(title) + '</h3>' : ''}
      ${notes ? (title ? '<hr/>' : '') + '<div class="panel-notes">' + notes + '</div>' : ''}
    `;
  },
};
