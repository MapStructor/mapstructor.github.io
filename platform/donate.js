// donate.js — the Donate panel, shared by services.html and about.html (9/1).
// Drop `<section id="ms-donate"></section>` where the panel belongs and include this script.
// The panel is CODE, deliberately outside the page editor's data-edit regions (an editable copy
// would get absorbed into site_content and duplicated) — wording changes here, not in the CMS.
// Buttons call the public `donate` edge function → Stripe Checkout (one-time = payment mode with
// Stripe's Donate button; monthly = subscription). Donations never touch storage tiers (the
// webhook early-exits on metadata.donation).
(function () {
  var FN = "https://eqpxlwbjqiwfjlsuapvu.supabase.co/functions/v1/donate";
  function mount() {
    var host = document.getElementById("ms-donate");
    if (!host || host.dataset.msdnReady) return;
    host.dataset.msdnReady = "1";
    host.style.cssText = "display:block;margin:26px 0 10px;padding:20px 22px;border:1px solid #e3ddf2;border-radius:12px;background:#fff;font-family:'Source Sans Pro',system-ui,Arial,sans-serif;color:#1e1b2e;";
    host.innerHTML =
      '<div style="font-weight:800;font-size:19px;margin-bottom:4px;">Donate</div>' +
      '<div class="msdn-note" style="font-size:13px;color:#6b6580;margin-bottom:12px;">Secure checkout by Stripe.</div>' +
      '<div style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9a93ad;margin-bottom:6px;">One-time</div>' +
      '<div class="msdn-row" data-recurring="false" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">' +
        '<button class="msdn-amt" data-cents="500">$5</button>' +
        '<button class="msdn-amt" data-cents="1000">$10</button>' +
        '<button class="msdn-amt" data-cents="2500">$25</button>' +
        '<button class="msdn-amt" data-cents="5000">$50</button>' +
        '<button class="msdn-amt" data-cents="10000">$100</button>' +
        '<span class="msdn-custom"><input type="number" min="1" max="9999" placeholder="Other $" class="msdn-in" /><button class="msdn-go">Give</button></span>' +
      '</div>' +
      '<div style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9a93ad;margin-bottom:6px;">Monthly</div>' +
      '<div class="msdn-row" data-recurring="true" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">' +
        '<button class="msdn-amt" data-cents="200">$2</button>' +
        '<button class="msdn-amt" data-cents="500">$5</button>' +
        '<button class="msdn-amt" data-cents="1000">$10</button>' +
        '<button class="msdn-amt" data-cents="1500">$15</button>' +
        '<button class="msdn-amt" data-cents="2500">$25</button>' +
        '<span class="msdn-custom"><input type="number" min="1" max="9999" placeholder="Other $/mo" class="msdn-in" /><button class="msdn-go">Give monthly</button></span>' +
      '</div>' +
      // supporting partner — prominent, email on its own line (owner 9/1: "Bold, add line break")
      '<div style="margin-top:4px;padding:12px 14px;border:1px solid #e3ddf2;border-radius:9px;background:#faf9fd;font-size:15.5px;color:#1e1b2e;">' +
        '<b>Want to be a supporting partner?</b><br>' +
        '<a href="mailto:info@mapstructor.com" style="color:#7c5cbf;font-weight:700;font-size:16px;">info@mapstructor.com</a>' +
      '</div>';
    if (!document.getElementById("msdn-css")) {
      var st = document.createElement("style"); st.id = "msdn-css";
      st.textContent =
        "#ms-donate .msdn-amt, #ms-donate .msdn-go { border: 1px solid #cdc6e0; border-radius: 8px; background: #f4f1fa; color: #4a3f66; font-weight: 700; font-size: 14px; padding: 8px 14px; cursor: pointer; }" +
        "#ms-donate .msdn-amt:hover, #ms-donate .msdn-go:hover { background: #7c5cbf; border-color: #7c5cbf; color: #fff; }" +
        "#ms-donate .msdn-custom { display: inline-flex; gap: 6px; align-items: stretch; }" +
        "#ms-donate .msdn-in { width: 92px; border: 1px solid #cdc6e0; border-radius: 8px; padding: 8px 10px; font-size: 14px; }" +
        "#ms-donate button[disabled] { opacity: .55; cursor: default; }";
      document.head.appendChild(st);
    }
    function note(t, warn) { var n = host.querySelector(".msdn-note"); if (n) { n.textContent = t; n.style.color = warn ? "#b4453a" : "#6b6580"; } }
    function go(cents, recurring, btn) {
      if (!Number.isInteger(cents) || cents < 100 || cents > 999900) { note("Enter an amount from $1 to $9,999", true); return; }   // cliff-ok: the note() IS the announcement, in the user's own terms
      var old = btn.textContent; btn.disabled = true; btn.textContent = "Opening…";
      fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: cents, recurring: recurring,
          successUrl: location.origin + location.pathname + "?donated=1", cancelUrl: location.href }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d && d.url) location.href = d.url; else { note((d && d.error) || "Something went wrong — nothing was charged.", true); btn.disabled = false; btn.textContent = old; } })
        .catch(function () { note("Could not reach checkout — nothing was charged.", true); btn.disabled = false; btn.textContent = old; });
    }
    host.querySelectorAll(".msdn-row").forEach(function (row) {
      var rec = row.getAttribute("data-recurring") === "true";
      row.querySelectorAll(".msdn-amt").forEach(function (b) { b.addEventListener("click", function () { go(+b.getAttribute("data-cents"), rec, b); }); });
      var inp = row.querySelector(".msdn-in"), goBtn = row.querySelector(".msdn-go");
      goBtn.addEventListener("click", function () { go(Math.round(parseFloat(inp.value || "0") * 100), rec, goBtn); });
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") goBtn.click(); });
    });
    if (new URLSearchParams(location.search).get("donated") === "1") {
      note("Thank you! Your donation went through. 💛", false);
      host.scrollIntoView({ block: "center" });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
