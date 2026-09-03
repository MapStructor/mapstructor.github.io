/* dialog.js — the MapStructor dialog: ask / say / prompt.
 *
 * WHY. 9/2 the owner ticked 60 maps, hit "Move to Trash", and got the BROWSER's grey
 * `confirm()` box — "mapstructor.com says", a scrolling wall of 60 identical "Untitled Map"
 * bullets, and OS buttons. Their words: "should be a mapstructor dialog". A native dialog is
 * also a functional problem, not only a cosmetic one: it blocks the page, it cannot show a
 * scrollable list, it cannot show progress, and it looks like the browser warning about a
 * suspicious site at exactly the moment the person is deciding to delete something.
 *
 * So: one dialog for the whole product, in the product's own look, replacing `confirm`,
 * `alert` and `prompt`.
 *
 *   await MSDialog.ask({ title, body, items, note, confirmLabel, danger })  → true / false
 *   await MSDialog.say({ title, body, items, danger })                      → undefined
 *   await MSDialog.prompt({ title, label, value })                          → string / null
 *
 * Rules it keeps:
 *   · Escape and the backdrop always cancel. Enter activates whatever is focused.
 *   · A DANGEROUS dialog opens with the SAFE button focused, so a stray Enter never deletes.
 *   · A long list scrolls inside the dialog instead of stretching the page.
 *   · Nothing is fetched — it works from file:// and inside the offline download copy.
 *
 * Self-contained on purpose: no framework, no CSS file, no dependency on the host page's
 * styles beyond the house palette below, so any page can include it and get the same dialog.
 */
(function () {
  "use strict";
  if (window.MSDialog) return;   // one owner per surface

  var P = "#7c5cbf", INK = "#1e1b2e";

  function ensureCss() {
    if (document.getElementById("msdlg-css")) return;
    var s = document.createElement("style");
    s.id = "msdlg-css";
    s.textContent =
      "#msdlg-back{position:fixed;inset:0;background:rgba(30,27,46,.45);z-index:2147483000;display:flex;" +
        "align-items:center;justify-content:center;padding:20px;font-family:'Source Sans Pro',system-ui,Arial,sans-serif;}" +
      "#msdlg{background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(30,27,46,.35);width:460px;max-width:100%;" +
        "max-height:calc(100vh - 40px);display:flex;flex-direction:column;overflow:hidden;color:" + INK + ";}" +
      "#msdlg .msdlg-h{font-size:18px;font-weight:800;padding:18px 22px 0;line-height:1.3;}" +
      "#msdlg .msdlg-b{font-size:14px;color:#4a465c;padding:8px 22px 0;line-height:1.55;}" +
      "#msdlg .msdlg-list{margin:12px 22px 0;border:1px solid #eae6f3;border-radius:9px;background:#faf9fd;" +
        "max-height:190px;overflow-y:auto;font-size:13px;color:#4a465c;}" +
      "#msdlg .msdlg-list div{padding:5px 12px;border-top:1px solid #f0ecf8;}" +
      "#msdlg .msdlg-list div:first-child{border-top:none;}" +
      "#msdlg .msdlg-note{font-size:12.5px;color:#8a6d3b;background:#fff7e6;border:1px solid #f0dca8;border-radius:9px;" +
        "margin:12px 22px 0;padding:8px 12px;line-height:1.5;}" +
      "#msdlg input.msdlg-in{margin:12px 22px 0;padding:9px 12px;border:1px solid #cdc6e0;border-radius:8px;font-size:14px;" +
        "font-family:inherit;width:calc(100% - 44px);}" +
      "#msdlg .msdlg-f{display:flex;justify-content:flex-end;gap:8px;padding:18px 22px 20px;}" +
      "#msdlg .msdlg-btn{border:none;border-radius:8px;font-weight:700;font-size:14px;padding:9px 18px;cursor:pointer;" +
        "font-family:inherit;background:" + P + ";color:#fff;}" +
      "#msdlg .msdlg-btn.light{background:#efeaf8;color:" + INK + ";}" +
      "#msdlg .msdlg-btn.danger{background:#b4453a;color:#fff;}" +
      "#msdlg .msdlg-btn:focus-visible{outline:3px solid rgba(124,92,191,.45);outline-offset:2px;}" +
      "@media (prefers-reduced-motion:no-preference){#msdlg{animation:msdlg-in .13s ease-out;}" +
        "@keyframes msdlg-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}}";
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* One builder for all three flavours. `kind` decides which controls appear. */
  function open(kind, o) {
    o = o || {};
    ensureCss();
    var prev = document.getElementById("msdlg-back");
    if (prev) prev.remove();                       // never stack dialogs
    var focusBack = document.activeElement;

    var back = document.createElement("div");
    back.id = "msdlg-back";
    var items = (o.items || []).filter(function (x) { return x != null && x !== ""; });
    var html = '<div id="msdlg" role="' + (kind === "say" ? "alertdialog" : "dialog") + '" aria-modal="true" aria-labelledby="msdlg-title">' +
      '<div class="msdlg-h" id="msdlg-title">' + esc(o.title || "") + "</div>" +
      (o.body ? '<div class="msdlg-b">' + esc(o.body) + "</div>" : "");
    if (items.length) {
      html += '<div class="msdlg-list">' + items.map(function (t) { return "<div>" + esc(t) + "</div>"; }).join("") + "</div>";
    }
    if (o.note) html += '<div class="msdlg-note">' + esc(o.note) + "</div>";
    if (kind === "prompt") {
      html += (o.label ? '<div class="msdlg-b" style="padding-top:14px;">' + esc(o.label) + "</div>" : "") +
        '<input class="msdlg-in" id="msdlg-input" value="' + esc(o.value == null ? "" : o.value) + '" />';
    }
    html += '<div class="msdlg-f">';
    if (kind !== "say") html += '<button class="msdlg-btn light" id="msdlg-no">' + esc(o.cancelLabel || "Cancel") + "</button>";
    html += '<button class="msdlg-btn' + (o.danger ? " danger" : "") + '" id="msdlg-yes">' +
      esc(o.confirmLabel || (kind === "say" ? "OK" : kind === "prompt" ? "Save" : "OK")) + "</button></div></div>";
    back.innerHTML = html;
    document.body.appendChild(back);

    var input = back.querySelector("#msdlg-input");
    var yes = back.querySelector("#msdlg-yes"), no = back.querySelector("#msdlg-no");

    return new Promise(function (resolve) {
      var done = false;
      function close(val) {
        if (done) return;                          // a double-click must not resolve twice
        done = true;
        document.removeEventListener("keydown", onKey, true);
        back.remove();
        try { if (focusBack && focusBack.focus) focusBack.focus(); } catch (e) {}
        resolve(val);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(kind === "prompt" ? null : kind === "say" ? undefined : false); }
        else if (e.key === "Enter" && kind === "prompt" && document.activeElement === input) { e.preventDefault(); close(input.value); }
      }
      document.addEventListener("keydown", onKey, true);
      back.addEventListener("mousedown", function (e) {   // backdrop click cancels; mousedown so a drag out of the panel doesn't
        if (e.target === back) close(kind === "prompt" ? null : kind === "say" ? undefined : false);
      });
      yes.addEventListener("click", function () { close(kind === "prompt" ? input.value : kind === "say" ? undefined : true); });
      if (no) no.addEventListener("click", function () { close(kind === "prompt" ? null : false); });

      /* Focus: the text field when there is one; otherwise the SAFE control on a dangerous
         dialog (so Enter cannot confirm a delete), the confirm button otherwise. */
      try {
        if (input) { input.focus(); input.select(); }
        else if (o.danger && no) no.focus();
        else yes.focus();
      } catch (e) {}
    });
  }

  window.MSDialog = {
    ask: function (o) { return open("ask", o); },
    say: function (o) { return open("say", o); },
    prompt: function (o) { return open("prompt", o); }
  };
})();
