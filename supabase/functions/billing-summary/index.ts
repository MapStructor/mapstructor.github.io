// Supabase Edge Function: billing-summary
// Read-only. Answers "what am I on, what am I paying, when does it renew, and where are my
// receipts?" in ONE call, so the dashboard can show all of that at the top of the page.
//
// 2026-08-30 — WHY THIS EXISTS. The owner bought a live subscription and got no confirmation and
// no receipt. Two separate holes:
//   1. Stripe's "email customers about successful payments" was off, so no receipt was ever sent
//      (verified on the live charge: receipt_email and receipt_number were both null while
//      receipt_url existed). That is a Dashboard setting with no API — the owner flips it.
//   2. Nothing in OUR product ever showed the purchase back to them. Even with Stripe's email on,
//      a receipt that exists only in an inbox is not good enough: the app should be able to show
//      you what you pay and hand you every receipt. That is this function.
// It reads from Stripe rather than a mirrored table on purpose: Stripe is the source of truth for
// money, and a copy would be one more thing that can silently drift (the 7/31 class of bug).
//
// Secret it needs: STRIPE_SECRET_KEY. Auto-provided: SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY (profiles is unreadable by its owner after the RLS lockdown).
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Pinned deliberately: on this version current_period_end lives on the SUBSCRIPTION. Newer
// versions moved it onto the subscription ITEM and it reads back null here, which would have
// shipped a plan card with a blank renewal date. Both shapes are handled below anyway.
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

// Same seven steps as PRICE_TO_TIER in stripe-webhook and stripePriceId in platform/pricing.js.
// stripe-price-map-gate.mjs compares every copy, so this one is included there too.
const PRICE_TO_TIER: Record<string, string> = {
  "price_1U9vt8Lx8hmpYH5q3BhJnH1V": "20gb",
  "price_1U9vt9Lx8hmpYH5q70HKvQnY": "50gb",
  "price_1U9vtALx8hmpYH5qmEGsGDiu": "100gb",
  "price_1U9vtBLx8hmpYH5qmqzra9nC": "250gb",
  "price_1U9vtCLx8hmpYH5qoUk7SZUP": "500gb",
  "price_1U9vtDLx8hmpYH5qxnAbMml2": "1tb",
  "price_1U9vtDLx8hmpYH5qJs2aJVWO": "2tb",
};

// active first, then the states that still mean "they have a plan". A status NOT in this table
// (canceled, incomplete, incomplete_expired) means they do NOT have a plan — those subs are
// filtered out entirely, not merely ranked last. 9/2: a refunded-and-canceled $1 sub was the only
// sub on an account whose profile had correctly dropped to free, and the card read
// "20 GB — not active / $0/month / 20 GB included" off the corpse. History belongs to the
// receipts list; the plan card answers only "what am I on NOW" (the profile tier when no live sub).
const RANK: Record<string, number> = { active: 0, trialing: 1, past_due: 2, unpaid: 3, paused: 4 };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "not authenticated" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: profile } = await admin.from("profiles")
      .select("stripe_customer_id, subscription_tier").eq("id", user.id).maybeSingle();
    const customerId = profile?.stripe_customer_id as string | undefined;
    const tier = (profile?.subscription_tier as string) || "free";

    // Never paid → a clean free answer, not an error. The card renders "Free plan · $0/mo".
    if (!customerId) return json({ tier, subscription: null, invoices: [], everPaid: false });

    // A customer id minted in TEST mode does not exist under the live key (see create-checkout-
    // session). Measured 8/30: 2 of 4 linked profiles were such orphans. Answer "free", the way an
    // unlinked account does — throwing here would put an error where the plan card should be.
    try {
      const c = await stripe.customers.retrieve(customerId);
      if ((c as { deleted?: boolean })?.deleted) return json({ tier, subscription: null, invoices: [], everPaid: false });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err?.code === "resource_missing" || /no such customer/i.test(err?.message ?? "")) {
        return json({ tier, subscription: null, invoices: [], everPaid: false, staleCustomer: true });
      }
      throw e;
    }

    const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
    const best = subs.data.filter((s) => RANK[s.status] != null).sort((a, b) =>
      RANK[a.status] - RANK[b.status] || (b.created - a.created))[0];

    let subscription: Record<string, unknown> | null = null;
    if (best) {
      const item = best.items?.data?.[0];
      const price = item?.price;
      // period end moved between API versions — take whichever one is populated
      const periodEnd = (best as unknown as { current_period_end?: number }).current_period_end
        ?? (item as unknown as { current_period_end?: number })?.current_period_end ?? null;
      subscription = {
        id: best.id,
        status: best.status,
        tier: PRICE_TO_TIER[price?.id ?? ""] || tier,
        amount: price?.unit_amount ?? null,          // cents
        currency: price?.currency ?? "usd",
        interval: price?.recurring?.interval ?? "month",
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: !!best.cancel_at_period_end,
        canceledAt: best.canceled_at ?? null,
        // when they cancel, service runs to here — the date the card promises them
        endsAt: best.cancel_at_period_end ? periodEnd : null,
        pendingChange: null as null | Record<string, unknown>,
      };

      // A DOWNGRADE is parked in a subscription schedule until the period ends (see change-plan).
      // Without this the card would keep saying "Renews 30 Sep" at someone who has already asked to
      // move down, which is the same class of silence as the missing receipt.
      if (best.schedule) {
        try {
          const sid = typeof best.schedule === "string" ? best.schedule : best.schedule.id;
          const sch = await stripe.subscriptionSchedules.retrieve(sid);
          const next = sch.phases?.[1];
          const nextPriceId = (next?.items?.[0] as { price?: string | { id: string } } | undefined)?.price;
          const pid = typeof nextPriceId === "string" ? nextPriceId : nextPriceId?.id;
          if (pid && pid !== price?.id) {
            const np = await stripe.prices.retrieve(pid);
            subscription.pendingChange = {
              tier: PRICE_TO_TIER[pid] || null,
              amount: np.unit_amount ?? null,
              currency: np.currency ?? "usd",
              startsAt: next?.start_date ?? periodEnd,
            };
          }
        } catch (_e) { /* a released or finished schedule is not an error */ }
      }
    }

    // Receipts. hosted_invoice_url is the page with the "Download receipt" button; invoice_pdf is
    // the direct file. Both are long-lived Stripe URLs, safe to hand to the signed-in owner of the
    // customer record and nobody else.
    const inv = await stripe.invoices.list({ customer: customerId, limit: 12 });
    const invoices = inv.data
      .filter((i) => i.status !== "draft" && i.status !== "void")
      .map((i) => ({
        id: i.id,
        number: i.number,
        created: i.created,
        total: i.total,
        currency: i.currency,
        status: i.status,               // paid | open | uncollectible
        paid: i.status === "paid",
        hostedUrl: i.hosted_invoice_url ?? null,
        pdf: i.invoice_pdf ?? null,
      }));

    return json({ tier, subscription, invoices, everPaid: invoices.length > 0 });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
