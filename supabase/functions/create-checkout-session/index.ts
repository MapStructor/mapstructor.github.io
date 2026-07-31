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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { priceId, tier, successUrl, cancelUrl } = await req.json();
    if (!priceId) return json({ error: "missing priceId" }, 400);

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
      metadata: { user_id: user.id, tier: tier ?? "" },
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
