/* MapStructor — selection store (carved out of editing.js, 7/28).
   THE single writer of the editor's selected-feature set. Five selection bugs in a row traced to
   multiple subsystems mutating one shared array with different semantics (replace vs merge vs wipe) —
   so the set now lives HERE, mutations go through this API only, and every surface that shows the
   selection (map highlight, table rows, features list, buttons) refreshes from ONE onChange
   subscriber in editing.js. editing.js keeps `_attrSel` as a read-only mirror for its many readers.
   Loads before editing.js (editor.html); editing.js carries a same-contract inline fallback. */
(function () {
  'use strict';
  var _ids = [];    // ordered feature_ids (strings) — the one selection set
  var _subs = [];
  function emit(reason, changed) {
    for (var i = 0; i < _subs.length; i++) { try { _subs[i]({ ids: _ids.slice(), reason: reason, changed: changed }); } catch (e) {} }
  }
  window.MSSel = {
    ids: function () { return _ids.slice(); },
    count: function () { return _ids.length; },
    has: function (fid) { return _ids.indexOf(String(fid)) > -1; },
    add: function (fid) { fid = String(fid); if (_ids.indexOf(fid) > -1) return false; _ids.push(fid); emit('add', [fid]); return true; },
    remove: function (fid) { fid = String(fid); var i = _ids.indexOf(fid); if (i < 0) return false; _ids.splice(i, 1); emit('remove', [fid]); return true; },
    toggle: function (fid) { return this.has(fid) ? (this.remove(fid), false) : (this.add(fid), true); },
    select: function (list) {   // REPLACE the set (plain row-click semantics)
      var next = (list || []).map(String);
      if (next.length === _ids.length && next.every(function (f, i) { return f === _ids[i]; })) return false;
      var prev = _ids; _ids = next; emit('select', prev.concat(next)); return true;
    },
    clear: function () { if (!_ids.length) return false; var gone = _ids; _ids = []; emit('clear', gone); return true; },
    onChange: function (cb) { if (typeof cb === 'function') _subs.push(cb); }
  };
})();
