// Supabase Edge Function: change-plan
// Moves an EXISTING subscription between steps, and resumes a pending cancellation.
//
// 2026-08-30 — WHY THIS EXISTS. Until today the dashboard's "Upgrade to 50 GB" button opened a
// fresh Checkout, and Stripe lets one customer hold several subscriptions (confirmed against the
// live account: a second session was created for a customer who already had one, and nothing
// objected). So an upgrade left the customer paying $1 + $2 for one 50 GB account, with the app
// showing the right tier and nothing anywhere admitting to the double charge. There was also no
// downgrade path at all — the only route down was cancel-and-rejoin, which breaks the Terms'
// promise that "the price you signed up at stays your price for as long as your subscription runs
// continuously".
//
// THE RULE: one customer, one subscription. Checkout is only for people who have none.
//   · UPGRADE   → immediate, prorated. You do not make someone wait for storage they just bought.
//   · DOWNGRADE → at period end, via a subscription schedule. You do not take away space they have
//                 already paid for, and it is refused outright if they are using more than the
//                 smaller plan holds.
// The existing stripe-webhook needs no changes: an upgrade fires customer.subscription.updated
// immediately, and the schedule's second phase fires the same event when it starts.
//
// Secret it needs: STRIPE_SECRET_KEY. Auto-provided: SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY.
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

// Sixth copy of the price→step map; stripe-price-map-gate.mjs compares them all.
const PRICE_TO_TIER: Record<string, string> = {
  "price_1U9vt8Lx8hmpYH5q3BhJnH1V": "20gb",
  "price_1U9vt9Lx8hmpYH5q70HKvQnY": "50gb",
  "price_1U9vtALx8hmpYH5qmEGsGDiu": "100gb",
  "price_1U9vtBLx8hmpYH5qmqzra9nC": "250gb",
  "price_1U9vtCLx8hmpYH5qoUk7SZUP": "500gb",
  "price_1U9vtDLx8hmpYH5qxnAbMml2": "1tb",
  "price_1U9vtDLx8hmpYH5qJs2aJVWO": "2tb",
};
// What each step HOLDS. Must equal pricing.js quotaBytes and the ladder inside
// enforce_storage_quota — the gate compares this too. Used only to tell an upgrade from a
// downgrade, and to refuse a downgrade that would strand someone over their new limit.
const GB = 1024 ** 3;
const TIER_BYTES: Record<string, number> = {
  free: 1 * GB, "20gb": 20 * GB, "50gb": 50 * GB, "100gb": 100 * GB,
  "250gb": 250 * GB, "500gb": 500 * GB, "1tb": 1024 * GB, "2tb": 2048 * GB,
  plus: 20 * GB, pro: 50 * GB, institutional: 100 * GB,
};
const LIVE = (s: string) => s === "active" || s === "trialing" || s === "past_due";
const fmtGB = (b: number) => b >= 1024 * GB ? (b / (1024 * GB)).toFixed(b % (1024 * GB) ? 1 : 0) + " TB"
                                            : Math.round(b / GB) + " GB";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { action, priceId } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "not authenticated" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: profile } = await admin.from("profiles")
      .select("stripe_customer_id, storage_used_bytes").eq("id", user.id).maybeSingle();
    const customerId = profile?.stripe_customer_id as string | undefined;
    if (!customerId) return json({ needsCheckout: true });

    // Stale test-mode ids: same handling as everywhere else (see create-checkout-session).
    let subs;
    try {
      subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err?.code === "resource_missing" || /no such customer/i.test(err?.message ?? "")) {
        return json({ needsCheckout: true });
      }
      throw e;
    }
    const sub = subs.data.find((s) => LIVE(s.status));
    if (!sub) return json({ needsCheckout: true });   // nothing to change — Checkout is correct here

    // ---- resume a pending cancellation ------------------------------------------------------
    if (action === "resume") {
      if (!sub.cancel_at_period_end) return json({ ok: true, alreadyActive: true });
      const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
      return json({ ok: true, resumed: true, status: updated.status });
    }

    // ---- change step ------------------------------------------------------------------------
    if (action !== "change") return json({ error: "unknown action" }, 400);
    const newTier = PRICE_TO_TIER[priceId ?? ""];
    if (!newTier) return json({ error: "unknown price — nothing was changed" }, 400);

    const item = sub.items.data[0];
    const curPrice = item?.price?.id ?? "";
    const curTier = PRICE_TO_TIER[curPrice] || "free";
    if (curPrice === priceId) return json({ error: "you are already on that plan" }, 400);

    const curBytes = TIER_BYTES[curTier] ?? 0;
    const newBytes = TIER_BYTES[newTier] ?? 0;
    const isUpgrade = newBytes > curBytes;

    // A pending downgrade is replaced by whatever they ask for next, so release any schedule
    // first. Without this, subscriptions.update fights the schedule and Stripe refuses.
    if (sub.schedule) {
      try { await stripe.subscriptionSchedules.release(sub.schedule as string); } catch (_e) { /* already gone */ }
    }

    if (isUpgrade) {
      // Immediate, and invoice the difference now rather than silently rolling it into next month —
      // people should see the charge that corresponds to the thing they just clicked.
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: "always_invoice",
        cancel_at_period_end: false,   // upgrading is not a moment to keep a pending cancellation
        metadata: { user_id: user.id, changed_to: newTier },
      });
      return json({
        ok: true, kind: "upgrade", tier: newTier, effective: "now",
        status: updated.status,
        message: `You're on ${fmtGB(newBytes)} now. We've charged the difference for the rest of this month.`,
      });
    }

    // DOWNGRADE. Refuse if their data would not fit — preventing the over-limit situation is worth
    // more than any policy for handling it (see planning/billing-scenarios.md).
    const used = Number(profile?.storage_used_bytes ?? 0);
    if (used > newBytes) {
      return json({
        error: `You're using ${fmtGB(used)}, which doesn't fit in ${fmtGB(newBytes)}. ` +
               `Free up ${fmtGB(used - newBytes)} first, or stay on your current plan.`,
        overBy: used - newBytes,
      }, 400);
    }

    // At period end, via a schedule: they keep what they paid for until the date, then the second
    // phase starts and stripe-webhook drops the tier on the customer.subscription.updated it fires.
    const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end
      ?? (item as unknown as { current_period_end?: number })?.current_period_end;
    const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    const p0 = schedule.phases[0];
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: "release",
      phases: [
        {
          items: [{ price: curPrice, quantity: 1 }],
          start_date: p0.start_date,
          end_date: p0.end_date,
        },
        { items: [{ price: priceId, quantity: 1 }] },
      ],
      metadata: { user_id: user.id, downgrade_to: newTier },
    });
    return json({
      ok: true, kind: "downgrade", tier: newTier, effective: periodEnd ?? p0.end_date,
      message: `You'll move to ${fmtGB(newBytes)} at the end of this billing period. ` +
               `Nothing changes until then, and you keep everything you've paid for.`,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
