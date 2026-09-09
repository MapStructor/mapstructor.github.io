-- fork-hydrate-no-double-copy.sql — registering a fork must not double a copy's rows when the
-- copy was already hydrated by the ordinary portal-add merge.
--
-- WHAT WENT WRONG, found 9/9 building portal-msd-origin-gate.mjs's own dataset fixture (item 4 of
-- the overnight list — the fixture exists precisely so this item stops pinning a real catalogue
-- entry; building it against a LIVE, unfolded origin is what exercised this path for the first
-- time). `Portal Add -> mode ALL -> merge` on a LIVE (unfolded) dataset copies every row for real,
-- through `copyLayerInto` -> `ms_copy_layer_features` (editing.js:4567, sql/setup's own RPC).
-- That path ALSO stamps `raw_config._msCopyOf = <source layer id>` on the new layer, UNCONDITIONALLY
-- — for a folded source too, where the merge deliberately copies nothing (folded data lives in
-- tiles; only its unpublished deltas are real rows).
--
-- `ms_register_dataset_fork` (the "Register this copy as a NEW dataset" button, when it resolves
-- a fork source via `ms_layer_fork_source`) exists for that FOLDED case: the fork layer owns ~0
-- rows and needs the root's data hydrated into it before it can stand alone. It decides whether to
-- hydrate by asking `ms_layer_fork_source(p_layer)`, which reads `_msCopyOf` — the SAME flag a
-- LIVE copy also carries. So every fork of a live-copied layer ALSO hydrates, on top of the rows
-- that are already there. The one guard the function had (skip a source row if the fork already
-- has an `ms_foldsrc`-tagged edit of it) only recognises FOLDED-style delta rows; a live copy's
-- rows carry no such tag, so nothing was ever excluded, and every row landed twice.
--
-- CONSEQUENCE IN PLAIN TERMS: registering ANY portal-added copy of a LIVE (unfolded) dataset as a
-- new dataset doubles its feature count and its stored bytes, silently — the button says
-- "Registered", the modal shows a plausible-looking number, and only counting the rows reveals it.
-- This was never caught earlier because the one gate exercising this exact flow
-- (portal-msd-origin-gate.mjs) had pinned a FOLDED real dataset as its fixture since 8/13 — the one
-- shape that cannot trigger it — until today.
--
-- THE FIX. The hydration step is only ever correct when the fork layer owns no REAL rows of its
-- own yet (a genuine folded-pointer copy, plus perhaps a few ms_foldsrc delta edits). Skip the
-- whole block if it already has any row that is NOT a delta — that is precisely the "already
-- hydrated by an ordinary copy" case.
--
-- Applied 2026-09-09 against eqpxlwbjqiwfjlsuapvu. Idempotent.
-- Rollback: the prior body is in git history for this file's sibling functions; the only change
-- below is the added `and not exists (... already owns real rows ...)` clause.

create or replace function public.ms_register_dataset_fork(p_layer uuid, p_meta jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me   uuid := auth.uid();
  v_own  uuid;
  v_src  uuid;
begin
  select user_id into v_own from public.layers where id = p_layer;
  if not found then raise exception 'no such layer'; end if;
  if v_me is null or v_own is null or v_own <> v_me then raise exception 'not your layer'; end if;

  -- the source is resolved from the POINTERS (an edited copy already owns rows and would
  -- otherwise read as its own root — first gate run registered a 1-row dataset)
  v_src := public.ms_layer_fork_source(p_layer);

  -- 9/9: `_msCopyOf` is stamped on every portal-added copy, folded source or live. A LIVE source's
  -- copy already received every row through the ordinary merge (ms_copy_layer_features) — only a
  -- FOLDED source's copy is a genuine empty pointer needing hydration here. Tell the two apart by
  -- asking whether the fork already owns any row that is not itself a delta edit.
  if v_src is not null and v_src <> p_layer
     and not exists (select 1 from public.features_data x
                       where x.layer_id = p_layer and not (x.custom_fields ? 'ms_foldsrc')) then
    -- 1 · hydrate: the root's rows become the fork's own (overlay-replaced features skipped);
    --     dataset_id RIDES ALONG — origin is immutable provenance (owner 8/13)
    insert into public.features_data
      (layer_id, content_id, content_source, geom, label, start_date, end_date,
       description, image_url, custom_fields, status, dataset_id)
    select p_layer, s.content_id, s.content_source, s.geom, s.label, s.start_date, s.end_date,
           s.description, s.image_url,
           coalesce(s.custom_fields, '{}'::jsonb) || jsonb_build_object('ms_copysrc', s.feature_id),
           coalesce(s.status, 'active'),
           s.dataset_id
      from public.features_data s
     where s.layer_id = v_src
       and not exists (select 1 from public.features_data o
                        where o.layer_id = p_layer
                          and o.custom_fields->>'ms_foldsrc' = s.feature_id::text);

    insert into public.feature_styles (feature_id, ms_color, ms_linecolor, ms_opacity, ms_thickness, ms_labelsize)
    select n.feature_id, st.ms_color, st.ms_linecolor, st.ms_opacity, st.ms_thickness, st.ms_labelsize
      from public.features_data n
      join public.feature_styles st on st.feature_id = (n.custom_fields->>'ms_copysrc')::bigint
     where n.layer_id = p_layer and n.custom_fields ? 'ms_copysrc'
    on conflict (feature_id) do nothing;
  end if;

  -- 2 · the fork owns rows now — the resolver stops here and it registers as ITSELF
  --     (rows keep their origin stamps; ms_register_dataset only stamps virgin rows)
  return public.ms_register_dataset(p_layer, p_meta);
end;
$function$;
