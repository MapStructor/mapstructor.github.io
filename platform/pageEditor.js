// pageEditor.js — a tiny in-place CMS. Drop this script on ANY page; mark editable spots with
// data-edit="<unique-key>". For every visitor it loads the saved HTML from the `site_content` table and
// injects it. For the OWNER (logged in) it shows an "✎ Edit page" button → click any marked region and
// type (WYSIWYG), with a </> HTML toggle for raw editing. Works on modal content too (any [data-edit] in
// the DOM, including hidden modals — open the modal while editing). New page = include this + add data-edit.
(function () {
  // A30: one admin list, in platform/auth.js. Real gate = ms_is_admin() in the database.
  var SB_URL = "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
  var SB_KEY = "sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD";

  function db() { return (window.MapAuth && MapAuth.db) || (window.supabase && supabase.createClient(SB_URL, SB_KEY)) || null; }
  function regions() { return Array.prototype.slice.call(document.querySelectorAll("[data-edit]")); }

  // ---- 1. inject saved content (everyone) ----
  async function loadContent() {
    var d = db(); if (!d) return;
    var keys = regions().map(function (el) { return el.getAttribute("data-edit"); }).filter(Boolean);
    if (!keys.length) return;
    try {
      var r = await d.from("site_content").select("key, html").in("key", keys);
      if (r.error || !r.data) return;
      var map = {}; r.data.forEach(function (row) { map[row.key] = row.html; });
      regions().forEach(function (el) { var k = el.getAttribute("data-edit"); if (map[k] != null) el.innerHTML = map[k]; });
    } catch (e) {}
  }

  // ---- 2. owner edit affordance ----
  async function maybeShowEditor() {
    try {
      var force = location.search.indexOf("peadmin=1") > -1;   // preview/test seam (the real WRITE gate is RLS at lockdown)
      var u = window.MapAuth ? await MapAuth.currentUser() : null;
      if (!force && !(window.msIsAdminEmail && window.msIsAdminEmail(u && u.email))) return;
      if (!regions().length) return;
      injectEditButton();
    } catch (e) {}
  }
  function injectEditButton() {
    if (document.getElementById("pe-edit-btn")) return;
    var b = document.createElement("button");
    b.id = "pe-edit-btn"; b.textContent = "✎ Edit page";
    b.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:99998;background:#7c5cbf;color:#fff;border:none;border-radius:24px;padding:10px 18px;font:600 14px 'Source Sans Pro',Arial,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25);";
    b.onclick = enterEdit; document.body.appendChild(b);
  }

  // ---- 3. edit mode ----
  function enterEdit() {
    regions().forEach(function (el) {
      el.dataset.peOrig = el.innerHTML;
      // reveal hidden regions (e.g. modal/pop-up content sources) so they can be edited in place
      var hidden = (el.offsetParent === null) || getComputedStyle(el).display === "none";
      if (hidden) {
        el.dataset.peReveal = "1"; el.dataset.peDisplay = el.style.display || "";
        el.style.display = "block";
        var lab = document.createElement("div"); lab.className = "pe-label"; lab.textContent = "✎ " + el.getAttribute("data-edit") + "  (pop-up content)";
        lab.style.cssText = "font:600 11px 'Source Sans Pro',Arial,sans-serif;color:#7c5cbf;margin:16px 0 2px;";
        el.parentNode.insertBefore(lab, el);
      }
      el.setAttribute("contenteditable", "true");
      el.style.outline = "2px dashed #7c5cbf"; el.style.outlineOffset = "2px"; el.style.minHeight = "1em";
    });
    var btn = document.getElementById("pe-edit-btn"); if (btn) btn.style.display = "none";
    showToolbar();
  }
  function showToolbar() {
    var bar = document.getElementById("pe-toolbar");
    if (bar) { bar.style.display = "flex"; return; }
    bar = document.createElement("div"); bar.id = "pe-toolbar";
    bar.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:99999;display:flex;gap:4px;align-items:center;background:#fff;border:1px solid #ccc;border-radius:10px;padding:6px 8px;box-shadow:0 3px 16px rgba(0,0,0,.25);font-family:'Source Sans Pro',Arial,sans-serif;";
    [["B", "bold", "font-weight:700"], ["I", "italic", "font-style:italic"], ["H2", "formatBlock:H2", ""], ["• List", "insertUnorderedList", ""], ["Link", "__link", ""], ["</> HTML", "__html", ""]]
      .forEach(function (spec) {
        var x = document.createElement("button"); x.textContent = spec[0];
        x.style.cssText = "min-width:30px;height:28px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;" + spec[2];
        x.onmousedown = function (e) { e.preventDefault(); };   // keep the text selection
        x.onclick = function () { doCmd(spec[1]); };
        bar.appendChild(x);
      });
    // 9/1 (owner lost a page of writing to a back-navigation): the editor AUTOSAVES as you type —
    // the chip says Saving…/Saved live; Done just closes; Revert restores what was loaded AND
    // saves that restoration (autosave already persisted the typing, so a visual-only revert
    // would lie).
    var chip = document.createElement("span"); chip.id = "pe-status"; chip.textContent = "Autosaves as you type";
    chip.style.cssText = "margin-left:8px;font-size:12px;color:#888;min-width:64px;text-align:center;";
    var save = document.createElement("button"); save.textContent = "Done";
    save.style.cssText = "margin-left:6px;height:28px;border:none;border-radius:6px;background:#2d7a2d;color:#fff;font-weight:700;padding:0 12px;cursor:pointer;"; save.onclick = saveAll;
    var cancel = document.createElement("button"); cancel.textContent = "Revert";
    cancel.title = "Put back what the page had when you opened the editor (and save that)";
    cancel.style.cssText = "height:28px;border:1px solid #ddd;border-radius:6px;background:#fff;padding:0 10px;cursor:pointer;"; cancel.onclick = cancelEdit;
    bar.appendChild(chip); bar.appendChild(save); bar.appendChild(cancel);
    document.body.appendChild(bar);
    wireAutosave();
  }
  // ---- autosave: every keystroke marks its region dirty; a debounced flush upserts just those ----
  var _dirty = {}, _flushTimer = null, _retryTimer = null;
  function peChip(txt, color) { var c = document.getElementById("pe-status"); if (c) { c.textContent = txt; c.style.color = color || "#888"; } }
  function regionHtml(el) {
    if (el.dataset.peHtml === "1") { var ta = el.querySelector("textarea.pe-html"); return ta ? ta.value : el.innerHTML; }
    return el.innerHTML;
  }
  function markDirty(el) {
    var k = el.getAttribute("data-edit"); if (!k) return;
    _dirty[k] = el;
    peChip("Saving…", "#b07d00");
    clearTimeout(_flushTimer); _flushTimer = setTimeout(flushDirty, 800);
  }
  async function flushDirty() {
    var keys = Object.keys(_dirty); if (!keys.length) return;
    var rows = keys.map(function (k) { return { key: k, html: regionHtml(_dirty[k]) }; });
    var d = db(); if (!d) return;
    try {
      var r = await d.from("site_content").upsert(rows);
      if (r.error) throw new Error(r.error.message);
      keys.forEach(function (k) { delete _dirty[k]; });
      if (!Object.keys(_dirty).length) peChip("Saved ✓", "#2d7a2d");
    } catch (e) {
      peChip("Not saved — retrying…", "#b4453a");
      clearTimeout(_retryTimer); _retryTimer = setTimeout(flushDirty, 4000);
    }
  }
  function wireAutosave() {
    if (wireAutosave._done) return; wireAutosave._done = true;
    document.addEventListener("input", function (e) {
      var t = e.target; if (!t || !t.closest) return;
      var el = t.closest("[data-edit]"); if (!el) return;
      if (el.getAttribute("contenteditable") === "true" || el.dataset.peHtml === "1") markDirty(el);
    }, true);
    // leaving the page mid-typing: best-effort flush that survives navigation (keepalive fetch
    // straight to PostgREST — supabase-js requests are dropped on unload). The token is read
    // synchronously from the client's own storage; beforeunload cannot await anything.
    window.addEventListener("beforeunload", function () {
      var keys = Object.keys(_dirty); if (!keys.length) return;
      try {
        var rows = keys.map(function (k) { return { key: k, html: regionHtml(_dirty[k]) }; });
        var tok = null;
        try { tok = (JSON.parse(localStorage.getItem("sb-" + SB_URL.split("//")[1].split(".")[0] + "-auth-token") || "null") || {}).access_token || null; } catch (e0) {}
        fetch(SB_URL + "/rest/v1/site_content?on_conflict=key", {
          method: "POST", keepalive: true,
          headers: { apikey: SB_KEY, Authorization: "Bearer " + (tok || SB_KEY), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(rows),
        });
      } catch (e) {}
    });
  }
  function doCmd(cmd) {
    if (cmd === "__link") { var url = window.prompt("Link URL:"); if (url) document.execCommand("createLink", false, url); return; }
    if (cmd === "__html") { toggleHtml(); return; }
    if (cmd.indexOf("formatBlock:") === 0) { document.execCommand("formatBlock", false, cmd.split(":")[1]); return; }
    document.execCommand(cmd, false, null);
  }
  function currentRegion() {
    var sel = window.getSelection(); var n = sel && sel.anchorNode;
    while (n) { if (n.getAttribute && n.hasAttribute && n.hasAttribute("data-edit")) return n; n = n.parentNode; }
    return regions()[0] || null;
  }
  function toggleHtml() {
    var el = currentRegion(); if (!el) { window.alert("Click into a section first."); return; }
    if (el.dataset.peHtml === "1") {
      var ta = el.querySelector("textarea.pe-html"); if (ta) el.innerHTML = ta.value;
      el.dataset.peHtml = "0"; el.setAttribute("contenteditable", "true");
    } else {
      var html = el.innerHTML; el.setAttribute("contenteditable", "false"); el.innerHTML = "";
      var t = document.createElement("textarea"); t.className = "pe-html"; t.value = html;
      t.style.cssText = "width:100%;min-height:120px;box-sizing:border-box;font-family:monospace;font-size:12px;padding:6px;";
      el.appendChild(t); el.dataset.peHtml = "1"; t.focus();
    }
  }
  async function saveAll() {
    regions().forEach(function (el) { if (el.dataset.peHtml === "1") { var ta = el.querySelector("textarea.pe-html"); if (ta) el.innerHTML = ta.value; el.dataset.peHtml = "0"; } });
    var d = db(); var rows = regions().map(function (el) { return { key: el.getAttribute("data-edit"), html: el.innerHTML }; });
    try {
      var r = await d.from("site_content").upsert(rows);
      if (r.error) { window.alert("Save failed: " + r.error.message + (/relation|does not exist|schema cache/i.test(r.error.message) ? "\n\n(The site_content table isn't created yet — run mapstructor_docs/sql/setup/site-content-setup.sql.)" : "")); return; }
      exitEdit();
    } catch (e) { window.alert("Save error: " + (e && e.message)); }
  }
  function cancelEdit() {
    regions().forEach(function (el) { if (el.dataset.peOrig != null) el.innerHTML = el.dataset.peOrig; });
    // autosave already persisted the typing — reverting the SCREEN alone would lie. Save the restoration too.
    var d = db();
    if (d) { var rows = regions().map(function (el) { return { key: el.getAttribute("data-edit"), html: el.innerHTML }; }); d.from("site_content").upsert(rows).then(function () { peChip("Reverted ✓", "#2d7a2d"); }); }
    _dirty = {};
    exitEdit();
  }
  function exitEdit() {
    regions().forEach(function (el) {
      el.removeAttribute("contenteditable"); el.style.outline = ""; el.style.outlineOffset = ""; el.dataset.peHtml = "";
      if (el.dataset.peReveal === "1") { el.style.display = el.dataset.peDisplay; el.dataset.peReveal = ""; }
    });
    Array.prototype.slice.call(document.querySelectorAll(".pe-label")).forEach(function (l) { if (l.parentNode) l.parentNode.removeChild(l); });
    var bar = document.getElementById("pe-toolbar"); if (bar) bar.style.display = "none";
    var btn = document.getElementById("pe-edit-btn"); if (btn) btn.style.display = "";
  }

  function start() { loadContent().then(maybeShowEditor); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
