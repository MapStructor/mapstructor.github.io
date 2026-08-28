import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("c:/repos/mapstructor_docs/testing/harness/node_modules/pg");
const md = fs.readFileSync("c:/repos/mapstructor.github.io/secrets/supabase.md", "utf8");
const c = new Client({ connectionString: md.match(/postgresql:\/\/[^\s]+/)[0], ssl: { rejectUnauthorized: false } });
await c.connect();
/* layers_insert said only "you are signed in" — so a signed-in insert could stamp any owner, or
   none, and an ownerless layer fails ms_layer_writable forever (the husk trap). Now the row you
   insert must name YOU. The service role bypasses RLS, so harness/admin seeding is unaffected. */
await c.query(`alter policy layers_insert on public.layers with check (user_id = auth.uid())`);
const r = await c.query(`select policyname, with_check from pg_policies where tablename='layers' and cmd='INSERT'`);
console.table(r.rows);
// my two probe husks from last night — ownerless, featureless, in no project
const d = await c.query(`delete from layers where user_id is null and slug in ('new-mtc9ugot77g','new-mtc9vpprcua')
  and not exists (select 1 from features_data f where f.layer_id = layers.id)
  and not exists (select 1 from project_layers p where p.layer_id = layers.id) returning slug`);
console.log("husks deleted:", d.rows.map((x) => x.slug));
await c.end();
