-- edit-lock-takeover.sql — the "Take over editing" half of the 8/31 lock rework (owner: A+B).
--
-- WHY. One-editor-at-a-time used to mean "whoever opened the editor first holds the map for as
-- long as that tab exists" — a forgotten tab could strand a map for a day (the Slater case).
-- The fix is two-sided:
--   A (client only): the holder's tab renews the lock ONLY while its person is actually active;
--     idle > 5 minutes stops the heartbeat, the 90-second TTL frees the map by itself.
--   B (this function): anyone allowed to edit the map may TAKE OVER a live hold deliberately.
--     The previous holder's window learns on its next 30-second tick and stands down with the
--     same "may be editing — take over?" notice, so the transition is loud on both screens.
--
-- Permission = exactly the acquire rule: the map's owner or an invited editor. Anonymous never.
-- Taking over is not a privilege escalation — the same person could simply wait 90 seconds after
-- the holder goes idle; this just removes the wait when a human decides the map is needed now.

create or replace function public.ms_take_over_edit_lock(p_project uuid, p_sid text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'sign in first'; end if;
  if not exists (select 1 from public.projects p
                  where p.id = p_project
                    and (p.user_id = v_me or public.ms_project_editor(p.id))) then
    raise exception 'not your map';
  end if;

  insert into public.ms_edit_locks (project_id, holder, sid)
  values (p_project, v_me, p_sid)
  on conflict (project_id) do update
    set holder = excluded.holder, sid = excluded.sid, taken_at = now(), heartbeat_at = now();

  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.ms_take_over_edit_lock(uuid, text) from public, anon;
grant execute on function public.ms_take_over_edit_lock(uuid, text) to authenticated, service_role;
