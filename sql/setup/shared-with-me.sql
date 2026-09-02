-- ms_maps_shared_with_me() — the maps someone was explicitly given edit access to (9/2)
--
-- Owner: "A user should be able to see the maps they have access to or have been shared directly
-- with on their user pages." Ownership already answers "my maps"; this answers the other half.
--
-- EXPLICIT grants only: a map whose editAccess.emails contains your address. Maps that merely say
-- "anyone with the link can edit" are NOT listed — that would put every such map in front of every
-- signed-in user, which is the listing leak A19 exists to prevent. Link means unlisted, always.
--
-- SECURITY DEFINER because it reads projects for rows the caller may not enumerate in bulk; it is
-- narrowed by the caller's OWN jwt email, so it can never return someone else's grants.
create or replace function public.ms_maps_shared_with_me()
returns table (id uuid, name text, user_id uuid, updated_at timestamptz, owner_email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.name,
         p.user_id,
         p.updated_at,
         u.email::text as owner_email
    from public.projects p
    left join auth.users u on u.id = p.user_id
   where p.deleted_at is null
     and auth.uid() is not null
     and p.user_id is distinct from auth.uid()          -- "mine" is a different list
     and coalesce(nullif(auth.jwt() ->> 'email', ''), '\x00') <> '\x00'
     and exists (
       select 1
         from jsonb_array_elements_text(
                coalesce(p.raw_config -> 'editAccess' -> 'emails', '[]'::jsonb)) e
        where lower(trim(e)) = lower(trim(auth.jwt() ->> 'email'))
     )
   order by p.updated_at desc nulls last
   limit 200;
$$;

revoke all on function public.ms_maps_shared_with_me() from public;
grant execute on function public.ms_maps_shared_with_me() to authenticated;
