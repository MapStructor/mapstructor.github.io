// pageEditor.js — a tiny in-place CMS. Drop this script on ANY page; mark editable spots with
// data-edit="<unique-key>". For every visitor it loads the saved HTML from the `site_content` table and
// injects it. For the OWNER (logged in) it shows an "✎ Edit page" button → click any marked region and
// type (WYSIWYG), with a </> HTML toggle for raw editing. Works on modal content too (any [data-edit] in
// the DOM, including hidden modals — open the modal while editing). New page = include this + add data-edit.
(function () {
  var ADMIN_EMAILS = ["nittyjee@gmail.com"];   // owner allow-list (client gate; RLS restricts writes at lockdown)
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
      if (!force && (!u || !u.email || ADMIN_EMAILS.indexOf(u.email) === -1)) return;
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
    var save = document.createElement("button"); save.textContent = "Save";
    save.style.cssText = "margin-left:6px;height:28px;border:none;border-radius:6px;background:#2d7a2d;color:#fff;font-weight:700;padding:0 12px;cursor:pointer;"; save.onclick = saveAll;
    var cancel = document.createElement("button"); cancel.textContent = "Cancel";
    cancel.style.cssText = "height:28px;border:1px solid #ddd;border-radius:6px;background:#fff;padding:0 10px;cursor:pointer;"; cancel.onclick = cancelEdit;
    bar.appendChild(save); bar.appendChild(cancel);
    document.body.appendChild(bar);
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
  function cancelEdit() { regions().forEach(function (el) { if (el.dataset.peOrig != null) el.innerHTML = el.dataset.peOrig; }); exitEdit(); }
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
