/* guards.js — absence is an error at the boundary (bug book, architectural fix #2).
 *
 * Family B is the most expensive family in the record: a lookup, parse, write or fetch fails,
 * guarded code treats "not there" as "fine", and the system produces confidently wrong output
 * with no error anywhere. Every multi-day mystery in the catalog has this shape — the untick
 * that did nothing, the rename that reported saved while the database refused, the swallowed
 * ReferenceError that fed null into every fallback.
 *
 * Two mechanisms, deliberately small:
 *
 *   MSGuard.warnOnce(key, what, detail)   — say the thing that is missing, ONCE, naming it.
 *   MSGuard.save(label, query, opts)      — a database write that cannot silently fail.
 *
 * Why `save` exists at all: supabase-js RESOLVES with `{ error }` instead of throwing, so
 * `try { await q } catch {}` is decoration — it never fires. And under RLS an UPDATE that
 * matches no permitted row also resolves happily, with zero rows changed. Both look exactly
 * like success. `save` treats a thrown error, a returned error, and (when asked) an empty
 * result as the same thing: the write did not happen.
 *
 * Rules for using it:
 *  - `rows: 'some'` means "this write MUST change something" — the call site must add
 *    `.select('id')` so there is something to count. Use it for anything a person just did.
 *  - Absence that is legitimate (a deferred layer not hydrated yet) does NOT get a warning.
 *    Warning on normal absence is how an audit becomes noise, and noise is how it gets ignored.
 *
 * Loud by default; `MSGuard.loud = false` silences the console for headless gates, which still
 * read `MSGuard.log`.
 */
(function (root, factory) {
  var M = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = M;   // node: gates import the same rules
  if (typeof window !== "undefined") window.MSGuard = M;
})(this, function () {
  "use strict";

  var seen = Object.create(null);
  var LOG_CAP = 400;

  var M = {
    loud: true,
    log: [],            // [{ t, kind, key, what, detail }]
    onWarn: null,       // optional hook (the editor wires a status line to this)

    /* Say what is missing, once per key. Returns false so it can tail a guard:
       if (!el) return MSGuard.warnOnce('toggle:'+slug, 'no checkbox for this layer'); */
    warnOnce: function (key, what, detail) {
      if (seen[key]) return false;
      seen[key] = 1;
      return M.warn(key, what, detail);
    },

    /* Same, every time — for things that should be counted, not deduped. */
    warn: function (key, what, detail) {
      var rec = { t: Date.now(), kind: "absence", key: key, what: what, detail: detail == null ? "" : String(detail).slice(0, 300) };
      M.log.push(rec); if (M.log.length > LOG_CAP) M.log.splice(0, 100);
      if (M.loud && typeof console !== "undefined") console.warn("[MapStructor] " + what + (rec.detail ? " — " + rec.detail : "") + "  (" + key + ")");
      if (typeof M.onWarn === "function") { try { M.onWarn(rec); } catch (e) {} }
      return false;
    },

    /* A database write that cannot silently fail.
       save(label, query, { rows: 'some'|'any', quiet: true })
       → { ok, data, error, rows }
       `query` is a supabase builder (thenable) or any promise resolving { data, error }. */
    save: function (label, query, opts) {
      opts = opts || {};
      return Promise.resolve()
        .then(function () { return query; })
        .then(function (r) {
          r = r || {};
          if (r.error) return M._fail(label, r.error.message || String(r.error), r.error, opts);
          var n = Array.isArray(r.data) ? r.data.length : (r.data ? 1 : (typeof r.count === "number" ? r.count : null));
          if (opts.rows === "some" && n === 0) {
            // The most expensive silent failure there is: the request succeeded and changed nothing.
            return M._fail(label, "the database accepted the request and changed 0 rows — the row is missing, or permissions refused it", { message: "0 rows" }, opts);
          }
          return { ok: true, data: r.data, error: null, rows: n };
        })
        .catch(function (e) { return M._fail(label, String((e && e.message) || e), e, opts); });
    },

    _fail: function (label, msg, err, opts) {
      if (!opts.quiet) {
        var rec = { t: Date.now(), kind: "write", key: label, what: "save failed: " + label, detail: msg };
        M.log.push(rec); if (M.log.length > LOG_CAP) M.log.splice(0, 100);
        if (M.loud && typeof console !== "undefined") console.error("[MapStructor] save failed: " + label + " — " + msg);
        if (typeof M.onWarn === "function") { try { M.onWarn(rec); } catch (e) {} }
      }
      return { ok: false, data: null, error: err || { message: msg }, rows: 0 };
    },

    /* A lookup whose absence is a bug, not a state. Returns the value or undefined, and says
       so once when it is missing. `where` names the caller so the message is actionable. */
    need: function (value, key, what, where) {
      if (value === null || value === undefined || value === "") {
        M.warnOnce(key, what, where ? "needed by " + where : "");
        return undefined;
      }
      return value;
    },

    /* Everything the guards have seen this session — what a gate asserts on. */
    report: function () {
      return { warnings: M.log.filter(function (r) { return r.kind === "absence"; }).length,
               writeFailures: M.log.filter(function (r) { return r.kind === "write"; }).length,
               entries: M.log.slice() };
    },

    reset: function () { seen = Object.create(null); M.log.length = 0; }
  };

  return M;
});
