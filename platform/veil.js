/* veil.js — the pre-launch veil (launch item 23, built 2026-07-31).
 *
 * WHAT IT DOES: while the veil is up, a visitor with no account sees the landing page instead
 * of the platform. Log in and it disappears. Taking the veil down at launch is the ONE LINE
 * below — no deploy dance, no route juggling, and putting it back is the same line.
 *
 *     var VEIL_ON = false;   ← flip to true to raise the veil
 *
 * TEST IT WITHOUT RAISING IT: append ?veil=1 to any page. That forces the veil for that one
 * page load, so the whole thing can be verified now and flipped later with confidence.
 * (?veil=0 forces it off — useful if it's up and you need a quick look without logging in.)
 *
 * THE GATE CODE. Anyone you give the code to can pull the curtain aside themselves — either by
 * typing it into "Have a code?" on the veil, or by opening a link with ?code=<the code> on it.
 * It is remembered in that browser, so they only do it once.
 *
 * This is NOT a login and deliberately not a secret. Past the curtain they are an ordinary
 * visitor: anonymous at first, free to register, log in, make maps — everything a real visitor
 * can do. Nothing about the code grants any permission; it only stops the general public
 * wandering in before launch.
 *
 * WHAT IT DELIBERATELY LETS THROUGH, because a closed front door must not break these:
 *   · terms / privacy / report  — a rights-holder has to be able to reach you even pre-launch;
 *                                 the ToS names that path, so hiding it would be a broken promise
 *   · /maps/*  and  /ames/*     — served by the Worker, not this site: the frozen showcases and
 *                                 the Ames History Museum's encyclopedia, which is a LIVE
 *                                 dependency of somebody else's website
 *   · /ames_history_museum/     — AHM1, the museum's own live map
 *   · map/index.html            — THE VIEWER. Showcase links keep working while the veil is up
 *                                 (owner's call, 7/31: "a user should still see showcases").
 *                                 Safe, because the viewer is not a way in: a private map already
 *                                 refuses strangers (RLS + the private notice), while the editor,
 *                                 dashboard, admin and home page all stay behind the veil.
 *
 * WHAT IT IS NOT: security. It's a curtain, not a lock — the data behind it is protected by RLS
 * (item 9), which is the thing that actually stops a stranger reading a private map. The veil
 * exists so the site isn't *discovered* before it's ready, not to make it unreachable. */
(function () {
  var VEIL_ON = false;                       // ← THE LAUNCH SWITCH
  var GATE_CODE = "tester";                  // ← give this to anyone who should get in early
  var KEY_STYLE = "ms-veil-style";
  var KEY_PASS = "ms-veil-pass";             // remembers that this browser was let through

  var lifted = false;   // set once we know the visitor is allowed in — see show()/hide()

  var q = new URLSearchParams(location.search);
  var forced = q.get("veil");
  if (forced === "0") return;                       // explicit bypass for a quick look
  if (!VEIL_ON && forced !== "1") return;           // down = do nothing at all

  function norm(s) { return String(s || "").trim().toLowerCase(); }

  // ── the code, checked BEFORE anything is drawn so nobody sees a flash of curtain ──
  function remembered() {
    try { return localStorage.getItem(KEY_PASS) === GATE_CODE; } catch (e) { return false; }
  }
  function accept(code) {
    if (norm(code) !== norm(GATE_CODE)) return false;
    try { localStorage.setItem(KEY_PASS, GATE_CODE); } catch (e) {}
    return true;
  }
  // a shareable link: mapstructor.com/?code=tester
  var linkCode = q.get("code") || q.get("gate");
  if (linkCode && accept(linkCode)) {
    // take the code back out of the address bar — it's an invitation, not part of the page
    try {
      q.delete("code"); q.delete("gate");
      var rest = q.toString();
      history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    } catch (e) {}
    return;
  }
  if (remembered()) return;                         // already opened the curtain here

  // pages that stay reachable with the veil up
  var path = location.pathname.toLowerCase();
  if (/(terms|privacy|report)\.html$/.test(path)) return;
  if (path.indexOf("/maps/") === 0 || path.indexOf("/ames/") === 0) return;
  if (path.indexOf("/ames_history_museum/") === 0) return;
  if (path.slice(-16) === "/map/index.html" || path.slice(-5) === "/map/") return;   // the viewer — showcase links stay open

  function show() {
    // The check below can finish BEFORE the DOM is ready — this script runs in <head>, so show()
    // is queued to DOMContentLoaded while the session lookup races ahead. Without this guard the
    // sequence hide()-then-show() re-raised the veil on the owner and never took it down again
    // (measured 7/31: still veiled at 16s, with no errors to show for it).
    if (lifted) return;
    if (document.getElementById("ms-veil")) return;
    var s = document.createElement("style");
    s.id = KEY_STYLE;
    s.textContent =
      "#ms-veil{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:28px;" +
      "font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#2a2438;overflow:hidden;" +
      "background:radial-gradient(1100px 600px at 15% -10%,#efe9fb 0%,rgba(239,233,251,0) 60%)," +
      "radial-gradient(900px 550px at 110% 110%,#e6f0e9 0%,rgba(230,240,233,0) 55%),#f0eaff;}" +
      "#ms-veil .c{text-align:center;max-width:620px;width:100%;}" +
      "#ms-veil img{width:104px;height:auto;margin:0 auto 20px;display:block;}" +
      "#ms-veil h1{font-size:clamp(34px,7vw,52px);font-weight:800;letter-spacing:-1px;margin:0;}" +
      "#ms-veil h1 .a{color:#7c5cbf;}" +
      "#ms-veil .tag{margin:14px auto 0;font-size:clamp(16px,2.6vw,19px);color:#5b5470;max-width:460px;line-height:1.55;}" +
      "#ms-veil .btn{display:inline-block;margin-top:28px;padding:11px 26px;border:none;border-radius:9px;" +
      "background:#7c5cbf;color:#fff;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit;}" +
      "#ms-veil .btn:hover{background:#6b4db0;}" +
      "#ms-veil .sub{margin-top:18px;font-size:13px;color:#8b84a3;}" +
      "#ms-veil .sub a{color:#7c5cbf;}" +
      "#ms-veil .codelink{margin-top:26px;font-size:13px;color:#8b84a3;}" +
      "#ms-veil .codelink button{background:none;border:none;color:#7c5cbf;font:inherit;cursor:pointer;text-decoration:underline;padding:0;}" +
      "#ms-veil .codebox{margin-top:14px;display:none;}" +
      "#ms-veil .codebox.on{display:block;}" +
      "#ms-veil .codebox input{padding:9px 13px;border:1px solid #cfc6e6;border-radius:8px;font:inherit;font-size:14px;" +
      "width:180px;background:#fff;color:#2a2438;}" +
      "#ms-veil .codebox input:focus{outline:2px solid #7c5cbf;outline-offset:1px;}" +
      "#ms-veil .codebox button{margin-left:8px;padding:9px 18px;border:none;border-radius:8px;background:#7c5cbf;" +
      "color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;}" +
      "#ms-veil .codemsg{margin-top:10px;font-size:13px;color:#c0392b;min-height:18px;}";
    document.head.appendChild(s);

    var d = document.createElement("div");
    d.id = "ms-veil";
    d.innerHTML =
      '<div class="c">' +
        '<img src="/images/logo-transparent.png" alt="" onerror="this.style.display=\'none\'">' +
        '<h1>Map<span class="a">Structor</span></h1>' +
        '<p class="tag">A data portal, community, and open universal web-mapping tool — bringing ' +
        'the world’s geographic data into one source, as free as possible.</p>' +
        '<button class="btn" id="ms-veil-login">Log in</button>' +
        '<p class="sub">Opening soon. Questions or early access — ' +
        '<a href="mailto:contact@mapstructor.com">contact@mapstructor.com</a></p>' +
        '<p class="codelink">Been given a code? <button id="ms-veil-codelink" type="button">Enter it here</button></p>' +
        '<div class="codebox" id="ms-veil-codebox">' +
          '<input id="ms-veil-code" type="text" placeholder="code" autocomplete="off" ' +
            'autocapitalize="off" autocorrect="off" spellcheck="false">' +
          '<button id="ms-veil-codego" type="button">Enter</button>' +
          '<p class="codemsg" id="ms-veil-codemsg"></p>' +
        '</div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(d);
    var b = document.getElementById("ms-veil-login");
    if (b) b.addEventListener("click", function () {
      try { MapAuth.openAuthModal("login"); } catch (e) { location.href = "/index.html"; }
    });

    var box = document.getElementById("ms-veil-codebox");
    var input = document.getElementById("ms-veil-code");
    var msg = document.getElementById("ms-veil-codemsg");
    var link = document.getElementById("ms-veil-codelink");
    if (link) link.addEventListener("click", function () {
      box.classList.add("on"); link.parentNode.style.display = "none"; input.focus();
    });
    function tryCode() {
      if (accept(input.value)) { hide(); return; }
      msg.textContent = "That code doesn’t match.";
      input.select();
    }
    var go = document.getElementById("ms-veil-codego");
    if (go) go.addEventListener("click", tryCode);
    if (input) input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); tryCode(); }
      else if (msg.textContent) msg.textContent = "";
    });
  }

  function hide() {
    lifted = true;
    var d = document.getElementById("ms-veil"); if (d) d.remove();
    var s = document.getElementById(KEY_STYLE); if (s) s.remove();
  }

  // Up FIRST, then check — the reverse order flashes the app to someone who shouldn't see it.
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);

  (async function () {
    for (var i = 0; i < 40 && !window.MapAuth; i++) await new Promise(function (r) { setTimeout(r, 100); });
    if (!window.MapAuth) return;             // auth never loaded → stay shut, which is the safe way to fail

    function ok(u) { return !!(u && u.id && (!MapAuth.isReal || MapAuth.isReal(u))); }

    // POLL, don't ask once. Asking once loses a race that a logged-in owner hits every time:
    // the veil script runs before the Supabase client has restored the session from
    // localStorage, so currentUser() answers null — and onChange never fires to correct it,
    // because the restore already happened before the listener existed. Measured 7/31: the
    // owner sat behind their own veil until reload.
    for (var t = 0; t < 30; t++) {
      try { if (ok(await MapAuth.currentUser())) { hide(); return; } } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    try { MapAuth.onChange(async function () {   // logging in from the modal lifts it immediately
      try { if (ok(await MapAuth.currentUser())) hide(); } catch (e) {}
    }); } catch (e) {}
  })();
})();
