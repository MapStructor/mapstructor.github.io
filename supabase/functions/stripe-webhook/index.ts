// Supabase Edge Function: stripe-webhook
// Stripe calls this on payment/subscription events. It verifies the signature, then writes the user's
// tier onto their profile. Uses the SERVICE ROLE key so it can update any profile (Stripe is trusted).
//
// Secrets it needs (Supabase → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY            your Stripe secret key
//   STRIPE_WEBHOOK_SECRET        the signing secret Stripe shows when you add the webhook endpoint
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// IMPORTANT: deploy this function with JWT verification OFF (Stripe can't send a Supabase JWT).
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Map a Stripe price → our tier. Keep in sync with platform/pricing.js.
const PRICE_TO_TIER: Record<string, string> = {
  "price_1TluYTLiMJ4gksrj28JlFQU6": "plus",
  "price_1TluYULiMJ4gksrju0vPRXHr": "pro",
  "price_1TluYVLiMJ4gksrjAsOIjG0A": "institutional",
};

async function setTierByCustomer(customerId: string, tier: string) {
  await admin.from("profiles").update({ subscription_tier: tier }).eq("stripe_customer_id", customerId);
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!);
  } catch (e) {
    return new Response("invalid signature: " + String((e as Error)?.message ?? e), { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const tier = (s.metadata?.tier as string) || "";
        if (s.customer && tier) await setTierByCustomer(s.customer as string, tier);
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const priceId = sub.items?.data?.[0]?.price?.id ?? "";
        const active = sub.status === "active" || sub.status === "trialing";
        await setTierByCustomer(sub.customer as string, active ? (PRICE_TO_TIER[priceId] || "free") : "free");
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await setTierByCustomer(sub.customer as string, "free");
        break;
      }
    }
  } catch (e) {
    return new Response("handler error: " + String((e as Error)?.message ?? e), { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
