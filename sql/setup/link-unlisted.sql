-- link-unlisted.sql — A19: sharing "by link" means UNLISTED, and all three read rules agree.
--
-- The owner ruled (8/31): a link-shared map is unlisted — anyone HOLDING the link can open it,
-- but it appears in no list, no search, no browse. Before this file the three read rules
-- disagreed on exactly that value: the projects policy allowed only visibility = 'public'
-- (so a link map could not even be OPENED from the table), while the layer/feature helpers
-- allowed <> 'private' (so a stranger could bulk-read a link map's DATA without the link).
--
-- THE MECHANISM — presenting the link IS the key. RLS alone cannot tell "opened via the link"
-- from "listed in bulk"; a plain policy that allows one allows both. So the browser sends the
-- map id it is opening in a request header (x-ms-map — injected once in platform/auth.js's
-- createClient wrapper, from the page's ?id=), PostgREST exposes it as request.headers, and
-- ms_link_claim() reads it back. A link map's rows are readable exactly when the request
-- carries that map's own id: bulk enumeration sends no header and sees only 'public'.
--
-- The 123 never-configured maps fall back to 'link' (matching share.js's effectiveVisibility
-- and ms_project_by_id): old shared demo links keep opening, and nothing lists them — A's
-- safer default. Explicit 'private' stays owner+editor only. ms_project_by_id keeps its
-- <> 'private' guard untouched: it takes the id as an argument, so calling it IS the claim.
--
-- Held by share-visibility-gate.mjs, which reads these rules out of the live catalogue and
-- fails if any of the three ever answers differently again.

-- ── 1 · the claim: which map id did this request present? ──────────────────────────────────
create or replace function public.ms_link_claim()
returns uuid
language sql
stable
set search_path = public
as $$
  select case
    when (current_setting('request.headers', true)::json->>'x-ms-map')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (current_setting('request.headers', true)::json->>'x-ms-map')::uuid
    else null
  end
$$;
grant execute on function public.ms_link_claim() to anon, authenticated, service_role;

-- ── 2 · the ONE visibility rule, in the three places that decide reads ─────────────────────
-- The test is textually identical in all three on purpose: 'public' reads for everyone,
-- 'link' reads only for a request presenting this map's id, anything else is owner+editor.

create or replace function public.ms_project_readable(pid uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    where p.id = pid
      and (
        p.user_id = auth.uid()
        or (p.deleted_at is null and (
            coalesce(p.raw_config->>'visibility',
                     case when p.is_public then 'public' else 'link' end) = 'public'
            or (coalesce(p.raw_config->>'visibility',
                         case when p.is_public then 'public' else 'link' end) = 'link'
                and p.id = public.ms_link_claim())))
        or public.ms_project_editor(p.id)
      )
  );
$$;

create or replace function public.ms_readable_layer_ids()
returns setof uuid
language sql
stable security definer
set search_path = public
as $$
  select l.id from public.layers l where l.user_id = auth.uid()
  union
  select pl.layer_id
    from public.project_layers pl
    join public.projects p on p.id = pl.project_id
   where p.user_id = auth.uid()
      or (p.deleted_at is null and (
          coalesce(p.raw_config->>'visibility',
                   case when p.is_public then 'public' else 'link' end) = 'public'
          or (coalesce(p.raw_config->>'visibility',
                       case when p.is_public then 'public' else 'link' end) = 'link'
              and p.id = public.ms_link_claim())))
      or public.ms_project_editor(p.id);
$$;

drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select using (
  user_id = auth.uid()
  or public.ms_project_editor(id)
  or (deleted_at is null and (
      coalesce(raw_config->>'visibility',
               case when is_public then 'public' else 'link' end) = 'public'
      or (coalesce(raw_config->>'visibility',
                   case when is_public then 'public' else 'link' end) = 'link'
          and id = public.ms_link_claim())))
);
