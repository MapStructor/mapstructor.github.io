/* modalLock.js — the ONE owner of the modal lock (9/8, retiring the multi-owner state flags).
 *
 * WHAT THE LOCK MEANS. While any editor modal that must not be dismissed by a stray click is on
 * screen, two things stand down: the engine's backdrop-click close (map/engine/index.js reads
 * `window.__msModalLock` before closing) and the editor's single-key hotkeys (editing.js reads
 * the same flag before acting on a keypress).
 *
 * WHY A MODULE. Three files used to write `window.__msModalLock = true/false` directly — the
 * feature-popup edit session, the stale-snapshot ask, the storage wall (editing.js), the Layer
 * order panel (layerOrder.js) and the merge panel (merge.js). Plain true/false writers collide
 * the moment two of those stack: closing the one on top set the flag false and silently unlocked
 * the one underneath. Two of the five sites had already grown hand-rolled save-and-restore
 * dances (`prevLock`, `ov._prevLock`) to survive exactly that — the two-owners disease, patched
 * locally twice instead of owned once. A COUNTED lock ends the class: every holder gets a token,
 * the flag is simply "is anyone holding", and closing one modal can never unlock another.
 *
 * THE ENGINE IS UNTOUCHED. This module keeps `window.__msModalLock` up to date as a plain
 * boolean, so the engine's reader — which also runs in the viewer and inside every downloaded
 * standalone copy — needs no change and no knowledge that this file exists. Readers read the
 * global; only this file writes it (`state-owner-check.mjs` enforces that from now on).
 *
 * DEGRADATION. If this file fails to load, callers guard with `window.MSLock &&` and simply run
 * unlocked: a backdrop click can then close a panel early — the pre-2026 behaviour, cosmetic —
 * and nothing throws.
 */
(function () {
  if (window.MSLock) return;
  var holders = {};   // token → label (label kept for debugging: MSLock.holding())
  var seq = 0;
  function sync() { window.__msModalLock = Object.keys(holders).length > 0; }
  window.MSLock = {
    /* Take the lock. Returns a token; the caller keeps it and hands it back to drop(). */
    hold: function (label) { seq++; var t = "lk" + seq; holders[t] = String(label || t); sync(); return t; },
    /* Release one hold. Unknown or already-dropped tokens are a safe no-op — a close handler
       that runs twice must not throw, and must not release somebody else's hold. */
    drop: function (t) { if (t != null && holders[t] != null) { delete holders[t]; sync(); } },
    held: function () { return Object.keys(holders).length > 0; },
    holding: function () { return Object.keys(holders).map(function (k) { return holders[k]; }); }
  };
  sync();
})();
