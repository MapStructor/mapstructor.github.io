// Supabase Edge Function: donate
// Public (verify_jwt=false — donors are usually not signed in). Creates a Stripe Checkout Session
// for a donation and returns its URL: one-time (mode=payment, Stripe's "Donate" submit button) or
// monthly (mode=subscription). Amounts come from the browser in cents, clamped to $1–$9,999.
//
// DONATIONS NEVER TOUCH TIERS. Every session and every donation subscription is stamped
// metadata.donation="1"; stripe-webhook early-exits on that stamp, so a donation can never grant,
// change, or revoke anyone's storage step (the webhook otherwise throws on unknown prices — by
// design — and donation prices are ad-hoc price_data, i.e. always unknown).
//
// Products: found-or-created once per instance by name+metadata (the live secret key exists only
// in Edge secrets, so products could not be pre-created from a dev machine).
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

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

const productCache: Record<string, string> = {};
async function productId(name: string): Promise<string> {
  if (productCache[name]) return productCache[name];
  const found = await stripe.products.search({ query: `active:'true' AND name:'${name}'` });
  const hit = found.data.find((p) => p.metadata?.donation === "1");
  if (hit) return (productCache[name] = hit.id);
  const made = await stripe.products.create({ name, metadata: { donation: "1" } });
  return (productCache[name] = made.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { amount_cents, recurring, successUrl, cancelUrl } = await req.json();
    const cents = Number(amount_cents);
    if (!Number.isInteger(cents) || cents < 100 || cents > 999900) {
      return json({ error: "amount must be between $1 and $9,999" }, 400);
    }
    const monthly = recurring === true;
    const prod = await productId(monthly ? "MapStructor Monthly Support" : "MapStructor Donation");
    // Payment methods are EXPLICIT (owner 9/1: "There should be no 'Pay Later' option haha").
    // Automatic methods surfaced Link, whose wallet offers 0%-interest installment plans on
    // one-time payments — donations on an installment plan is absurd. Listing types ourselves
    // keeps card + Cash App (+ Amazon Pay one-time, + Link on monthly, where subscriptions
    // cannot be financed) and drops every BNPL. A type not enabled on the account fails session
    // creation, so fall back to plain card rather than failing the donor.
    const wanted = monthly ? ["card", "cashapp", "link"] : ["card", "cashapp"];
    const base = {
      mode: monthly ? "subscription" : "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents,
          product: prod,
          ...(monthly ? { recurring: { interval: "month" } } : {}),
        },
      }],
      ...(monthly ? { subscription_data: { metadata: { donation: "1" } } } : { submit_type: "donate" }),
      metadata: { donation: "1" },
      success_url: successUrl || "https://mapstructor.com/services.html?donated=1",
      cancel_url: cancelUrl || "https://mapstructor.com/services.html",
    } as Stripe.Checkout.SessionCreateParams;
    let session: Stripe.Checkout.Session; let branch = "wanted"; let err0 = "";
    try {
      session = await stripe.checkout.sessions.create({ ...base, payment_method_types: wanted as Stripe.Checkout.SessionCreateParams.PaymentMethodType[] });
    } catch (e0) {
      branch = "card-only"; err0 = String((e0 as Error)?.message ?? e0).slice(0, 200);
      session = await stripe.checkout.sessions.create({ ...base, payment_method_types: ["card"] });
    }
    return json({ url: session.url, v: 5, branch, err0, pm: session.payment_method_types });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
