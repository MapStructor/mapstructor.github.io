// share.js — MapShare: THE Share panel for a map, used by the EDITOR (🔗 Share in the top bar, left of
// Settings) and the DASHBOARD (Share button on each map row). Three levels, stored in
// projects.raw_config.visibility ('private' | 'link' | 'public'); is_public stays synced
// (= visibility === 'public') so existing public listings (u.html profile) keep working.
//
// SEMANTICS — visibility is WHO may see the map; publishing is WHICH SAVED STATE they see. They are
// deliberately separate: edits autosave privately and only reach the View page on Publish, at ANY
// visibility level.
//
// Maps saved before this existed have no raw_config.visibility: they resolve to 'public' when is_public,
// otherwise 'link' — the exact behavior they had (viewable by URL), so no shared link breaks silently.
// NEW maps are created with visibility:'private'. Enforcement of 'private' is client-side in the viewer
// (projectLoader) until the RLS lockdown.
var MapShare = (function () {
  var OPTIONS = [
    { key: 'private', title: 'Private', desc: 'No one can see this map but me.' },
    { key: 'link',    title: 'Anyone with link can view', desc: 'Anyone who has the link can open it. It isn’t listed anywhere.' },
    { key: 'public',  title: 'Publicly visible', desc: 'Anyone can view; it’s listed on your public profile page.' }
  ];

  function effectiveVisibility(row) {
    var v = row && row.raw_config && row.raw_config.visibility;
    if (v === 'private' || v === 'link' || v === 'public') return v;
    return row && row.is_public ? 'public' : 'link';   // pre-panel maps keep the behavior they actually had
  }

  function ensureCss() {
    if (document.getElementById('msshare-css')) return;
    var s = document.createElement('style'); s.id = 'msshare-css';
    s.textContent =
      '#msshare-overlay{position:fixed;inset:0;background:rgba(30,27,46,.45);z-index:100001;display:flex;align-items:center;justify-content:center;font-family:"Source Sans Pro",Arial,sans-serif;}' +
      '#msshare-panel{background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.35);width:400px;max-width:92vw;padding:20px 22px;}' +
      '#msshare-panel h3{margin:0 0 4px;font-size:17px;color:#1e1b2e;}' +
      '#msshare-panel .msshare-sub{font-size:12px;color:#9a93ad;margin:0 0 14px;}' +
      '.msshare-opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #e6e1f0;border-radius:10px;margin-bottom:8px;cursor:pointer;}' +
      '.msshare-opt:hover{background:#faf8fe;}' +
      '.msshare-opt.sel{border-color:#7c5cbf;background:#f6f2fe;}' +
      '.msshare-opt input{margin-top:3px;}' +
      '.msshare-opt b{display:block;font-size:14px;color:#1e1b2e;}' +
      '.msshare-opt span{font-size:12px;color:#6b6680;}' +
      '#msshare-linkrow{display:none;margin-top:4px;}' +
      '#msshare-linkrow input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #cdc6e0;border-radius:8px;font-size:12px;color:#555;background:#faf9fd;}' +
      '#msshare-copy{margin-top:6px;padding:6px 12px;border:1px solid #d9cff1;border-radius:6px;background:#efeaf8;color:#4a3f66;font-weight:600;font-size:12px;cursor:pointer;}' +
      '#msshare-status{font-size:12px;margin-top:8px;min-height:15px;}' +
      '#msshare-note{font-size:11px;color:#9a93ad;margin-top:10px;border-top:1px solid #f0ecf8;padding-top:8px;line-height:1.5;}' +
      '#msshare-close{float:right;border:none;background:none;font-size:18px;color:#888;cursor:pointer;line-height:1;}';
    document.head.appendChild(s);
  }

  async function save(db, projectId, vis) {
    // read-merge-write: raw_config carries other project chrome (about, popups, timeline…) — never clobber it
    var cur = await db.from('projects').select('raw_config').eq('id', projectId).single();
    if (cur.error) throw new Error(cur.error.message);
    var rc = (cur.data && cur.data.raw_config) || {};
    rc.visibility = vis;
    var r = await db.from('projects').update({ raw_config: rc, is_public: vis === 'public' }).eq('id', projectId);
    if (r.error) throw new Error(r.error.message);
  }

  // open({ db, projectId, viewUrl, onChange }) — fetches the fresh row itself, so callers stay dumb
  async function open(opts) {
    ensureCss();
    var old = document.getElementById('msshare-overlay'); if (old) old.remove();
    var db = opts.db, projectId = opts.projectId;
    var row = null;
    try { var r = await db.from('projects').select('is_public, raw_config').eq('id', projectId).maybeSingle(); row = r.data; } catch (e) {}
    var current = effectiveVisibility(row);

    var ov = document.createElement('div'); ov.id = 'msshare-overlay';
    var opts3 = OPTIONS.map(function (o) {
      return '<label class="msshare-opt' + (o.key === current ? ' sel' : '') + '" data-k="' + o.key + '">' +
        '<input type="radio" name="msshare-vis" value="' + o.key + '"' + (o.key === current ? ' checked' : '') + '>' +
        '<span style="flex:1;"><b>' + o.title + '</b><span>' + o.desc + '</span></span></label>';
    }).join('');
    ov.innerHTML = '<div id="msshare-panel">' +
      '<button id="msshare-close" title="Close">&times;</button>' +
      '<h3>Share</h3>' +
      '<p class="msshare-sub">Who can see this map</p>' +
      opts3 +
      '<div id="msshare-linkrow"><input id="msshare-url" readonly><button id="msshare-copy">Copy link</button></div>' +
      '<div id="msshare-status"></div>' +
      '<div id="msshare-note">Visitors see the last <b>published</b> version — edits autosave privately until you hit <b>Publish</b>. Sharing controls who can see the map at all.</div>' +
      '</div>';
    document.body.appendChild(ov);

    var status = ov.querySelector('#msshare-status');
    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#msshare-close').addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });

    var linkRow = ov.querySelector('#msshare-linkrow'), urlIn = ov.querySelector('#msshare-url');
    function syncLinkRow(vis) {
      if (opts.viewUrl && (vis === 'link' || vis === 'public')) { linkRow.style.display = 'block'; urlIn.value = opts.viewUrl; }
      else linkRow.style.display = 'none';
    }
    syncLinkRow(current);
    ov.querySelector('#msshare-copy').addEventListener('click', function () {
      var b = this;
      try { navigator.clipboard.writeText(urlIn.value).then(function () { b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = 'Copy link'; }, 1800); }, function () { urlIn.select(); }); }
      catch (e) { urlIn.select(); }
    });

    Array.prototype.forEach.call(ov.querySelectorAll('input[name="msshare-vis"]'), function (radio) {
      radio.addEventListener('change', async function () {
        var vis = this.value;
        Array.prototype.forEach.call(ov.querySelectorAll('.msshare-opt'), function (l) { l.classList.toggle('sel', l.getAttribute('data-k') === vis); });
        status.textContent = 'Saving…'; status.style.color = '#6b6680';
        try {
          await save(db, projectId, vis);
          status.textContent = 'Saved ✓'; status.style.color = '#2d7a2d';
          syncLinkRow(vis);
          if (opts.onChange) try { opts.onChange(vis); } catch (e2) {}
        } catch (e) {
          status.textContent = 'Save failed: ' + (e && e.message); status.style.color = '#b4453a';
        }
      });
    });
  }

  return { open: open, effectiveVisibility: effectiveVisibility };
})();
