// Supabase Edge Function: stripe-reconcile
// The reconciliation path (todo item 4): the webhook is the ONLY thing that grants a paid
// tier, so if it errors persistently someone can pay and get nothing (or cancel and keep
// paid storage). This function re-checks every Stripe-linked profile against Stripe's own
// records — the truth — and fixes any drift, then reports what it found.
//
// Called from admin.html (Plans → "Reconcile with Stripe"). Admin-only: deploy WITH JWT
// verification ON (the default), and the caller's email must be on the allow-list below.
//
// Secrets it needs (already set for the other functions):
//   STRIPE_SECRET_KEY
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ADMIN_EMAILS = ["nittyjee@gmail.com"];

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Price → step key. MUST stay identical to stripe-webhook's map (change both together).
const PRICE_TO_TIER: Record<string, string> = {
  // TEST-mode storage prices (created 2026-07-29). Swap for the sk_live_ price IDs at launch.
  "price_1U9vt8Lx8hmpYH5q3BhJnH1V": "20gb",
  "price_1U9vt9Lx8hmpYH5q70HKvQnY": "50gb",
  "price_1U9vtALx8hmpYH5qmEGsGDiu": "100gb",
  "price_1U9vtBLx8hmpYH5qmqzra9nC": "250gb",
  "price_1U9vtCLx8hmpYH5qoUk7SZUP": "500gb",
  "price_1U9vtDLx8hmpYH5qxnAbMml2": "1tb",
  "price_1U9vtDLx8hmpYH5qJs2aJVWO": "2tb",
  // retired named-tier prices (archived in Stripe) — still resolve via pricing.js legacy aliases
  "price_1TluYTLiMJ4gksrj28JlFQU6": "plus",
  "price_1TluYULiMJ4gksrju0vPRXHr": "pro",
  "price_1TluYVLiMJ4gksrjAsOIjG0A": "institutional",
};
// Same dunning rule as the webhook: past_due KEEPS the tier during Stripe's retry window.
const KEEP = new Set(["active", "trialing", "past_due"]);
// If a customer somehow has several keep-status subscriptions, grant the LARGEST quota.
// Ranks follow pricing.js (legacy aliases rank at their step's quota).
const RANK: Record<string, number> = {
  free: 0, plus: 1, "20gb": 1, pro: 2, "50gb": 2, institutional: 3, "100gb": 3,
  "250gb": 4, "500gb": 5, "1tb": 6, "2tb": 7,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // admin gate — the platform JWT gets us past the gateway; only the admin gets past this
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await admin.auth.getUser(token);
    const email = (caller?.user?.email ?? "").toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return json({ error: "not authorized" }, 403);

    const { data: profiles, error } = await admin.from("profiles")
      .select("id,email,subscription_tier,stripe_customer_id")
      .not("stripe_customer_id", "is", null);
    if (error) return json({ error: error.message }, 500);

    const report = {
      checked: 0,
      fixed: [] as { email: string | null; from: string; to: string }[],
      errors: [] as { email: string | null; error: string }[],
      flagged: [] as { email: string | null; note: string }[],
    };

    for (const p of profiles ?? []) {
      try {
        const subs = await stripe.subscriptions.list({ customer: p.stripe_customer_id, status: "all", limit: 10 });
        let tier = "free";
        for (const s of subs.data) {
          if (!KEEP.has(s.status)) continue;
          const t = PRICE_TO_TIER[s.items?.data?.[0]?.price?.id ?? ""];
          if (t && (RANK[t] ?? 0) > (RANK[tier] ?? 0)) tier = t;
        }
        report.checked++;
        const current = p.subscription_tier || "free";
        if (current !== tier) {
          await admin.from("profiles").update({ subscription_tier: tier }).eq("id", p.id);
          report.fixed.push({ email: p.email, from: current, to: tier });
        }
      } catch (e) {
        report.errors.push({ email: p.email, error: String((e as Error)?.message ?? e) });
      }
    }

    // paid tier but NO Stripe customer — nothing to reconcile against; report, never touch
    // (could be a hand-granted tier; a human decides)
    const { data: odd } = await admin.from("profiles")
      .select("email,subscription_tier")
      .is("stripe_customer_id", null)
      .neq("subscription_tier", "free");
    for (const o of odd ?? []) {
      report.flagged.push({ email: o.email, note: "tier '" + o.subscription_tier + "' with no Stripe customer — hand-granted?" });
    }

    return json(report);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
