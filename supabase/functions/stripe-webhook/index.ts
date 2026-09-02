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
  // LIVE storage prices (created 2026-08-29).
  "price_1U9vt8Lx8hmpYH5q3BhJnH1V": "20gb",
  "price_1U9vt9Lx8hmpYH5q70HKvQnY": "50gb",
  "price_1U9vtALx8hmpYH5qmEGsGDiu": "100gb",
  "price_1U9vtBLx8hmpYH5qmqzra9nC": "250gb",
  "price_1U9vtCLx8hmpYH5qoUk7SZUP": "500gb",
  "price_1U9vtDLx8hmpYH5qxnAbMml2": "1tb",
  "price_1U9vtDLx8hmpYH5qJs2aJVWO": "2tb",
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
        // 2026-09-01 — DONATIONS ARE NOT PLANS. The donate function stamps every donation session
        // metadata.donation="1". Without this exit, a donation's ad-hoc price maps to no step and
        // the throw below would 500 → Stripe retries the event forever. A donation grants nothing
        // and touches no profile — say thanks in the logs and stop.
        if (s.metadata?.donation === "1") {
          console.log(`donation received: session ${s.id}, ${s.amount_total} ${s.currency}`);
          break;
        }
        const userId = (s.client_reference_id as string) || (s.metadata?.user_id as string) || undefined;
        // 2026-08-22 — SECURITY. This used to read `metadata.tier` FIRST and only fall back to the
        // line item. `metadata.tier` is whatever the browser sent to create-checkout-session, and
        // nothing checked it against `priceId`. So a signed-in user could ask for the £1 20 GB
        // price with `tier: "2tb"`, pay £1, and be granted the £45 step — enforced for real, because
        // `enforce_storage_quota` is a database trigger that maps subscription_tier to a byte cap.
        // Found before launch, while payments were still in test mode with no bank account attached.
        //
        // THE RULE NOW: the tier is derived from the price Stripe actually charged, and from
        // nothing else. Client metadata is a diagnostic breadcrumb, never an authority.
        const li = await stripe.checkout.sessions.listLineItems(s.id, { limit: 1 });
        const paidPriceId = li.data?.[0]?.price?.id ?? "";
        const tier = PRICE_TO_TIER[paidPriceId] || "";
        if (!tier) {
          throw new Error(`session ${s.id} paid for price ${paidPriceId || "(none)"}, which maps to no step — ` +
            `refusing to grant anything. Add it to PRICE_TO_TIER if it is a real step.`);
        }
        // Log a mismatch rather than swallow it: with the hole closed, a difference here is either
        // a stale client or somebody probing, and both are worth seeing in the function logs.
        const asked = (s.metadata?.requested_tier as string) || (s.metadata?.tier as string) || "";
        if (asked && asked !== tier) {
          console.warn(`tier mismatch on ${s.id}: client asked for "${asked}", price ${paidPriceId} is "${tier}". Granting "${tier}".`);
        }
        await setTier(tier, { userId, customerId: (s.customer as string) || undefined });
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        if (sub.metadata?.donation === "1") break;   // monthly donation — no step to keep or drop
        const priceId = sub.items?.data?.[0]?.price?.id ?? "";
        // Honor Stripe's dunning window: a failed renewal goes `past_due` while Stripe retries
        // (~2 weeks by default) — the user KEEPS their storage during that grace. Only drop to
        // free on terminal states (unpaid = retries exhausted, canceled, incomplete_expired,
        // paused). A real cancellation also fires subscription.deleted → free.
        const keepTier = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
        const cid = sub.customer as string;
        // 2026-08-22 — this was `PRICE_TO_TIER[priceId] || "free"`, so a price missing from the map
        // DOWNGRADED A PAYING CUSTOMER TO FREE, silently, on their next subscription event. Adding a
        // Stripe price without editing this file was all it took. Absence is not a downgrade: raise
        // instead, so Stripe retries, the event sits in the dashboard unresolved, and somebody finds
        // out. The customer keeps what they had in the meantime, which is the safe direction.
        let next = "free";
        if (keepTier) {
          next = PRICE_TO_TIER[priceId] || "";
          if (!next) {
            throw new Error(`subscription ${sub.id} is ${sub.status} on price ${priceId || "(none)"}, ` +
              `which maps to no step — refusing to downgrade them to free over a missing mapping.`);
          }
        }
        await setTier(next, { userId: await userIdForCustomer(cid), customerId: cid });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        if (sub.metadata?.donation === "1") break;   // a lapsed monthly donation downgrades nobody
        const cid = sub.customer as string;
        await setTier("free", { userId: await userIdForCustomer(cid), customerId: cid });
        break;
      }
      case "charge.refunded": {
        // 2026-09-01 — the owner's rule: A REFUND IS A CANCELLATION. They refunded a plan's $1
        // charge from the Stripe Dashboard and the plan lived on — Stripe returns the money but
        // never touches the subscription, and nothing here listened for refunds. Now: a FULLY
        // refunded charge that paid a subscription invoice cancels that subscription immediately;
        // the customer.subscription.deleted event that follows walks the one existing downgrade
        // path (no second tier-writer). Partial refunds change nothing — `refunded` is only true
        // once every cent went back. A charge with no invoice is a one-time payment (donations),
        // which granted nothing and so has nothing to revoke.
        const ch = event.data.object as Stripe.Charge;
        if (!ch.refunded) break;
        const invId = typeof ch.invoice === "string" ? ch.invoice : ch.invoice?.id ?? "";
        if (!invId) break;
        const inv = await stripe.invoices.retrieve(invId);
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id ?? "";
        if (!subId) break;
        let sub: Stripe.Subscription;
        try { sub = await stripe.subscriptions.retrieve(subId); }
        catch { break; }                       // subscription already deleted — nothing to cancel
        if (sub.status === "canceled") break;  // already canceled — the deleted event owns the tier
        // Monthly donations cancel too (a refunded donor must not be charged again) — their
        // deleted event early-exits above, so tiers stay untouched either way.
        await stripe.subscriptions.cancel(subId);
        console.log(`charge ${ch.id} fully refunded -> subscription ${subId} canceled` +
          (sub.metadata?.donation === "1" ? " (donation)" : ""));
        break;
      }
    }
  } catch (e) {
    return new Response("handler error: " + String((e as Error)?.message ?? e), { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
