// Supabase Edge Function: portal-order
// Admin-only writer for portal_entries.sort_order. The column is granted to NOBODY client-side
// (anti-griefer: featured placement is curation, not user data), so reordering the portal's
// featured cards has to happen here with the service role, behind an is_admin check.
//
// POST { order: ["<project_id>", ...] }  →  sort_order = array index for each entry.
// Auth: caller's Supabase JWT (verify_jwt ON at deploy) + profiles.is_admin must be true —
// same identity-as-data rule as everywhere else (admin-flag.sql); never an email literal here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const asCaller = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await asCaller.auth.getUser();
    if (!user) return json({ error: "not authenticated" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
    if (!prof?.is_admin) return json({ error: "admin only" }, 403);

    // { order: [project_id,…], featured: {project_id: bool} } — both optional, both curation
    // columns the client cannot touch (sort_order AND featured are granted to nobody).
    // featured=true → the portal's main page; featured=false → the More Maps page.
    const { order, featured } = await req.json();
    const isId = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
    if (order !== undefined && (!Array.isArray(order) || order.length > 200 || order.some((v) => !isId(v)))) {
      return json({ error: "order must be an array of project ids" }, 400);
    }
    if (featured !== undefined && (typeof featured !== "object" || featured === null || Array.isArray(featured) ||
        Object.keys(featured).length > 200 || Object.keys(featured).some((k) => !isId(k) || typeof featured[k] !== "boolean"))) {
      return json({ error: "featured must be {project_id: boolean}" }, 400);
    }
    if (!order && !featured) return json({ error: "nothing to change" }, 400);

    let updated = 0;
    for (let i = 0; i < (order?.length ?? 0); i++) {
      const { data, error } = await admin.from("portal_entries")
        .update({ sort_order: i }).eq("project_id", order[i]).select("project_id");
      if (error) return json({ error: `row ${i}: ${error.message}` }, 500);
      updated += data?.length ?? 0;
    }
    for (const [pid, flag] of Object.entries(featured ?? {})) {
      const { data, error } = await admin.from("portal_entries")
        .update({ featured: flag }).eq("project_id", pid).select("project_id");
      if (error) return json({ error: `featured ${pid}: ${error.message}` }, 500);
      updated += data?.length ?? 0;
    }
    return json({ ok: true, updated });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
