// Supabase Edge Function: create-checkout-session
// Called by the dashboard "Upgrade" buttons. Creates a Stripe Checkout Session (subscription) for the
// signed-in user and returns its URL. The browser then redirects to Stripe-hosted checkout.
//
// Secrets it needs (set in Supabase → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY            your Stripe (test, then live) secret key
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// 2026-07-31 — WHY THERE ARE TWO CLIENTS NOW. The user's own client is used to answer "who is
// this?", and nothing else. Writing `stripe_customer_id` needs the SERVICE-ROLE client, because
// after the RLS lockdown (7/30) an ordinary user cannot write their own profiles row — the upsert
// here returned 42501 and the code ignored the error, so the id was never stored. The webhook
// finds the payer by exactly that column, so the effect was: checkout opens, the card is charged,
// the webhook matches zero rows, and the customer stays on the free tier with nothing logged
// anywhere. Found on 7/31 by actually paying with a test card on a fresh account.
//
// It also now REFUSES to open checkout if that write fails. Taking money we then can't honour is
// worse than not taking it.
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

// The price IDs that correspond to a real step. Must equal the keys of PRICE_TO_TIER in
// stripe-webhook and the stripePriceId values in platform/pricing.js — three copies of one fact,
// which is why `stripe-price-map-gate.mjs` compares all three rather than trusting this comment.
const KNOWN_PRICES = new Set([
  "price_1U9vt8Lx8hmpYH5q3BhJnH1V",  // 20gb
  "price_1U9vt9Lx8hmpYH5q70HKvQnY",  // 50gb
  "price_1U9vtALx8hmpYH5qmEGsGDiu",  // 100gb
  "price_1U9vtBLx8hmpYH5qmqzra9nC",  // 250gb
  "price_1U9vtCLx8hmpYH5qoUk7SZUP",  // 500gb
  "price_1U9vtDLx8hmpYH5qxnAbMml2",  // 1tb
  "price_1U9vtDLx8hmpYH5qJs2aJVWO",  // 2tb
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { priceId, tier, successUrl, cancelUrl } = await req.json();
    if (!priceId) return json({ error: "missing priceId" }, 400);
    // 2026-08-22 — defence in depth for the metadata.tier hole (see stripe-webhook). The webhook now
    // derives the tier from the price it was actually charged, so a forged `tier` can no longer
    // grant anything. This second check refuses a priceId that is not one of our steps at all, so a
    // stale or archived price cannot open a checkout that the webhook will then have to refuse
    // AFTER the card is charged. Keep in sync with pricing.js — `stripe-price-map-gate.mjs` holds it.
    if (!KNOWN_PRICES.has(priceId)) {
      return json({ error: "unknown price — nothing was charged" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "not authenticated" }, 401);

    // Reuse the user's Stripe customer, or create one and remember it on the profile.
    // Both reads and the write go through the SERVICE-ROLE client: the user cannot write this
    // column themselves, and a silent failure here means a paid customer never gets their storage.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: profile } = await admin.from("profiles").select("stripe_customer_id").eq("id", user.id).maybeSingle();
    let customerId = profile?.stripe_customer_id as string | undefined;

    // 2026-08-30 — THE TEST→LIVE ORPHAN. Customer ids do not cross modes. Every account that went
    // through checkout while we were in test mode still had a `cus_…` that does not exist under the
    // live key, so `checkout.sessions.create({ customer })` failed and THOSE ACCOUNTS COULD NOT BUY
    // ANYTHING. Measured on 8/30: 2 of the 4 linked profiles were orphans, including the owner's own
    // main account. A stale link must therefore be treated as no link — verify, then re-create.
    if (customerId) {
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if ((existing as { deleted?: boolean })?.deleted) customerId = undefined;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        if (err?.code === "resource_missing" || /no such customer/i.test(err?.message ?? "")) {
          customerId = undefined;   // orphan from the other mode — fall through and make a real one
        } else {
          throw e;
        }
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email ?? undefined, metadata: { user_id: user.id } });
      customerId = customer.id;
      const { error: linkErr } = await admin.from("profiles")
        .upsert({ id: user.id, stripe_customer_id: customerId }, { onConflict: "id" });
      if (linkErr) {
        // do NOT send them to a payment page we can't act on
        return json({ error: "could not link your account to billing — nothing was charged. " + linkErr.message }, 500);
      }
      // read it back: an upsert that "succeeds" but writes nothing is the exact failure mode
      const { data: check } = await admin.from("profiles").select("stripe_customer_id").eq("id", user.id).maybeSingle();
      if (check?.stripe_customer_id !== customerId) {
        return json({ error: "could not link your account to billing — nothing was charged." }, 500);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // both real callers pass these; the fallback used to be example.com, which would have
      // dropped a paying customer on somebody else's website
      success_url: successUrl || "https://mapstructor.com/dashboard.html",
      cancel_url: cancelUrl || "https://mapstructor.com/dashboard.html",
      client_reference_id: user.id,
      // `requested_tier`, not `tier`: it is what the browser ASKED for and grants nothing. It was
      // called `tier` and the webhook trusted it, which is how the escalation worked. The name now
      // says what it is, so the next reader cannot mistake it for an authority.
      metadata: { user_id: user.id, requested_tier: tier ?? "" },
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
