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
# DATE_AS_STRING=YES (10/3): GDAL's default date conversion is NOT faithful — measured, ST_Read
# turned the archive's "1867-03-30" into DATE 1867-03-31, so every date column in every geo
# parquet baked before this line is one day late (the merge pipeline never read them — C5 reads
# the .geojson — but the user-facing GeoParquet download shipped the shifted dates, and the
# editor's one-feature reader would have too). As strings they pass through byte for byte.
con.execute("CREATE OR REPLACE TABLE geo_t AS SELECT * FROM ST_Read(" + sq(export_path) + ", open_options=['DATE_AS_STRING=YES'])")

# ONE-FEATURE READS (10/3). The editor opens a clicked folded feature by range-reading this file
# with `WHERE feature_id = ?` (platform/foldRead.js). DuckDB skips row groups by their min/max
# stats, which only helps if (a) rows are ORDERED by feature_id so each group covers a narrow id
# band, and (b) there is more than one group. (b) is the trap: DuckDB's own writer flushes groups
# per 2048-row vector, so a 220-row/78 MB layer (big geometries) is ALWAYS one group no matter
# what ROW_GROUP_SIZE says — measured 10/3: a one-feature geometry read cost the whole 77.8 MB.
# So the layout pass below is pyarrow, which honors tiny groups. Measured on the same artifact:
# 2 MB groups at zstd level 3 → 75.9 MB file (smaller than before) and 0.8 MB per clicked feature.
geo_cols = [d[0] for d in con.execute("DESCRIBE geo_t").fetchall()]
order = " ORDER BY feature_id" if "feature_id" in geo_cols else ""
try:
    con.execute("COPY (SELECT * FROM geo_t" + order + ") TO " + sq(geo_out) + " (FORMAT PARQUET, COMPRESSION ZSTD)")
except Exception:
    con.execute("COPY (SELECT * FROM geo_t" + order + ") TO " + sq(geo_out) + " (FORMAT PARQUET)")
n_geo = con.execute("SELECT count(*) FROM geo_t").fetchone()[0]

relayout = "skipped"
try:
    import pyarrow.parquet as pq   # the workflow installs it; a local run without it still bakes
    t = pq.read_table(geo_out)     # file-level metadata rides along — the 'geo' key QGIS/GDAL reads
    size = os.path.getsize(geo_out)
    rg = max(1, min(65536, int(2 * 1048576 * max(t.num_rows, 1) / max(size, 1)) or 1))   # ~2 MB per group
    tmp = geo_out + ".rg"
    pq.write_table(t, tmp, row_group_size=rg, compression="zstd", compression_level=3)
    os.replace(tmp, geo_out)
    relayout = f"{rg} rows/group"
except Exception as e:             # the un-relaid file is still correct — just whole-column reads
    relayout = "failed: " + str(e)[:120]

os.remove(flat_path)
print(json.dumps({"attr_rows": n_attr, "attr_bytes": os.path.getsize(attr_out),
                  "geo_rows": n_geo, "geo_bytes": os.path.getsize(geo_out),
                  "geo_relayout": relayout}))
