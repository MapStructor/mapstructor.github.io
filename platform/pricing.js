// MapStructor pricing — single source of truth for tiers + helpers.
// Business rule: charge for STORAGE only, never features. Storage is the only variable cost.
// Tiers/prices mirror business.md (Step 21). Quotas are in bytes.
(function () {
  var GB = 1024 * 1024 * 1024, MB = 1024 * 1024;
  var Pricing = {
    overagePerGb: 0.50,
    // Stripe (TEST mode for now — swap publishableKey + the price IDs for live keys at launch).
    // Publishable key is meant to be client-side; the SECRET key only ever lives in Supabase.
    stripe: {
      publishableKey: "pk_test_51TlkRALiMJ4gksrjjlaHC306lLrXPxCJ194wYZqPiCn8UAOjQHTgthmF5JMcoOIloUIMV6dkBq0S8VTCYpvfbJ3k00XyehhniJ",
      functionsBase: "https://eqpxlwbjqiwfjlsuapvu.supabase.co/functions/v1",   // Supabase Edge Functions (checkout / portal)
    },
    // order matters: used for the upgrade ladder
    order: ["free", "plus", "pro", "institutional"],
    tiers: {
      free:          { key: "free",          name: "Free",          priceMonthly: 0,  quotaBytes: 500 * MB,  stripePriceId: null },
      plus:          { key: "plus",          name: "Plus",          priceMonthly: 4,  quotaBytes: 5 * GB,    stripePriceId: "price_1TluYTLiMJ4gksrj28JlFQU6" },
      pro:           { key: "pro",           name: "Pro",           priceMonthly: 12, quotaBytes: 25 * GB,   stripePriceId: "price_1TluYULiMJ4gksrju0vPRXHr" },
      institutional: { key: "institutional", name: "Institutional", priceMonthly: 40, quotaBytes: 100 * GB, stripePriceId: "price_1TluYVLiMJ4gksrjAsOIjG0A" },
    },
    tierFor: function (key) { return this.tiers[key] || this.tiers.free; },
    nextTier: function (key) { var i = this.order.indexOf(key); return (i > -1 && i < this.order.length - 1) ? this.tiers[this.order[i + 1]] : null; },
    fmtBytes: function (b) {
      b = Number(b) || 0;
      if (b >= GB) return (b / GB).toFixed(b >= 10 * GB ? 0 : 1) + " GB";
      if (b >= MB) return (b / MB).toFixed(b >= 10 * MB ? 0 : 1) + " MB";
      if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
      return b + " B";
    },
    // 0..1 fraction of the tier's quota in use
    fraction: function (usedBytes, tierKey) {
      var q = this.tierFor(tierKey).quotaBytes;
      return q > 0 ? Math.min(1, (Number(usedBytes) || 0) / q) : 0;
    },
  };
  window.MapStructorPricing = Pricing;
})();
