-- fold-aware-data-root.sql — APPLIED LIVE 2026-09-04.
--
-- WHAT BROKE. `ms_layer_data_root(layer)` walks a layer's copy chain (_msCopyOf / _msFromLayer /
-- instanceOf) and returns the first ancestor that "has the data". It decided that by asking
-- whether the ancestor holds rows in features_data.
--
-- That was a sound proxy for as long as every layer kept its rows. The fold's entire purpose is
-- that heavy layers do NOT: their data lives on R2 as PMTiles + GeoParquet + an export
-- FeatureCollection, and Postgres keeps only a pointer. When the soaked rows were finally deleted
-- (9/4, 477,485 of them), every folded family lost its root — the walk found no ancestor with rows
-- and returned NULL.
--
-- WHAT THAT COST, silently: four functions build on this one —
--   ms_dataset_for_layers · ms_layer_dataset_covered · ms_register_dataset · ms_layer_fork_source
-- so dataset lineage stopped resolving for folded layers and their pointer copies. The visible
-- symptom was the attribute table quietly dropping its `ms_dataset` column (caught by
-- attr-msdataset-gate A1: {"col":false,"val":null}).
--
-- THE FIX: a folded OWNER is a data root even with zero rows, because it owns the artifacts.
-- Owner vs pointer is decided by the parquet_key, not by r2_bytes — r2_bytes is 0 on many genuine
-- owners (a separate accounting gap worth its own fix). A fold owner's parquet_key contains its
-- OWN layer id; a C7 pointer copy's contains the SOURCE's, so pointers correctly keep walking.
-- This is the same rule the client uses in foldArtifactUrl().
--
-- Verified after applying: the gate's pointer copy resolves to fd0d755e (was NULL), lineage
-- returns "Railroads, 1826-1911", every layer that still holds rows resolves to SELF as before,
-- and attr-msdataset-gate is 3/3 green.

create or replace function public.ms_layer_data_root(p_layer uuid)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  queue uuid[] := array[p_layer];
  seen  uuid[] := array[]::uuid[];
  cur   uuid;
  hops  int := 0;
begin
  while coalesce(array_length(queue, 1), 0) > 0 loop
    cur := queue[1];
    queue := queue[2:];
    if cur = any(seen) then continue; end if;
    seen := seen || cur;
    hops := hops + 1;
    if hops > 24 then return null; end if;

    -- rows are the original proof that the data lives here
    if exists (select 1 from public.features_data f where f.layer_id = cur) then
      return cur;
    end if;

    -- ...and since the fold, a folded OWNER holds its data as R2 artifacts instead.
    if exists (
      select 1 from public.layers l
       where l.id = cur
         and l.fold_state = 'folded'
         and l.parquet_key is not null
         and position(cur::text in l.parquet_key) > 0
    ) then
      return cur;
    end if;

    queue := queue || array(
      select v::uuid from (
        select coalesce(l.raw_config, '{}'::jsonb) ->> '_msCopyOf'    as v
          from public.layers l where l.id = cur
        union all
        select coalesce(l.raw_config, '{}'::jsonb) ->> '_msFromLayer'
          from public.layers l where l.id = cur
        union all
        select coalesce(l.raw_config, '{}'::jsonb) ->> 'instanceOf'
          from public.layers l where l.id = cur
      ) t
      where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    );
  end loop;
  return null;
end $fn$;
