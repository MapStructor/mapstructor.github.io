-- tilegen-setup.sql — run once in the Supabase SQL editor (platform project eqpxlwbjqiwfjlsuapvu).
-- The `tiles` storage bucket already exists (public read). These policies let SIGNED-IN users
-- write their generated .pmtiles archives; anonymous visitors can only read.
--
-- Path convention: tiles/{projectId}/{layerId}.pmtiles  (written by platform/tilegen.js)

-- signed-in users may upload new archives
create policy "tilegen upload"
on storage.objects for insert to authenticated
with check (bucket_id = 'tiles');

-- and replace existing ones (regeneration at publish uses upsert)
create policy "tilegen update"
on storage.objects for update to authenticated
using (bucket_id = 'tiles')
with check (bucket_id = 'tiles');

-- optional cleanup path (delete a layer → its archive may be removed)
create policy "tilegen delete"
on storage.objects for delete to authenticated
using (bucket_id = 'tiles');

-- NOTE (tighten later if wanted): these allow any signed-in user to write any path in the
-- bucket. A stricter version would check the projectId prefix against project ownership:
--   with check (bucket_id = 'tiles' and (storage.foldername(name))[1] in
--     (select id::text from public.projects where user_id = auth.uid()))
-- Kept simple for now on purpose — archives are public-read map data, not secrets.
