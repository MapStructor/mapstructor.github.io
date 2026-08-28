import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("c:/repos/mapstructor_docs/testing/harness/node_modules/pg");
const md = fs.readFileSync("c:/repos/mapstructor.github.io/secrets/supabase.md", "utf8");
const c = new Client({ connectionString: md.match(/postgresql:\/\/[^\s]+/)[0], ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`select l.id, l.slug, (select count(*) from features_data f where f.layer_id=l.id) nf,
  (select count(*) from project_layers p where p.layer_id=l.id) np from layers l where l.user_id is null and l.slug like 'new-mtc9%'`);
console.table(r.rows);
for (const row of r.rows) {
  await c.query(`delete from features_data where layer_id=$1`, [row.id]);
  await c.query(`delete from project_layers where layer_id=$1`, [row.id]);
  await c.query(`delete from layers where id=$1`, [row.id]);
  console.log("deleted", row.slug, "(", row.nf, "features,", row.np, "links )");
}
await c.end();
