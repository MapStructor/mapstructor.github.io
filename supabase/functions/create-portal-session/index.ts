// Supabase Edge Function: create-portal-session
// Opens the Stripe Customer Portal so a paid user can change/cancel their plan or update their card.
// Secret it needs: STRIPE_SECRET_KEY. Auto-provided: SUPABASE_URL, SUPABASE_ANON_KEY.
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
    const { returnUrl } = await req.json();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "not authenticated" }, 401);

    // SERVICE ROLE for this read. After the RLS lockdown an authenticated user cannot SELECT from
    // profiles at all — even `id, subscription_tier` returns 42501 — which is why the app reads
    // plans through ms_my_plan(). This function was the last place still reading directly, so it
    // answered "no subscription yet" to every paying customer and left them with no way to cancel
    // or change their card. Found 7/31, right after fixing the same class of bug in checkout.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: profile } = await admin.from("profiles").select("stripe_customer_id").eq("id", user.id).maybeSingle();
    if (!profile?.stripe_customer_id) return json({ error: "no subscription yet" }, 400);

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id as string,
      return_url: returnUrl || "https://mapstructor.com/dashboard.html",
    });
    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
