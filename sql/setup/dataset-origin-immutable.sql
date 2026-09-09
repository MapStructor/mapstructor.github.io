-- dataset-origin-immutable.sql — make a dataset's credit impossible to lose by accident.
--
-- WHY. `features_data.dataset_id` is the whole attribution chain: the Dataset panel resolves
-- source, licence and link through it, so a row that loses it becomes uncredited data. The
-- protection was entirely in application code. The database already had two of the three pieces:
--
--   · a foreign key to datasets(id)      → a BOGUS origin was already impossible
--   · ms_guard_stamped_rows (BEFORE DELETE) → deleting a stamped row was already refused
--   · nothing at all on UPDATE           → ANY client could set dataset_id to null, or to another
--                                          dataset's id, and Postgres accepted it silently
--
-- `features_view_update` ends with `set dataset_id = new.dataset_id`, so the hole is reachable
-- from the ordinary PATCH path a browser uses. One line in a future save routine that builds a
-- fresh row object without the column would silently strip the credit off every row it touched,
-- and nothing — no constraint, no test, no screen — would say so.
--
-- THE RULE. Once a row is stamped, its origin cannot be changed by an update. Two exceptions,
-- both deliberate and both narrow:
--
--   1. The dataset row is gone. The FK is ON DELETE SET NULL, and that cascade arrives here AS AN
--      UPDATE. Unstamping is the correct outcome when the dataset no longer exists, and blocking
--      it would make datasets undeletable.
--   2. `ms.allow_stamped_restamp` is set to 'on' for the transaction. Same escape-hatch shape as
--      the existing `ms.allow_stamped_delete`, and the only caller is ms_unregister_dataset, whose
--      entire job is to unstamp rows while the dataset row still exists.
--
-- WHAT IT REFUSES, in the owner's terms: a copy of a registered map can no longer quietly come out
-- uncredited. The write fails loudly at the row instead.
--
-- Applied 2026-09-08 against eqpxlwbjqiwfjlsuapvu. Idempotent — safe to re-run.
-- Rollback: drop trigger trg_ms_guard_origin on public.features_data;

create or replace function public.ms_guard_stamped_origin()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if old.dataset_id is not null
     and new.dataset_id is distinct from old.dataset_id
     -- exception 2: the deliberate unstamp
     and coalesce(current_setting('ms.allow_stamped_restamp', true), '') <> 'on'
     -- exception 1: the dataset itself is being deleted, and this update IS the FK cascade
     and exists (select 1 from public.datasets d where d.id = old.dataset_id)
  then
    raise exception
      'feature % belongs to registered dataset % — its origin is immutable provenance and cannot be changed or cleared by an update (unregister the dataset to unstamp its rows)',
      old.feature_id, old.dataset_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_ms_guard_origin on public.features_data;
create trigger trg_ms_guard_origin
  before update on public.features_data
  for each row execute function public.ms_guard_stamped_origin();

-- ms_unregister_dataset clears the stamps BEFORE deleting the dataset row, so it needs the flag.
-- Unchanged in every other respect; re-stated here in full so this file is the whole truth about
-- what the origin rule does and does not allow.
create or replace function public.ms_unregister_dataset(p_dataset uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_n int;
begin
  if not public.ms_dataset_admin() then
    raise exception 'not permitted';
  end if;
  -- transaction-scoped, so it cannot leak into anything else this connection does next
  perform set_config('ms.allow_stamped_restamp', 'on', true);
  update public.features_data set dataset_id = null where dataset_id = p_dataset;
  get diagnostics v_n = row_count;
  delete from public.datasets where id = p_dataset;
  return v_n;
end $$;
