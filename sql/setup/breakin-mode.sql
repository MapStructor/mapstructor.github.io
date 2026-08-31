-- breakin-mode.sql — A27: the SECOND emergency switch, for "someone broke in".
--
-- The existing freeze (ms_service_lock) was built for "we're being billed to death": it stops
-- writes/uploads/map-loads AND deliberately leaves reads, sessions, keys and deletes alone.
-- Correct for a bill; backwards for a break-in. This file adds BREAK-IN MODE. One flip:
--   1. every write AND DELETE to user data is refused BY THE DATABASE (not by page JavaScript —
--      an intruder talking straight to the API never runs our pages),
--   2. every session is revoked (the thief's stolen login dies with everyone else's),
--   3. the existing lock/freeze semantics engage too (no uploads, no map loads) with zero client
--      changes, because ms_service_state simply reports locked+frozen when breakin is set.
-- Thawing is DELIBERATELY not possible from a browser: ms_breakin_thaw() is executable by
-- service_role only, so a thief holding the owner's session cannot un-flip it. Recovery runs
-- from the owner's machine, with keys no browser ever held (scripts/breakin.mjs).
--
-- Owner decisions (delegated 8/31 "do what you think is right"): build it · sign-out automatic
-- at flip · key rotation stays manual in the runbook order. Runbook: mapstructor_docs/process/break-in.md
-- Verification: breakin-gate.mjs (flips on, proves refusals, thaws — always thaws, in a finally).

-- ── 1 · the flag ───────────────────────────────────────────────────────────────────────────
alter table public.ms_service_guard
  add column if not exists breakin boolean not null default false,
  add column if not exists breakin_reason text,
  add column if not exists breakin_at timestamptz;

-- ── 2 · the database-level block ───────────────────────────────────────────────────────────
-- BEFORE trigger on the tables an intruder would write, deface, or destroy. Named trg_aaa_* so
-- it fires FIRST (triggers run alphabetically) — no point running quota math on a refused row.
-- The guard row itself is NOT in the list (thaw must be able to update it), and reads are never
-- blocked here (that is what full-dark is for; see the runbook).
create or replace function public.ms_breakin_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select g.breakin from public.ms_service_guard g where g.id = 1) then
    raise exception 'service_breakin_lock'
      using hint = 'The site is temporarily read-only while a security issue is investigated.';
  end if;
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['features_data','feature_styles','layers','projects','project_layers','site_content','datasets','profiles','reports']
  loop
    execute format('drop trigger if exists trg_aaa_breakin on public.%I', t);
    execute format('create trigger trg_aaa_breakin before insert or update or delete on public.%I
                    for each row execute function public.ms_breakin_block()', t);
  end loop;
end $$;

-- ── 3 · flip ON — admin-callable, and it signs everyone out in the same statement ──────────
-- Flipping ON from a browser is allowed on purpose: turning the site dark only ever hurts an
-- intruder. (Flipping OFF is the dangerous direction — see ms_breakin_thaw.)
create or replace function public.ms_breakin_lock(p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.ms_is_admin() then
    raise exception 'not authorized';
  end if;
  update public.ms_service_guard
     set breakin = true, breakin_reason = p_reason, breakin_at = now(), updated_at = now()
   where id = 1;
  -- sign EVERYONE out (owner decision: automatic). Access tokens already issued live out their
  -- remaining minutes (≤1h); nothing refreshes after this. The thief's session dies here too.
  -- `where true` because Supabase's safe-update guard refuses a bare DELETE — the intent here
  -- really is every row.
  delete from auth.refresh_tokens where true;
  return true;
end;
$$;
revoke all on function public.ms_breakin_lock(text) from public;
grant execute on function public.ms_breakin_lock(text) to authenticated, service_role;

-- ── 4 · flip OFF — service_role ONLY, never from a browser ─────────────────────────────────
create or replace function public.ms_breakin_thaw()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ms_service_guard
     set breakin = false, breakin_reason = null, updated_at = now()
   where id = 1;
  return true;
end;
$$;
revoke all on function public.ms_breakin_thaw() from public;
revoke all on function public.ms_breakin_thaw() from anon, authenticated;
grant execute on function public.ms_breakin_thaw() to service_role;

-- ── 5 · ms_service_state reports it — which makes every EXISTING enforcer cover break-in ───
-- locked → editor refuses to wire editing, Worker 503s uploads; frozen → guard.js constructs no
-- map. Same row shape plus one appended field (consumers read by name, so appending is safe);
-- RETURNS TABLE changes need a DROP first.
drop function if exists public.ms_service_state();
create function public.ms_service_state()
returns table(locked boolean, frozen boolean, reason text, db_bytes bigint, db_cap bigint,
              r2_bytes bigint, r2_cap bigint, map_loads bigint, map_load_cap bigint,
              map_load_alert bigint, r2_class_a bigint, r2_class_a_cap bigint,
              r2_class_b bigint, r2_class_b_cap bigint, r2_ops_fresh boolean,
              db_frac numeric, r2_frac numeric, map_frac numeric, class_a_frac numeric,
              class_b_frac numeric, breakin boolean)
language plpgsql
security definer
set search_path = public
as $function$
declare g public.ms_service_guard; cur date := date_trunc('month', now())::date; fresh boolean;
        a bigint; b bigint;
begin
  select * into g from public.ms_service_guard where id = 1;
  if g.last_checked < now() - interval '1 minute' then
    -- never WAIT for this row: this runs on hot paths, so a long bulk import holding the lock
    -- would otherwise freeze every other user's reads behind it.
    perform 1 from public.ms_service_guard where id = 1 for update skip locked;
    if found then
      update public.ms_service_guard set
        last_db_bytes = pg_database_size(current_database()),
        last_r2_bytes = coalesce((select sum(l.r2_bytes) from public.layers l), 0),
        last_checked  = now()
      where id = 1
      returning * into g;
    end if;
  end if;

  fresh := g.r2_ops_checked is not null
       and g.r2_ops_checked > now() - interval '3 days'
       and g.r2_ops_period = cur;
  a := case when fresh then g.r2_class_a_month else 0 end;
  b := case when fresh then g.r2_class_b_month else 0 end;

  return query select
    (g.breakin or g.locked
       or g.last_db_bytes >= g.db_cap_bytes
       or g.last_r2_bytes >= g.r2_cap_bytes
       or (fresh and a >= g.r2_class_a_cap)),
    (g.breakin or g.map_load_frozen or g.locked or (fresh and b >= g.r2_class_b_cap)),
    case when g.breakin then coalesce(g.breakin_reason, 'the site is temporarily paused for a security check')
         when g.locked then coalesce(g.locked_reason, 'paused by the owner')
         when g.map_load_frozen then coalesce(g.frozen_reason, 'monthly map-load cap reached')
         when fresh and b >= g.r2_class_b_cap then 'monthly tile-read cap reached'
         when fresh and a >= g.r2_class_a_cap then 'monthly file-write cap reached'
         when g.last_db_bytes >= g.db_cap_bytes then 'database cap reached'
         when g.last_r2_bytes >= g.r2_cap_bytes then 'file-storage cap reached'
         else null end,
    g.last_db_bytes, g.db_cap_bytes, g.last_r2_bytes, g.r2_cap_bytes,
    case when g.map_loads_period = cur then g.map_loads_month else 0::bigint end,
    g.map_load_cap, g.map_load_alert,
    a, g.r2_class_a_cap, b, g.r2_class_b_cap, fresh,
    round(g.last_db_bytes::numeric / nullif(g.db_cap_bytes, 0), 4),
    round(g.last_r2_bytes::numeric / nullif(g.r2_cap_bytes, 0), 4),
    round((case when g.map_loads_period = cur then g.map_loads_month else 0 end)::numeric / nullif(g.map_load_cap, 0), 4),
    round(a::numeric / nullif(g.r2_class_a_cap, 0), 4),
    round(b::numeric / nullif(g.r2_class_b_cap, 0), 4),
    g.breakin;
end;
$function$;
grant execute on function public.ms_service_state() to anon, authenticated, service_role;
