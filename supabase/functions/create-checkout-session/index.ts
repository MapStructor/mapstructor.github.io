// Supabase Edge Function: create-checkout-session
// Called by the dashboard "Upgrade" buttons. Creates a Stripe Checkout Session (subscription) for the
// signed-in user and returns its URL. The browser then redirects to Stripe-hosted checkout.
//
// Secrets it needs (set in Supabase → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY            your Stripe (test, then live) secret key
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY
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
    const { data: profile } = await supabase.from("profiles").select("stripe_customer_id").eq("id", user.id).maybeSingle();
    let customerId = profile?.stripe_customer_id as string | undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email ?? undefined, metadata: { user_id: user.id } });
      customerId = customer.id;
      await supabase.from("profiles").upsert({ id: user.id, stripe_customer_id: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || "https://example.com/dashboard.html",
      cancel_url: cancelUrl || "https://example.com/dashboard.html",
      client_reference_id: user.id,
      metadata: { user_id: user.id, tier: tier ?? "" },
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
