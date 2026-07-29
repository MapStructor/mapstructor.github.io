// MapStructor pricing — single source of truth for the STORAGE ladder + helpers.
// Authoritative model: mapstructor_docs/planning/current/mapstructor_architecture.md
// ("Pricing (for when it's needed)") + mapstructor_decisions.md ("Storage-only pricing").
// Rules, absolute (from those docs — don't relitigate here):
//   · Storage is the ONLY thing charged for. Maps, views, features, API — unlimited at every step.
//   · NO overages, ever. Hit the limit → a message and an upgrade button. Nothing auto-charges.
//   · NO tier names. Steps are amounts ("20 GB"), never "Pro". No feature-gating between steps.
//   · NO metering. Nobody is told they used 847,293 of anything (a storage bar is a limit, not a meter).
//   · Existing users keep their price permanently — never rewrite a signed-up user's price from here.
//   · The free step is 1 GB and only ever grows. Over 2 TB → contact.
// AI pricing is a SEPARATE add-on and does not belong in this file.
(function () {
  var KB = 1024, MB = KB * 1024, GB = MB * 1024, TB = GB * 1024;
  var Pricing = {
    // Stripe (TEST mode for now — swap publishableKey + the price IDs for live keys at launch).
    // Publishable key is meant to be client-side; the SECRET key only ever lives in Supabase.
    stripe: {
      publishableKey: "pk_test_51TlkRALiMJ4gksrjjlaHC306lLrXPxCJ194wYZqPiCn8UAOjQHTgthmF5JMcoOIloUIMV6dkBq0S8VTCYpvfbJ3k00XyehhniJ",
      functionsBase: "https://eqpxlwbjqiwfjlsuapvu.supabase.co/functions/v1",   // Supabase Edge Functions (checkout / portal)
    },
    contactEmail: "hello@mapstructor.com",   // the over-2TB "contact us" door
    // The ladder: flat, ascending. `key` is what profiles.subscription_tier stores; `label` is
    // what users see. stripePriceId: TODO(user) — create one Stripe price per PAID step, paste the
    // IDs here AND in supabase/functions/stripe-webhook/index.ts (PRICE_TO_TIER).
    steps: [
      { key: "free",  label: "Free",   priceMonthly: 0,  quotaBytes: 1 * GB,   stripePriceId: null },
      { key: "20gb",  label: "20 GB",  priceMonthly: 1,  quotaBytes: 20 * GB,  stripePriceId: "price_1TyfdDLiMJ4gksrjvk7Pq4H9" },  // TEST mode
      { key: "50gb",  label: "50 GB",  priceMonthly: 2,  quotaBytes: 50 * GB,  stripePriceId: "price_1TyfcrLiMJ4gksrjTYBnOSmY" },  // TEST mode
      { key: "100gb", label: "100 GB", priceMonthly: 4,  quotaBytes: 100 * GB, stripePriceId: "price_1TyfcrLiMJ4gksrj7La8hSx5" },  // TEST mode
      { key: "250gb", label: "250 GB", priceMonthly: 8,  quotaBytes: 250 * GB, stripePriceId: "price_1TyfcsLiMJ4gksrjQ5dryqtl" },  // TEST mode
      { key: "500gb", label: "500 GB", priceMonthly: 15, quotaBytes: 500 * GB, stripePriceId: "price_1TyfctLiMJ4gksrjUkNCEhz3" },  // TEST mode
      { key: "1tb",   label: "1 TB",   priceMonthly: 25, quotaBytes: 1 * TB,   stripePriceId: "price_1TyfcuLiMJ4gksrj1lisLpi3" },  // TEST mode
      { key: "2tb",   label: "2 TB",   priceMonthly: 45, quotaBytes: 2 * TB,   stripePriceId: "price_1TyfcuLiMJ4gksrjN2OMgPVH" },  // TEST mode
    ],
    // Legacy named tiers (test-mode era, superseded 2026-07-27). Every alias resolves to a step
    // with MORE storage at a LOWER price, so a profile still carrying an old key only gains:
    // plus $4/5GB → $1/20GB · pro $12/25GB → $2/50GB · institutional $40/100GB → $4/100GB.
    legacy: { plus: "20gb", pro: "50gb", institutional: "100gb" },
    // stored subscription value (or null/unknown) → its step; default = the free step
    stepFor: function (key) {
      key = this.legacy[key] || key;
      for (var i = 0; i < this.steps.length; i++) if (this.steps[i].key === key) return this.steps[i];
      return this.steps[0];
    },
    // the step after the current one, or null (top of the ladder → contact)
    nextStep: function (key) {
      var i = this.steps.indexOf(this.stepFor(key));
      return i < this.steps.length - 1 ? this.steps[i + 1] : null;
    },
    // the smallest step that HOLDS this usage — "the next step above current usage", not "the
    // next named tier". null = past 2 TB → contact.
    stepForUsage: function (usedBytes) {
      var u = Number(usedBytes) || 0;
      for (var i = 0; i < this.steps.length; i++) if (u <= this.steps[i].quotaBytes) return this.steps[i];
      return null;
    },
    // every step above the current one (the dashboard's upgrade buttons)
    upgradesFrom: function (key) {
      var cur = this.stepFor(key);
      return this.steps.filter(function (s) { return s.quotaBytes > cur.quotaBytes; });
    },
    fmtBytes: function (b) {
      b = Number(b) || 0;
      function n(x, d) { return x.toFixed(d).replace(/\.0$/, ""); }
      if (b >= TB) return n(b / TB, b >= 10 * TB ? 0 : 1) + " TB";
      if (b >= GB) return n(b / GB, b >= 10 * GB ? 0 : 1) + " GB";
      if (b >= MB) return n(b / MB, b >= 10 * MB ? 0 : 1) + " MB";
      if (b >= KB) return (b / KB).toFixed(0) + " KB";
      return b + " B";
    },
    // 0..1 fraction of the step's quota in use
    fraction: function (usedBytes, key) {
      var q = this.stepFor(key).quotaBytes;
      return q > 0 ? Math.min(1, (Number(usedBytes) || 0) / q) : 0;
    },
  };
  window.MapStructorPricing = Pricing;
})();
