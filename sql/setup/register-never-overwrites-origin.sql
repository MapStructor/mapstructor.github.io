-- register-never-overwrites-origin.sql — registering a COPY must never rewrite the ORIGINAL
-- catalogue entry.
--
-- WHAT WENT WRONG, and it is live data, dated today (9/8). The dataset row whose slug is
-- `railroads-1826-1911-3c6cd0` — the portal's entry for the layer "Railroads, 1826-1911" — is
-- currently named "ZZ Railroads MSD e2e", claims 0 features, and offers an 814-byte download.
-- Nobody edited it. This is what happened:
--
--   1. `portal-msd-origin-gate` adds that dataset to a throwaway map and presses "Register this
--      copy as a NEW dataset", typing the name "ZZ Railroads MSD e2e".
--   2. The copy owns no rows, because its source layer is FOLDED — folded data lives in tiles, so
--      hydration copies nothing out of Postgres.
--   3. `ms_register_dataset` then does what its comment says: "a pointer copy owns no rows; follow
--      the lineage to the layer that DOES own them" — `p_layer := ms_layer_data_root(p_layer)`.
--      The layer being registered silently becomes the ORIGINAL.
--   4. "already registered? refresh in place" finds the ORIGINAL's dataset row and applies the
--      copy's metadata to it. The name goes over the top.
--   5. `select count(*) from features_data where layer_id = <folded root>` returns 0, so
--      feature_count is overwritten with 0 — the 78,843 figure is gone.
--
-- The function already carries a comment about a NEIGHBOURING route to this same outcome
-- ("resolving through stamps here is how a fork's second Save would have overwritten the
-- 1826-1911 catalogue entry with the fork's metadata"). That route was closed. This one — the
-- lineage route — was not, and it is the one a folded dataset takes every time.
--
-- CONSEQUENCE IN PLAIN TERMS: anyone can lose a dataset's public identity by registering a copy
-- of it. The catalogue entry a visitor reads — its name, source, licence, attribution text, and
-- the size of the file they download — is replaced by whatever the copier typed. No warning, and
-- the original is not recoverable from the row itself.
--
-- THE RULE ADDED HERE. If lineage had to walk UP from the layer the caller asked to register, and
-- the layer it landed on is already registered, then registering is a NO-OP that returns the
-- existing dataset id. The copy ends up pointing at the origin dataset — which is exactly the
-- intended end state — and the origin's own metadata is untouchable from a copy.
--
-- SECOND RULE. feature_count is never recomputed from Postgres for a FOLDED layer. Folded rows
-- live in tiles by design, so counting rows there does not measure the dataset; it erases it.
--
-- Applied 2026-09-08 against eqpxlwbjqiwfjlsuapvu. Idempotent.
-- Rollback: the prior body is in git history for this file's sibling functions; the only changes
-- below are the `v_asked`/`v_moved` early return and the folded guard on the recount.

create or replace function public.ms_register_dataset(p_layer uuid, p_meta jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id      uuid;
  v_project uuid;
  v_count   int;
  v_slug    text;
  v_owner   uuid;
  v_asked   uuid := p_layer;   -- what the caller actually pointed at, before lineage
  v_moved   boolean := false;
  v_folded  boolean := false;
begin
  if not public.ms_dataset_admin() then
    raise exception 'not permitted: dataset registration is admin-only';
  end if;
  if not exists (select 1 from public.layers where id = p_layer and deleted_at is null) then
    raise exception 'no such layer %', p_layer;
  end if;

  -- REGISTER THROUGH THE LINEAGE (8/12): a pointer copy owns no rows; follow the lineage to
  -- the layer that DOES own them. Refuse only with no lineage to follow.
  v_owner := public.ms_layer_data_root(p_layer);
  if v_owner is null then
    raise exception 'this layer owns no data rows and has no traceable source — register the layer that actually holds the data';
  end if;
  p_layer := v_owner;
  v_moved := (v_owner is distinct from v_asked);

  select pl.project_id into v_project
    from public.project_layers pl where pl.layer_id = p_layer limit 1;

  -- already registered? refresh in place. THIS layer's own registration is the dataset whose
  -- origin_layer_id points here — NOT whatever origin its rows carry (rows may carry an
  -- UPSTREAM origin; resolving through stamps here is how a fork's second Save would have
  -- overwritten the 1826-1911 catalogue entry with the fork's metadata).
  select d.id into v_id from public.datasets d where d.origin_layer_id = p_layer limit 1;
  if v_id is null then
    -- legacy fallback: rows stamped with a dataset that recorded no different origin layer
    select f.dataset_id into v_id
      from public.features_data f
      join public.datasets d on d.id = f.dataset_id
     where f.layer_id = p_layer
       and (d.origin_layer_id is null or d.origin_layer_id = p_layer)
     limit 1;
  end if;

  -- ── 9/8 · A COPY CANNOT REWRITE ITS ORIGIN'S CATALOGUE ENTRY ────────────────────────────────
  -- Lineage walked up, and the layer it landed on is already registered. The caller asked to
  -- register something that is not the data's home, so there is nothing to register: hand back
  -- the origin's dataset and change nothing about it. Without this, the copier's typed name,
  -- licence and attribution land on the original — see this file's header for the live case.
  if v_moved and v_id is not null then
    return v_id;
  end if;

  v_slug := nullif(regexp_replace(lower(coalesce(p_meta->>'name','dataset')), '[^a-z0-9]+', '-', 'g'), '');
  v_slug := trim(both '-' from coalesce(v_slug, 'dataset'));

  if v_id is null then
    insert into public.datasets (
      slug, name, source, link, more_info, licence,
      lic_redistribute, lic_modify, lic_commercial, lic_share_alike, lic_attribution,
      attribution_text, traced_only_open, traced_sources,
      citation, source_more_info, submitter_notes, submitted_by_email, made_how,
      origin_layer_id, origin_project_id, created_by
    ) values (
      v_slug || '-' || substr(gen_random_uuid()::text, 1, 6),
      coalesce(nullif(p_meta->>'name',''), 'Untitled dataset'),
      nullif(p_meta->>'source',''), nullif(p_meta->>'link',''), nullif(p_meta->>'more_info',''),
      coalesce(nullif(p_meta->>'licence',''), 'unknown'),
      (p_meta->>'lic_redistribute')::boolean, (p_meta->>'lic_modify')::boolean,
      (p_meta->>'lic_commercial')::boolean,   (p_meta->>'lic_share_alike')::boolean,
      (p_meta->>'lic_attribution')::boolean,  nullif(p_meta->>'attribution_text',''),
      (p_meta->>'traced_only_open')::boolean, nullif(p_meta->>'traced_sources',''),
      nullif(p_meta->>'citation',''), nullif(p_meta->>'source_more_info',''),
      nullif(p_meta->>'submitter_notes',''), auth.jwt() ->> 'email', nullif(p_meta->>'made_how',''),
      p_layer, v_project, auth.uid()
    ) returning id into v_id;
  else
    update public.datasets set
      name = coalesce(nullif(p_meta->>'name',''), name),
      source = coalesce(nullif(p_meta->>'source',''), source),
      link = coalesce(nullif(p_meta->>'link',''), link),
      more_info = coalesce(nullif(p_meta->>'more_info',''), more_info),
      licence = coalesce(nullif(p_meta->>'licence',''), licence),
      lic_redistribute = coalesce((p_meta->>'lic_redistribute')::boolean, lic_redistribute),
      lic_modify       = coalesce((p_meta->>'lic_modify')::boolean,       lic_modify),
      lic_commercial   = coalesce((p_meta->>'lic_commercial')::boolean,   lic_commercial),
      lic_share_alike  = coalesce((p_meta->>'lic_share_alike')::boolean,  lic_share_alike),
      lic_attribution  = coalesce((p_meta->>'lic_attribution')::boolean,  lic_attribution),
      attribution_text = coalesce(nullif(p_meta->>'attribution_text',''), attribution_text),
      traced_only_open = coalesce((p_meta->>'traced_only_open')::boolean, traced_only_open),
      traced_sources   = coalesce(nullif(p_meta->>'traced_sources',''),   traced_sources),
      citation         = coalesce(nullif(p_meta->>'citation',''),         citation),
      source_more_info = coalesce(nullif(p_meta->>'source_more_info',''), source_more_info),
      submitter_notes  = coalesce(nullif(p_meta->>'submitter_notes',''),  submitter_notes),
      submitted_by_email = coalesce(submitted_by_email, auth.jwt() ->> 'email'),
      made_how         = coalesce(nullif(p_meta->>'made_how',''),         made_how),
      origin_layer_id  = coalesce(origin_layer_id, p_layer),
      origin_project_id= coalesce(origin_project_id, v_project),
      updated_at = now()
    where id = v_id;
  end if;

  -- THE STAMP = ORIGIN ASSIGNMENT, first registration only. A row that already carries an
  -- origin keeps it forever — registering a copy must never rewrite provenance (owner 8/13:
  -- "there is an origin for all features - that's what we're trying to track").
  update public.features_data
     set dataset_id = v_id
   where layer_id = p_layer and dataset_id is null;

  -- ── 9/8 · NEVER COUNT A FOLDED LAYER'S ROWS ────────────────────────────────────────────────
  -- A folded layer's data lives in tiles; Postgres holds only unpublished edits. Counting rows
  -- there does not measure the dataset, it erases the recorded figure — which is how a 78,843-row
  -- dataset came to claim 0.
  select (l.fold_state = 'folded') into v_folded from public.layers l where l.id = p_layer;
  if not coalesce(v_folded, false) then
    select count(*)::int into v_count from public.features_data where layer_id = p_layer;
    update public.datasets set feature_count = v_count, updated_at = now() where id = v_id;
  end if;

  return v_id;
end;
$function$;
