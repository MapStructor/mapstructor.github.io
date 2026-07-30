#!/usr/bin/env python3
"""fold-parquet.py — bake the two fold parquet artifacts (The Fold C2, 7/29).

   argv: rows_attr.json  export.geojson  attr_out.parquet  geo_out.parquet

   ATTR SIDECAR: an exact mirror of platform/bigtable.js bakeFromRows so DuckDB-WASM
   readers (attr table, viewer list, query window) can't tell a cloud bake from a
   browser bake: STD columns always VARCHAR via String()-coercion, custom_fields keys
   as "c:<key>" typed DOUBLE only when EVERY non-null value is a finite number
   (booleans count as non-numeric, like JS typeof), same read_json(format='array',
   columns={...}) load, ZSTD with plain-parquet fallback.

   GEOPARQUET: duckdb spatial ST_Read over the export FC (GDAL-backed; geometry lands
   as WKB) — the canonical fold source-of-truth artifact (C5 merges read it).

   One divergence from the browser, on purpose: nested objects/arrays inside
   custom_fields serialize as JSON here (the browser's String() would say
   "[object Object]"); import-created layers never contain them anyway
   (importCustomFields flattens nested values to strings before insert)."""
import duckdb, json, math, sys, os

rows_path, export_path, attr_out, geo_out = sys.argv[1:5]
rows = json.load(open(rows_path, encoding="utf-8"))

STD = ["feature_id", "label", "description", "start_date", "end_date", "content_id"]
CF = "c:"

def sq(s):   # SQL string literal, same as bigtable.js sq()
    return "'" + str(s).replace("'", "''") + "'"

def js_string(v):   # JS String(v) semantics for the values we actually store
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if math.isfinite(v) and v == int(v) and abs(v) < 1e21:
            return str(int(v))          # String(2.0) === "2"
        return repr(v)
    if isinstance(v, (dict, list)):
        return json.dumps(v)
    return str(v)

# custom_fields key collection — first-seen order across all rows (collectKeys)
keys, seen = [], set()
for r in rows:
    cf = r.get("custom_fields") or {}
    for k in cf:
        if k not in seen:
            seen.add(k); keys.append(k)

# full-scan typing (keyTypes): DOUBLE only if every non-null, non-'' value is a finite number
types = {}
for k in keys:
    num = other = False
    for r in rows:
        v = (r.get("custom_fields") or {}).get(k)
        if v is None or v == "":
            continue
        if isinstance(v, bool):
            other = True
        elif isinstance(v, (int, float)) and math.isfinite(v):
            num = True
        else:
            other = True
    types[k] = "DOUBLE" if (num and not other) else "VARCHAR"

flat = []
for r in rows:
    o = {}
    for f in STD:
        v = r.get(f)
        o[f] = None if v is None else js_string(v)
    cf = r.get("custom_fields") or {}
    for k in keys:
        v = cf.get(k)
        o[CF + k] = None if (v is None or v == "") else (v if types[k] == "DOUBLE" else js_string(v))
    flat.append(o)

cols = ", ".join([sq(f) + ": 'VARCHAR'" for f in STD] + [sq(CF + k) + ": " + sq(types[k]) for k in keys])
flat_path = "fold_attr_flat.json"
json.dump(flat, open(flat_path, "w", encoding="utf-8"))

con = duckdb.connect()
con.execute("CREATE OR REPLACE TABLE bake_t AS SELECT * FROM read_json(" + sq(flat_path) + ", format='array', columns={" + cols + "})")
try:
    con.execute("COPY bake_t TO " + sq(attr_out) + " (FORMAT PARQUET, COMPRESSION ZSTD)")
except Exception:
    con.execute("COPY bake_t TO " + sq(attr_out) + " (FORMAT PARQUET)")
n_attr = con.execute("SELECT count(*) FROM bake_t").fetchone()[0]

con.execute("INSTALL spatial; LOAD spatial;")
con.execute("CREATE OR REPLACE TABLE geo_t AS SELECT * FROM ST_Read(" + sq(export_path) + ")")
try:
    con.execute("COPY geo_t TO " + sq(geo_out) + " (FORMAT PARQUET, COMPRESSION ZSTD)")
except Exception:
    con.execute("COPY geo_t TO " + sq(geo_out) + " (FORMAT PARQUET)")
n_geo = con.execute("SELECT count(*) FROM geo_t").fetchone()[0]

os.remove(flat_path)
print(json.dumps({"attr_rows": n_attr, "attr_bytes": os.path.getsize(attr_out),
                  "geo_rows": n_geo, "geo_bytes": os.path.getsize(geo_out)}))
