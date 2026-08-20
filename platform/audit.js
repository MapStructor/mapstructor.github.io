/* audit.js — the invariant self-audit (bug book ranked fix #1, built 2026-08-19 night).

   WHY THIS EXISTS
   ---------------
   The record in mapstructor_docs/issues/issues_and_bugs.md says nearly every bug in this
   codebase is one of seven shapes, and the two most common — a stored copy of a derivable
   fact drifting (A), and absence being treated as a benign default (B) — share one property:
   the corruption happens at one moment (a copy, a merge, an import) and only SHOWS UP later,
   somewhere else, as surreal rendering. The vertex-dots bug (a merged layer saved with
   `type` NULL and drew a dot at every polygon vertex), the untick bug (a stale toggleElement
   that resolved to no checkbox, so every branch silently no-opped) and the colourless bake
   (a snapshot baked with no colour column) were all invisible for as long as nobody looked.

   This file looks. It asserts the invariants the rest of the code ASSUMES, at the moment a
   structural operation finishes and once after every load, and it says so out loud when one
   is violated. It is a DETECTOR, deliberately:

     * It never repairs anything. A guard that silently fixes what it finds is a second writer
       with its own drift (the AHM-era "self-heal" loop that re-added missing layers is exactly
       that mistake — it mopped up silent failures forever instead of surfacing them).
     * It never writes to the database, and never mutates the node tree or the map.
     * It is not allowed to throw into its caller. A broken audit must never break the editor;
       every rule runs inside its own try, and a rule that throws is reported as a rule bug.

   ONE IMPLEMENTATION, TWO RUNTIMES
   --------------------------------
   The same rules run in the browser (against the live node tree, the DOM and the map) and in
   node (against raw DB rows, for the offline census over every map). Two implementations of
   one pipeline diverging on undocumented invariants is itself family A — the browser vs cloud
   tiler already taught us that — so the rules live here once and both callers import them.

   USAGE (browser)
   ---------------
     MSAudit.run({ layers: layers, rows: rowsById, dom: true, map: beforeMap, why: 'after merge' })
     MSAudit.loud = 'warn' | 'silent' | 'banner'      // default 'warn'

   USAGE (node)
   ------------
     var MSAudit = require('./audit.js');
     MSAudit.checkRows(rows, { projectId: … });       // DB-level, no DOM/map needed
     MSAudit.checkTree(tree, { rowsBySlug: … });      // post-synthesize tree

   SEVERITY
   --------
     'error' — an invariant the code actively relies on is violated; something is broken NOW.
     'warn'  — latent: correct today, will produce a wrong render/report on the next operation
               (a stale copy, a dangling hand-off, a snapshot that no longer matches its layer).
     'info'  — heuristic. Worth a human glance, not necessarily wrong.

   Every finding carries: rule, severity, subject (slug or id), message, and `fix` — the
   smallest thing that would make it true. The `fix` text is what turns a finding into a
   one-line repair instead of an investigation. */

var MSAudit = (function () {
  "use strict";

  var API = {};
  API.loud = "warn";                 // 'warn' | 'silent' | 'banner'  (see report())
  API.version = "2026-08-19";

  // ── helpers ──────────────────────────────────────────────────────────────────────────
  function flat(tree) {
    var out = [];
    (function walk(a) {
      (a || []).forEach(function (n) { if (!n) return; out.push(n); if (n.children) walk(n.children); });
    })(tree || []);
    return out;
  }
  function isLeaf(n) { return n && n.type !== "section" && n.type !== "group" && n.type !== "divider"; }
  function rcOf(row) { return (row && row.raw_config) || {}; }
  function finding(rule, severity, subject, message, fix) {
    return { rule: rule, severity: severity, subject: subject, message: message, fix: fix || null };
  }
  // A rule body that throws is a BUG IN THE AUDIT, and it must look different from a clean pass —
  // a detector that fails silently is the exact instrument this whole file exists to replace.
  // `skip` lets a CALLER turn off rules whose inputs it genuinely cannot supply (the editor has
  // the node tree but not the `user_id` column, so ownership can only be judged offline). A rule
  // that would run against missing data must be skipped explicitly, never left to report a false
  // positive — an audit that cries wolf gets ignored, and then it protects nothing.
  function safely(out, skip, ruleName, fn) {
    if (skip && skip[ruleName]) return;
    try { fn(); }
    catch (e) { out.push(finding(ruleName, "error", "(audit)", "rule threw: " + ((e && e.message) || e), "fix the rule")); }
  }
  function skipSet(ctx) {
    var s = {};
    (((ctx && ctx.skip) || [])).forEach(function (k) { s[k] = 1; });
    return s;
  }

  /* ── DB-ROW RULES ─────────────────────────────────────────────────────────────────────
     These run against raw `layers` rows (plus the project's groups/sections/links) and need
     no browser. This is where LATENT corruption lives: the row is wrong, the loader papers
     over it at read time, and the next operation that copies the row propagates the damage.
     `ctx` = { layers: [rows], projectLayers: [], groups: [], sections: [], projectId }      */
  API.checkRows = function (ctx) {
    var out = [];
    var skip = skipSet(ctx);
    var rows = (ctx && ctx.layers) || [];
    var links = (ctx && ctx.projectLayers) || [];
    var groups = (ctx && ctx.groups) || [];
    var sections = (ctx && ctx.sections) || [];

    var bySlug = {}, byId = {};
    rows.forEach(function (r) { if (r.slug != null) bySlug[r.slug] = r; byId[r.id] = r; });
    var groupIds = {}, sectionIds = {}, groupSlugs = {};
    groups.forEach(function (g) { groupIds[g.id] = g; if (g.slug != null) groupSlugs[g.slug] = g; });
    sections.forEach(function (s) { sectionIds[s.id] = s; });

    // 1. A LAYER WITH ROWS MUST KNOW ITS SHAPE.
    // configLoader defaults a typeless geojson layer to 'circle' (configLoader.js, leafFromRow),
    // which renders polygons as one dot per vertex. Every write path stamps `type` — merge was
    // the one that didn't (8/19). The tree can't see this: by the time synthesize() is done the
    // default has already been applied, so ONLY the row shows the truth.
    safely(out, skip, "layer-type-missing", function () {
      rows.forEach(function (r) {
        if (r.source_type === "geojson-supabase" && r.type == null) {
          // Accuracy matters here: the loader's fallback is 'circle', which is CORRECT for a point
          // layer and catastrophic for a polygon one (a dot at every vertex). The row can't tell
          // us which — so the finding names both outcomes instead of asserting the worse one.
          // It stays an ERROR either way, because `type` is read well beyond the loader: tilegen
          // passes it as geomKind and rasterUnfitReason falls back to 'fill', so a typeless POINT
          // layer is judged fit for a raster it can never render honestly.
          out.push(finding("layer-type-missing", "error", r.slug || r.id,
            "geojson layer has no `type` — the loader falls back to 'circle' (right for points, a dot at every vertex for polygons), and the tiler reads the same field as 'fill'",
            "check the layer's geometry and set layers.type to match ('fill' | 'line' | 'circle')"));
        }
      });
    });

    // 2. IDS ARE UNIQUE. Duplicate slugs make every id-keyed lookup (checkbox, engine layer,
    //    scrub item, DOM container) ambiguous, and which one wins depends on iteration order.
    safely(out, skip, "duplicate-slug", function () {
      var seen = {};
      rows.forEach(function (r) {
        if (r.slug == null) return;
        if (seen[r.slug]) out.push(finding("duplicate-slug", "error", r.slug,
          "two layers in this project share the slug '" + r.slug + "' (ids " + seen[r.slug] + " and " + r.id + ")",
          "re-slug one of them; every id-keyed lookup is ambiguous until then"));
        else seen[r.slug] = r.id;
      });
    });

    // 3. EVERY LAYER HAS AN OWNER. An ownerless row is invisible to RLS-scoped reads and to
    //    the storage meter, and it cannot be recovered by the owner if anything goes wrong.
    safely(out, skip, "layer-ownerless", function () {
      rows.forEach(function (r) {
        if (r.user_id == null) out.push(finding("layer-ownerless", "error", r.slug || r.id,
          "layers.user_id is NULL — this row belongs to nobody",
          "set user_id to the project owner (every INSERT into layers must stamp it)"));
      });
    });

    // 4. THE OUTLINE HAND-OFF IS KEPT. `outlineSplit` means "another layer draws my border now",
    //    and it makes leafFromRow skip the stroke companion entirely. If nobody claims it, the
    //    polygon has no border at any date (8/7). configLoader HEALS this at read time, so the
    //    map looks fine — but the row is still lying, and the next copy carries the lie forward.
    safely(out, skip, "outline-split-dangling", function () {
      var claimed = {};
      rows.forEach(function (r) { var oo = rcOf(r).outlineOf; if (oo) claimed[oo] = r.slug || r.id; });
      rows.forEach(function (r) {
        if (rcOf(r).outlineSplit && !claimed[r.slug]) {
          out.push(finding("outline-split-dangling", "warn", r.slug || r.id,
            "raw_config.outlineSplit is set but no layer in this project claims outlineOf='" + r.slug + "' — the border hand-off has no taker (the loader heals the render; the row stays wrong)",
            "delete raw_config.outlineSplit on this row, or create the outline layer that claims it"));
        }
      });
    });

    // 5. CROSS-REFERENCES RESOLVE. outlineOf names a slug in THIS project; instanceOf and
    //    _msFromLayer name layer ids that must still exist (a pointer copy whose source was
    //    deleted renders nothing and bakes nothing, with no error anywhere).
    safely(out, skip, "xref-unresolved", function () {
      rows.forEach(function (r) {
        var rc = rcOf(r);
        if (rc.outlineOf && !bySlug[rc.outlineOf]) {
          out.push(finding("xref-unresolved", "error", r.slug || r.id,
            "raw_config.outlineOf='" + rc.outlineOf + "' names no layer in this project — this outline draws a parent that isn't here",
            "repoint outlineOf at the real parent slug, or delete this orphaned outline layer"));
        }
        // instanceOf/_msFromLayer may legitimately point ACROSS projects (a portal add), so a
        // miss here is only reportable when the census has the global id set; ctx.knownLayerIds
        // is supplied by the offline census and omitted in the browser.
        if (ctx && ctx.knownLayerIds) {
          ["instanceOf", "_msFromLayer"].forEach(function (k) {
            var v = rc[k];
            if (v && !ctx.knownLayerIds[v]) {
              out.push(finding("xref-unresolved", "error", r.slug || r.id,
                "raw_config." + k + "='" + v + "' points at a layer id that no longer exists",
                "this layer reads a deleted source — re-point it, or delete it"));
            }
          });
        }
      });
    });

    // 6. A SENTINEL IS NEVER DATA. `fill-outline-color: rgba(0,0,0,0)` is OUR marker meaning
    //    "the stroke companion owns this border" — three consumers have misread it as a chosen
    //    colour, and once persisted it becomes indistinguishable from one (8/14: "I split off
    //    the lines and there is no line"). A row carrying the sentinel WITHOUT a companion
    //    width is the dangerous shape: nothing will re-derive it.
    safely(out, skip, "sentinel-persisted", function () {
      rows.forEach(function (r) {
        var p = r.paint || {};
        var foc = p["fill-outline-color"];
        if (foc != null && String(foc).replace(/\s+/g, "") === "rgba(0,0,0,0)") {
          // A companion can be: a stored line-width on the same row, a split-off outline layer,
          // or — in the LIVE TREE — the `stroke` object configLoader synthesizes, which is exactly
          // when it writes this sentinel on purpose. Counting that as a violation would make the
          // audit cry wolf on every healthy fill in the editor (caught on the first live run).
          var hasCompanion = (p["line-width"] != null) || rcOf(r).outlineSplit || !!rcOf(r).stroke;
          if (!hasCompanion) {
            out.push(finding("sentinel-persisted", "warn", r.slug || r.id,
              "paint.fill-outline-color is the transparent SENTINEL but nothing owns this border (no line-width, no outlineSplit) — the fill renders borderless and no code will re-derive it",
              "clear fill-outline-color (let the loader default it) or set a real colour"));
          }
        }
      });
    });

    // 7. A PROMISED PALETTE MUST HAVE BAKED. The scrub raster freezes colours at bake time; if
    //    colour-by names >1 category and the bake produced a 1-colour palette, the layer scrubs
    //    as one flat sheet while the vector shows the full palette (8/19, "the bake didn't do
    //    colors again"). This is the exact bug tonight's fix closed — the rule finds every
    //    OTHER layer already carrying it.
    safely(out, skip, "raster-palette-colorless", function () {
      rows.forEach(function (r) {
        var rc = rcOf(r), cb = rc.colorBy, ry = rc.rasterYears;
        if (!cb || !cb.mapping || !ry) return;
        var cats = Object.keys(cb.mapping || {}).length;
        var pal = (ry.palette && ry.palette.length) || 1;
        if (cats > 1 && pal <= 1) {
          out.push(finding("raster-palette-colorless", "error", r.slug || r.id,
            "colour-by declares " + cats + " categories but the baked snapshot has a " + pal + "-colour palette — this layer scrubs as one flat colour",
            "re-bake the snapshot (panel → Make Faster → Bake snapshot)"));
        }
      });
    });

    // 8. A SNAPSHOT IS STALE WHEN ITS INPUTS MOVED. The raster freezes geometry, dates, colours
    //    and widths. Data changes (tilesGeneratedAt) AND style changes (styleChangedAt) both
    //    invalidate it — style was the half nobody was watching until 8/19.
    safely(out, skip, "raster-stale", function () {
      rows.forEach(function (r) {
        var rc = rcOf(r), ry = rc.rasterYears;
        if (!ry || !ry.at) return;
        function newer(k) {
          try { return rc[k] && new Date(rc[k]) > new Date(ry.at); } catch (e) { return false; }
        }
        if (newer("tilesGeneratedAt")) out.push(finding("raster-stale", "warn", r.slug || r.id,
          "the tiles were re-baked after the snapshot — mid-drag shows the OLD data",
          "re-bake the snapshot"));
        else if (newer("styleChangedAt")) out.push(finding("raster-stale", "warn", r.slug || r.id,
          "the layer was restyled after the snapshot — mid-drag shows the OLD colours",
          "re-bake the snapshot"));
      });
    });

    // 9. OPTED IN, BUT NOTHING BAKED. `fast.raster` true with no rasterYears means the panel
    //    promises instant scrub and the reader has no artifact to read — a silent no-op.
    safely(out, skip, "fast-raster-unbaked", function () {
      rows.forEach(function (r) {
        var rc = rcOf(r);
        if (rc.fast && rc.fast.raster && !rc.rasterYears) {
          out.push(finding("fast-raster-unbaked", "warn", r.slug || r.id,
            "instant-scrub is switched ON for this layer but no snapshot exists — it scrubs as a vector and nothing says so",
            "bake the snapshot, or clear raw_config.fast.raster"));
        }
      });
    });

    // 10. A TILED LAYER HAS TILES. source_type says vector tiles; if neither a pmtiles archive
    //     nor a source_url survives, the layer renders NOTHING and the map just looks empty.
    safely(out, skip, "tiles-missing", function () {
      rows.forEach(function (r) {
        if (r.source_type !== "vector-tiles-url") return;
        if (!rcOf(r).pmtiles && !r.source_url) {
          out.push(finding("tiles-missing", "error", r.slug || r.id,
            "layer is marked vector-tiles-url but has neither raw_config.pmtiles nor source_url — it renders nothing",
            "re-bake the layer's tiles, or restore its source_url"));
        }
      });
    });

    // 11. THE COLOUR-BY COLUMN IS IN THE TILES. A tiled layer paints by ['get', prop]; skinny
    //     tiles carry ONLY id + days + label + the declared label/colour columns. If the paint
    //     reads a property the bake never wrote, every feature takes the match fallback — the
    //     vector-side twin of the colourless bake.
    safely(out, skip, "colorby-prop-not-baked", function () {
      rows.forEach(function (r) {
        if (r.source_type !== "vector-tiles-url") return;
        var rc = rcOf(r), cb = rc.colorBy;
        if (!cb || !cb.prop || cb.mode === "presence") return;
        var baked = { label: 1 };
        if (rc.tilesLabelField) baked[rc.tilesLabelField] = 1;
        if (rc.labels && rc.labels.field) baked[rc.labels.field] = 1;
        if (!baked[cb.prop]) {
          out.push(finding("colorby-prop-not-baked", "warn", r.slug || r.id,
            "colour-by reads '" + cb.prop + "' but the tiles bake only " + Object.keys(baked).join("/") + " — every feature will take the fallback colour",
            "re-bake the tiles (the bake picks up colorBy.prop), or colour by a baked column"));
        }
      });
    });

    // 12. HEAVY GEOMETRY NEEDS TILES. configLoader deliberately refuses to hydrate a heavyGeom
    //     layer from rows (it would reproduce the import's OOM on every visit) — so without a
    //     bake it renders nothing, forever, silently (8/15).
    safely(out, skip, "heavy-geom-untiled", function () {
      rows.forEach(function (r) {
        var rc = rcOf(r);
        if (rc.heavyGeom && !rc.pmtiles) {
          out.push(finding("heavy-geom-untiled", "error", r.slug || r.id,
            "layer is marked heavyGeom (streamed import) and has no tiles — the loader will not hydrate it from rows, so it renders nothing",
            "bake this layer to tiles (layer panel → convert/re-bake)"));
        }
      });
    });

    // 13. THE TREE'S PARENT LINKS RESOLVE. A project_layers row pointing at a group or section
    //     that isn't in this project drops the layer to the top level with no explanation.
    safely(out, skip, "link-parent-missing", function () {
      links.forEach(function (pl) {
        if (pl.group_id && !groupIds[pl.group_id]) out.push(finding("link-parent-missing", "error", pl.layer_id,
          "project_layers.group_id=" + pl.group_id + " names no group in this project — the layer falls back to the top level",
          "re-parent the layer, or clear group_id"));
        if (pl.section_id && !sectionIds[pl.section_id]) out.push(finding("link-parent-missing", "error", pl.layer_id,
          "project_layers.section_id=" + pl.section_id + " names no section in this project",
          "re-parent the layer, or clear section_id"));
      });
      groups.forEach(function (g) {
        if (g.section_id && !sectionIds[g.section_id]) out.push(finding("link-parent-missing", "error", g.slug || g.id,
          "layer_groups.section_id=" + g.section_id + " names no section in this project",
          "re-parent the group, or clear section_id"));
      });
    });

    // 14. THE STORED TOGGLE MATCHES THE SLUG. This field is the derive-don't-store argument in
    //     one line: 6/23 it was MISSING (one untick cascaded every layer off), the fix STORED
    //     it, and 8/18 the stored copy DRIFTED on copy (untick did nothing). configLoader heals
    //     only the truncation signature; anything else survives as a silent mis-target.
    safely(out, skip, "toggle-drift", function () {
      rows.forEach(function (r) {
        var te = rcOf(r).toggleElement;
        if (te == null || te === r.slug) return;
        var healed = (typeof r.slug === "string" && r.slug.indexOf(te + "-") === 0);
        out.push(finding("toggle-drift", healed ? "warn" : "error", r.slug || r.id,
          "raw_config.toggleElement='" + te + "' but the slug is '" + r.slug + "'" +
            (healed ? " (the loader heals this truncation at read time; the row stays wrong)"
                    : " — the checkbox lookup will find nothing and every toggle branch silently no-ops"),
          "set toggleElement to the slug, or delete the field (the loader derives it)"));
      });
    });

    // 15. A COPY IS NOT A CLONE OF SOMEONE ELSE'S IDENTITY. Copy/portal-add mint a new slug and
    //     must remap every identity field; a leftover DOM-identity field from the source makes
    //     two layers fight over one container/class.
    safely(out, skip, "identity-collision", function () {
      var seen = {};
      rows.forEach(function (r) {
        ["containerId", "className", "topLayerClass"].forEach(function (k) {
          var v = rcOf(r)[k];
          if (!v) return;
          var key = k + "|" + v;
          if (seen[key] && seen[key] !== r.slug) {
            out.push(finding("identity-collision", "warn", r.slug || r.id,
              "raw_config." + k + "='" + v + "' is also used by '" + seen[key] + "' — two layers share one DOM identity",
              "re-derive " + k + " from this layer's own slug"));
          } else seen[key] = r.slug;
        });
      });
    });

    return out;
  };

  /* ── TREE RULES ───────────────────────────────────────────────────────────────────────
     Run against the SYNTHESIZED node tree (what the engine actually consumes). These catch
     what survives the loader's healing.  ctx = { rowsBySlug } (optional)                   */
  API.checkTree = function (tree, ctx) {
    var out = [];
    var skip = skipSet(ctx);
    var nodes = flat(tree);

    safely(out, skip, "tree-duplicate-id", function () {
      var seen = {};
      nodes.forEach(function (n) {
        if (n.id == null) {
          out.push(finding("tree-duplicate-id", "error", "(unnamed)", "a node has no id", "give every node a stable id"));
          return;
        }
        if (seen[n.id]) out.push(finding("tree-duplicate-id", "error", n.id,
          "two nodes in the rendered tree share the id '" + n.id + "'",
          "re-slug one — every lookup keyed on this id is ambiguous"));
        seen[n.id] = 1;
      });
    });

    // A leaf the engine will try to render must have a source. A leaf with neither source nor
    // a deferred marker is a node that will never draw and never explain itself.
    safely(out, skip, "leaf-sourceless", function () {
      nodes.forEach(function (n) {
        if (!isLeaf(n)) return;
        if (!n.source && !n._deferred && !n.tileset_id) {
          out.push(finding("leaf-sourceless", "warn", n.id,
            "leaf node has no source and is not deferred — nothing will render for it",
            "check the layer's source_type/source_url in the database"));
        }
      });
    });

    // Group plumbing: the ± caret works by itemSelector matching each child's topLayerClass.
    // Editor-made groups had neither and the caret silently did nothing; synthesize derives
    // them now, so a mismatch here means something else wrote the field afterwards.
    safely(out, skip, "group-plumbing", function () {
      nodes.forEach(function (g) {
        if (!g.children || g.type !== "group") return;
        var want = "." + g.id + "_item";
        if (g.itemSelector && g.itemSelector !== want) {
          out.push(finding("group-plumbing", "warn", g.id,
            "group itemSelector='" + g.itemSelector + "' but its children are classed '" + g.id + "_item' — the collapse caret will match nothing",
            "set itemSelector to '" + want + "' (or delete it — synthesize derives it)"));
        }
        (g.children || []).forEach(function (k) {
          if (k.topLayerClass && k.topLayerClass !== g.id) {
            out.push(finding("group-plumbing", "warn", k.id,
              "child's topLayerClass='" + k.topLayerClass + "' but its parent group is '" + g.id + "'",
              "set topLayerClass to the parent group's id"));
          }
        });
      });
    });

    return out;
  };

  /* ── LIVE RULES (browser only) ────────────────────────────────────────────────────────
     Everything that needs the DOM, the map, or the running scrub. Each is skipped cleanly
     when its subject isn't present, so the same run() works on a page without a map.       */
  API.checkLive = function (ctx) {
    var out = [];
    var skip = skipSet(ctx);
    var tree = (ctx && ctx.layers) || [];
    var nodes = flat(tree);
    var doc = (typeof document !== "undefined") ? document : null;
    var map = ctx && ctx.map;

    // THE TOGGLE RESOLVES TO A REAL CHECKBOX. This is the untick bug's signature, and it is
    // exactly what every `if (checkbox && …)` guard swallows.
    if (doc) safely(out, skip, "toggle-no-checkbox", function () {
      nodes.forEach(function (n) {
        if (!isLeaf(n) || n.id == null) return;
        var id = n.toggleElement || n.id;
        if (!doc.getElementById(id)) {
          out.push(finding("toggle-no-checkbox", "error", n.id,
            "toggle target '" + id + "' resolves to no checkbox in the DOM — ticking or unticking this layer will silently do nothing",
            "set the node's toggleElement to its own id"));
        }
      });
    });

    // EVERY ENGINE LAYER BELONGS TO A NODE. An orphaned map layer is a leak from a delete or a
    // restyle that added a companion nobody owns — it keeps rendering, and no checkbox hides it.
    if (map && map.getStyle) safely(out, skip, "orphan-engine-layer", function () {
      var known = {};
      nodes.forEach(function (n) { if (n.id) known[n.id] = 1; });
      var SUFFIX = /-(left|right|stroke-left|stroke-right|labels-left|labels-right|label-left|label-right|highlighted-left|highlighted-right)$/;
      var style = map.getStyle() || {};
      (style.layers || []).forEach(function (L) {
        var id = String(L.id || "");
        if (!SUFFIX.test(id)) return;                      // not one of ours
        var base = id.replace(SUFFIX, "");
        if (!known[base]) {
          out.push(finding("orphan-engine-layer", "warn", id,
            "map layer '" + id + "' has no node named '" + base + "' — it renders with nothing owning it",
            "remove the layer on delete, or restore the node"));
        }
      });
    });

    // A BAKED, OPTED-IN LAYER HAS A SCRUB ITEM. The 8/19 dead-bake bug in one assertion: the
    // artifact existed, the opt-in was on, and the reader had zero items — with no error.
    safely(out, skip, "scrub-item-missing", function () {
      var S = (typeof window !== "undefined") && window.MSRasterScrub;
      if (!S || !S.items) return;                          // scrub not on this page — not a finding
      if (!S.items.length && !nodes.length) return;
      var haveSlugs = {};
      S.items.forEach(function (it) { if (it && it.slug) haveSlugs[it.slug] = 1; });
      nodes.forEach(function (n) {
        var ry = n.rasterYears;
        var optedIn = n.fast ? !!n.fast.raster : !!ry;
        if (!ry || !optedIn) return;
        if (!haveSlugs[n.id]) {
          out.push(finding("scrub-item-missing", "error", n.id,
            "layer has a baked snapshot and instant-scrub is on, but the scrub reader has no item for it — the drag will animate as a vector",
            "MSRasterScrub.reload(); if that doesn't fix it the bake's config key doesn't match this node"));
        }
      });
    });

    return out;
  };

  /* ── REPORTING ────────────────────────────────────────────────────────────────────────
     Default is console-warn-loudly: findings are grouped, counted, and each carries its fix.
     'silent' collects without printing (the census uses it); 'banner' additionally shows an
     on-screen note for failures that would otherwise be invisible mid-session.             */
  API.report = function (findings, why) {
    var res = { total: findings.length, error: 0, warn: 0, info: 0, findings: findings, why: why || null };
    findings.forEach(function (f) { res[f.severity] = (res[f.severity] || 0) + 1; });
    if (API.loud === "silent" || !findings.length) return res;
    try {
      var head = "MSAudit" + (why ? " (" + why + ")" : "") + ": " +
        res.error + " error, " + res.warn + " warn, " + res.info + " info";
      console.warn(head);
      findings.forEach(function (f) {
        console.warn("  [" + f.severity + "] " + f.rule + " · " + f.subject + " — " + f.message +
          (f.fix ? "\n      fix: " + f.fix : ""));
      });
    } catch (e) {}
    if (API.loud === "banner" && res.error) {
      try {
        var el = document.getElementById("ms-audit-banner") || (function () {
          var d = document.createElement("div");
          d.id = "ms-audit-banner";
          d.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:99999;max-width:520px;" +
            "background:#b4453a;color:#fff;padding:10px 14px;border-radius:6px;font:13px/1.4 system-ui;" +
            "box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer";
          d.title = "Click to dismiss — details are in the console";
          d.onclick = function () { d.remove(); };
          document.body.appendChild(d);
          return d;
        })();
        el.textContent = "⚠ " + res.error + " broken invariant" + (res.error === 1 ? "" : "s") +
          " on this map — see the console for details.";
      } catch (e) {}
    }
    return res;
  };

  /* Browser entry point. Everything is optional: pass what the caller has.
       opts = { layers, rows (raw DB rows for row rules), map, why }
     Never throws. Returns the result object so a caller can act on counts if it wants to. */
  API.run = function (opts) {
    var o = opts || {};
    var findings = [];
    try {
      if (o.rows) findings = findings.concat(API.checkRows({
        layers: o.rows.layers || o.rows, projectLayers: o.rows.projectLayers,
        groups: o.rows.groups, sections: o.rows.sections, projectId: o.projectId
      }));
      var tree = o.layers || (typeof window !== "undefined" && window.layers) || [];
      findings = findings.concat(API.checkTree(tree, o));
      findings = findings.concat(API.checkLive({ layers: tree, map: o.map }));
    } catch (e) {
      findings.push(finding("audit-run", "error", "(audit)", "run() threw: " + ((e && e.message) || e), "fix the audit"));
    }
    return API.report(findings, o.why);
  };

  return API;
})();

// dual export: the browser loads this as a plain script; the offline census requires it, so
// both runtimes execute the SAME rules (two copies of one rule set is the drift this file exists to catch)
try { if (typeof window !== "undefined") window.MSAudit = MSAudit; } catch (e) {}
try { if (typeof module !== "undefined" && module.exports) module.exports = MSAudit; } catch (e) {}
