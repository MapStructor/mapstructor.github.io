// sitelock.js — a simple "under development" password gate. OPT-IN: add this as the FIRST <script> in the
// <head> of any page you want locked, before everything else:
//     <script src="platform/sitelock.js"></script>   (root pages)
//     <script src="../platform/sitelock.js"></script> (map/ pages)
//
// When locked it calls window.stop() so the rest of the page — including the map — never loads, which means
// no Mapbox tile loads, no Supabase calls, no Stripe, nothing. Only someone who enters the password gets in
// (stored in this browser afterward). To DISABLE the lock entirely, just remove the script tag.
//
// NOTE: this is a DETERRENT, not real security — the password is visible in this file's source. It keeps the
// public out of a dev site and stops background charges; the real protections are your Supabase/Stripe/Mapbox
// account settings. Change PASSWORD below to your own, and to lock everyone out again, change it (which
// invalidates the stored unlock).
(function () {
  var PASSWORD = "letmein";          // <<< CHANGE THIS to your dev password
  var KEY = "ms_dev_unlock";

  try { if (localStorage.getItem(KEY) === PASSWORD) return; } catch (e) {}   // already unlocked → load normally

  function gate() {
    var html =
      '<div style="position:fixed;inset:0;background:#1e1b2e;display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:system-ui,Arial,sans-serif;">' +
        '<div style="text-align:center;color:#fff;max-width:340px;padding:24px;">' +
          '<div style="font-size:44px;line-height:1;">🔒</div>' +
          '<h1 style="font-weight:800;font-size:22px;margin:16px 0 6px;">MapStructor</h1>' +
          '<p style="color:#b9b3cf;font-size:15px;margin:0 0 20px;">Under development — enter the password to continue.</p>' +
          '<input id="ms-pw" type="password" placeholder="Password" autocomplete="off" style="width:100%;padding:11px 14px;border-radius:9px;border:1px solid #4a4560;background:#2a2640;color:#fff;font-size:15px;outline:none;box-sizing:border-box;">' +
          '<button id="ms-go" style="width:100%;margin-top:12px;padding:11px;border:none;border-radius:9px;background:#7c5cbf;color:#fff;font-weight:700;font-size:15px;cursor:pointer;">Unlock</button>' +
          '<div id="ms-err" style="color:#ff8a8a;font-size:13px;margin-top:12px;height:16px;"></div>' +
        '</div>' +
      '</div>';
    if (document.getElementById("ms-sitelock")) return;   // already shown
    var d = document.createElement("div"); d.id = "ms-sitelock"; d.innerHTML = html;
    (document.body || document.documentElement).appendChild(d);
    try { window.stop(); } catch (e) {}   // NOW halt the rest — gate is on screen, nothing else loads / can be charged
    var pw = document.getElementById("ms-pw"), err = document.getElementById("ms-err");
    function tryUnlock() {
      if (pw.value === PASSWORD) { try { localStorage.setItem(KEY, pw.value); } catch (e) {} location.reload(); }
      else { err.textContent = "Wrong password."; pw.value = ""; pw.focus(); }
    }
    document.getElementById("ms-go").onclick = tryUnlock;
    pw.addEventListener("keydown", function (e) { if (e.key === "Enter") tryUnlock(); });
    pw.focus();
  }
  // Show the gate ASAP against documentElement (always exists), before window.stop() halts parsing.
  gate();
  document.addEventListener("DOMContentLoaded", gate);   // harmless no-op if already shown
})();
