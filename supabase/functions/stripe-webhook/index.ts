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

// Map a Stripe price → our storage step key. Keep in sync with platform/pricing.js (steps[].key).
// TODO(user): create one Stripe price per paid step (20gb $1 · 50gb $2 · 100gb $4 · 250gb $8 ·
// 500gb $15 · 1tb $25 · 2tb $45, all monthly) and paste the IDs below AND into pricing.js.
const PRICE_TO_TIER: Record<string, string> = {
  // TEST-mode storage prices (created 2026-07-29). Swap for the sk_live_ price IDs at launch.
  "price_1TyfdDLiMJ4gksrjvk7Pq4H9": "20gb",
  "price_1TyfcrLiMJ4gksrjTYBnOSmY": "50gb",
  "price_1TyfcrLiMJ4gksrj7La8hSx5": "100gb",
  "price_1TyfcsLiMJ4gksrjQ5dryqtl": "250gb",
  "price_1TyfctLiMJ4gksrjUkNCEhz3": "500gb",
  "price_1TyfcuLiMJ4gksrj1lisLpi3": "1tb",
  "price_1TyfcuLiMJ4gksrjN2OMgPVH": "2tb",
  // retired named-tier prices (now archived in Stripe) — left resolving so any lingering test
  // subscription still lands on a step via pricing.js's legacy aliases:
  "price_1TluYTLiMJ4gksrj28JlFQU6": "plus",
  "price_1TluYULiMJ4gksrju0vPRXHr": "pro",
  "price_1TluYVLiMJ4gksrjAsOIjG0A": "institutional",
};

// 2026-07-31 — this used to be a fire-and-forget update matched ONLY on stripe_customer_id, and
// it silently matched zero rows whenever that column was blank (which it always was, after the
// RLS lockdown broke the write in create-checkout-session). A payment handler that can quietly
// do nothing is the worst shape for this code, so it now: matches on the user id when Stripe
// gives us one, repairs the customer link while it's there, and RAISES if it changed no rows —
// a 500 makes Stripe retry, which is exactly what should happen.
async function setTier(tier: string, opts: { customerId?: string; userId?: string }) {
  if (!opts.userId && !opts.customerId) {
    throw new Error("no way to identify the payer — refusing to update a tier blindly");
  }
  const patch: Record<string, unknown> = { subscription_tier: tier };
  if (opts.customerId) patch.stripe_customer_id = opts.customerId;   // self-heal the link

  let q = admin.from("profiles").update(patch).select("id");
  q = opts.userId ? q.eq("id", opts.userId) : q.eq("stripe_customer_id", opts.customerId!);

  const { data, error } = await q;
  if (error) throw new Error("profile update failed: " + error.message);
  if (!data || data.length === 0) {
    throw new Error(`no profile matched (user=${opts.userId ?? "-"} customer=${opts.customerId ?? "-"}) — tier NOT set`);
  }
}

// For subscription events Stripe hands us a customer, not a user. Resolve one to the other so the
// same "match by id" path can be used, instead of trusting a column that might be empty.
async function userIdForCustomer(customerId: string): Promise<string | undefined> {
  const { data } = await admin.from("profiles").select("id").eq("stripe_customer_id", customerId).maybeSingle();
  if (data?.id) return data.id as string;
  try {   // fall back to the metadata we set when the customer was created
    const c = await stripe.customers.retrieve(customerId);
    const uid = (c as Stripe.Customer)?.metadata?.user_id;
    return uid || undefined;
  } catch { return undefined; }
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
        const userId = (s.client_reference_id as string) || (s.metadata?.user_id as string) || undefined;
        // the tier the client asked for, or — if that's missing — whatever they actually bought
        let tier = (s.metadata?.tier as string) || "";
        if (!tier) {
          const li = await stripe.checkout.sessions.listLineItems(s.id, { limit: 1 });
          tier = PRICE_TO_TIER[li.data?.[0]?.price?.id ?? ""] || "";
        }
        if (!tier) throw new Error("could not work out which step was bought for session " + s.id);
        await setTier(tier, { userId, customerId: (s.customer as string) || undefined });
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const priceId = sub.items?.data?.[0]?.price?.id ?? "";
        // Honor Stripe's dunning window: a failed renewal goes `past_due` while Stripe retries
        // (~2 weeks by default) — the user KEEPS their storage during that grace. Only drop to
        // free on terminal states (unpaid = retries exhausted, canceled, incomplete_expired,
        // paused). A real cancellation also fires subscription.deleted → free.
        const keepTier = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
        const cid = sub.customer as string;
        await setTier(keepTier ? (PRICE_TO_TIER[priceId] || "free") : "free",
                      { userId: await userIdForCustomer(cid), customerId: cid });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const cid = sub.customer as string;
        await setTier("free", { userId: await userIdForCustomer(cid), customerId: cid });
        break;
      }
    }
  } catch (e) {
    return new Response("handler error: " + String((e as Error)?.message ?? e), { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
