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
// NEW maps are created with visibility:'private'.
//
// PRIVATE IS ENFORCED SERVER-SIDE (verified 8/23, share-flow-gate). This line used to read
// "enforcement of 'private' is client-side in the viewer (projectLoader) until the RLS lockdown" —
// written before that lockdown landed on 7/30, and left behind after it did. Measured against the
// live API with only the publishable key, a stranger reaches ZERO project rows, ZERO layer links
// and ZERO feature rows of a private map. The database is carrying it.
//
// The stale note was worth correcting rather than deleting: a comment that UNDERSTATES the security
// model invites two mistakes. Someone may bolt a client-side guard onto a problem already solved,
// or may assume the server is not protecting this and design the next feature around that. Both
// start from believing the comment over the system.
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

  // ── edit access (collaborative editing, Google-Drive style): raw_config.editAccess =
  //    { anyoneWithLink: bool, emails: [lowercased] }. WHO MAY EDIT = the owner, OR anyone with
  //    the link when anyoneWithLink, OR a signed-in user whose email is on the list. Real
  //    enforcement rides on the RLS lockdown (writes are DB-gated there); until then the editor
  //    honors this client-side. ──
  function editAccessOf(row) {
    var ea = row && row.raw_config && row.raw_config.editAccess;
    return { anyoneWithLink: !!(ea && ea.anyoneWithLink), emails: (ea && ea.emails) ? ea.emails.slice() : [] };
  }
  function canEdit(row, user) {
    if (!user || !user.id) return false;
    if (row && row.user_id && user.id === row.user_id) return true;   // owner
    var ea = editAccessOf(row);
    if (ea.anyoneWithLink) return true;
    var em = String(user.email || '').toLowerCase();
    return !!em && ea.emails.map(function (e) { return String(e).toLowerCase(); }).indexOf(em) > -1;
  }
  /* Atomic since 8/22. This used to read raw_config, set one key and write the whole blob back —
     a lost update by construction, and demonstrated: saving two settings at once discarded one of
     them silently. WHO CAN EDIT A MAP is the worst key in this blob to lose a write on, because
     losing it fails OPEN if a stale copy still carries anyoneWithLink. */
  async function saveEditAccess(db, projectId, ea) {
    var r = await db.rpc('ms_patch_project_config', { p_id: projectId, p_patch: {
      editAccess: { anyoneWithLink: !!ea.anyoneWithLink, emails: (ea.emails || []).map(function (e) { return String(e).toLowerCase().trim(); }).filter(Boolean) }
    } });
    if (r.error) throw new Error(r.error.message);
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
    /* Two writes on purpose, and it is safe: the RPC patches ONE key of the blob atomically, and
       is_public is a plain column, so updating it cannot clobber anything else the way a whole-blob
       write does. */
    var r = await db.rpc('ms_patch_project_config', { p_id: projectId, p_patch: { visibility: vis } });
    if (r.error) throw new Error(r.error.message);
    var r2 = await db.from('projects').update({ is_public: vis === 'public' }).eq('id', projectId);
    if (r2.error) throw new Error(r2.error.message);
    // R2 snapshot sync (7/27, step ②·25): published bundles mirror to the world-readable
    // tiles.mapstructor.com — a flip to private must remove that copy NOW (the live-row gate
    // already blocks the page, but the raw JSON must not stay fetchable); a flip away from
    // private re-mirrors the existing published snapshot so viewers get the fast path without
    // waiting for the next publish. Best-effort: any failure leaves the Postgres path correct.
    try {
      var tok = (await db.auth.getSession()).data.session.access_token;
      var u = 'https://mapstructor-worker.mapstructor.workers.dev/upload/snapshots/' + projectId + '.json';
      if (vis === 'private') {
        await fetch(u, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } });
      } else {
        var snap = await db.from('project_snapshots').select('state').eq('project_id', projectId).eq('label', 'published').limit(1).maybeSingle();
        if (snap.data && snap.data.state) {
          await fetch(u, { method: 'PUT', body: JSON.stringify(snap.data.state),
            headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
        }
      }
    } catch (eSnap) { console.warn('share: R2 snapshot sync failed (Postgres path still correct)', eSnap); }
  }

  // open({ db, projectId, viewUrl, onChange }) — fetches the fresh row itself, so callers stay dumb
  async function open(opts) {
    ensureCss();
    var old = document.getElementById('msshare-overlay'); if (old) old.remove();
    var db = opts.db, projectId = opts.projectId;
    var row = null;
    try { var r = await db.from('projects').select('user_id, is_public, raw_config').eq('id', projectId).maybeSingle(); row = r.data; } catch (e) {}
    var current = effectiveVisibility(row);
    var ea = editAccessOf(row);
    var editUrl = opts.viewUrl ? opts.viewUrl.replace(/index\.html/, 'editor.html') : '';

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
      '<hr style="border:none;border-top:1px solid #f0ecf8;margin:16px 0 12px;">' +
      '<h3 style="font-size:15px;margin:0 0 2px;">Who can edit</h3>' +
      '<p class="msshare-sub" style="margin:0 0 10px;">Give others access to change this map.</p>' +
      '<label class="msshare-opt" data-k="anyedit"><input type="checkbox" id="msshare-anyedit"' + (ea.anyoneWithLink ? ' checked' : '') + '>' +
        '<span style="flex:1;"><b>Anyone with the link can edit</b><span>They open the editor and change this map.</span></span></label>' +
      '<div style="font-size:12px;font-weight:700;color:#6b6680;margin:8px 0 5px;">People with edit access</div>' +
      '<div id="msshare-editlist"></div>' +
      '<div style="display:flex;gap:6px;margin-top:6px;"><input id="msshare-addemail" type="email" placeholder="add a person by email" style="flex:1;box-sizing:border-box;padding:7px 9px;border:1px solid #cdc6e0;border-radius:8px;font-size:12px;">' +
        '<button id="msshare-addbtn" style="padding:0 12px;border:1px solid #d9cff1;border-radius:8px;background:#efeaf8;color:#4a3f66;font-weight:600;font-size:12px;cursor:pointer;">Add</button></div>' +
      '<div id="msshare-editlinkrow" style="display:none;margin-top:10px;"><input id="msshare-editurl" readonly style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #cdc6e0;border-radius:8px;font-size:12px;color:#555;background:#faf9fd;"><button id="msshare-editcopy" style="margin-top:6px;padding:6px 12px;border:1px solid #d9cff1;border-radius:6px;background:#efeaf8;color:#4a3f66;font-weight:600;font-size:12px;cursor:pointer;">Copy edit link</button></div>' +
      '<div id="msshare-editstatus" style="font-size:12px;margin-top:8px;min-height:15px;"></div>' +
      '<hr style="border:none;border-top:1px solid #f0ecf8;margin:16px 0 12px;">' +
      '<h3 style="font-size:15px;margin:0 0 2px;">Map Portal</h3>' +
      '<p class="msshare-sub" style="margin:0 0 8px;">List this map in the public portal for anyone to find.</p>' +
      '<div id="msshare-portal" style="font-size:12.5px;color:#6b6680;">Checking…</div>' +
      '<hr style="border:none;border-top:1px solid #f0ecf8;margin:16px 0 12px;">' +
      '<h3 style="font-size:15px;margin:0 0 2px;">Unpublished changes</h3>' +
      '<p class="msshare-sub" style="margin:0 0 8px;">Go back to the version visitors currently see.</p>' +
      '<button id="msshare-revert" style="padding:7px 13px;border:1px solid #e0cdca;border-radius:8px;background:#fdf4f3;color:#8c3b32;font-weight:600;font-size:12.5px;cursor:pointer;">⏮ Revert to published…</button>' +
      '<div style="font-size:11px;color:#9a93ad;margin-top:6px;line-height:1.5;">Restores the layout and every layer\'s settings. Layers added since then move to Trash (recoverable), and it offers to duplicate this map first.</div>' +
      '<div id="msshare-note">Visitors see the last <b>published</b> version — edits autosave privately until you hit <b>Publish</b>. "Who can see" controls viewing; "Who can edit" controls changing the map.</div>' +
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
      try { navigator.clipboard.writeText(urlIn.value).then(function () { b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = 'Copy link'; }, 1800); }, function () { urlIn.select(); }); }   // cliff-ok: how long a confirmation label stays on screen
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
          loadPortal();   // the portal checklist's "Visibility is Public" line follows live
          if (opts.onChange) try { opts.onChange(vis); } catch (e2) {}
        } catch (e) {
          status.textContent = 'Save failed: ' + (e && e.message); status.style.color = '#b4453a';
        }
      });
    });

    // ── revert to published (8/6) — the panel only opens the dialog; revert.js owns the rest ──
    var revBtn = ov.querySelector('#msshare-revert');
    if (revBtn) revBtn.addEventListener('click', async function () {
      if (!window.MSRevert) {
        try { await new Promise(function (res, rej) {
          var sc = document.createElement('script');
          sc.src = '../platform/revert.js?v=' + Date.now();
          sc.onload = res; sc.onerror = rej; document.head.appendChild(sc);
        }); } catch (eL) { status.textContent = 'Revert is unavailable here.'; status.style.color = '#b4453a'; return; }
      }
      close();
      MSRevert.open({ db: db, projectId: projectId });
    });

    // ── edit-access wiring (collaborative editing) ──
    var eaState = { anyoneWithLink: ea.anyoneWithLink, emails: ea.emails.slice() };
    var estatus = ov.querySelector('#msshare-editstatus');
    var elist = ov.querySelector('#msshare-editlist');
    var elinkrow = ov.querySelector('#msshare-editlinkrow');
    var eurl = ov.querySelector('#msshare-editurl');
    function eSay(t, c) { estatus.textContent = t; estatus.style.color = c || '#6b6680'; }
    function syncEditLink() {
      var on = eaState.anyoneWithLink || eaState.emails.length > 0;
      if (editUrl && on) { elinkrow.style.display = 'block'; eurl.value = editUrl; } else elinkrow.style.display = 'none';
    }
    function renderEmails() {
      elist.innerHTML = '';
      if (!eaState.emails.length) { var d = document.createElement('div'); d.style.cssText = 'font-size:12px;color:#9a93ad;'; d.textContent = 'No one yet — the owner always has access.'; elist.appendChild(d); return; }
      eaState.emails.forEach(function (em, idx) {
        var rowd = document.createElement('div'); rowd.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border:1px solid #eee;border-radius:7px;margin-bottom:4px;font-size:12px;';
        var s = document.createElement('span'); s.textContent = em; rowd.appendChild(s);
        var x = document.createElement('button'); x.textContent = 'Remove'; x.style.cssText = 'border:none;background:none;color:#b4453a;cursor:pointer;font-size:12px;';
        x.addEventListener('click', function () { eaState.emails.splice(idx, 1); persistEA(); });
        rowd.appendChild(x); elist.appendChild(rowd);
      });
    }
    async function persistEA() {
      renderEmails(); syncEditLink(); eSay('Saving…');
      try { await saveEditAccess(db, projectId, eaState); eSay('Saved ✓', '#2d7a2d'); if (opts.onChange) try { opts.onChange(); } catch (e2) {} }
      catch (e) { eSay('Save failed: ' + (e && e.message), '#b4453a'); }
    }
    ov.querySelector('#msshare-anyedit').addEventListener('change', function () { eaState.anyoneWithLink = this.checked; persistEA(); });
    function addEmail() {
      var inp = ov.querySelector('#msshare-addemail'); var v = (inp.value || '').toLowerCase().trim();
      if (!v || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { inp.style.borderColor = '#b4453a'; return; }
      inp.style.borderColor = '#cdc6e0';
      if (eaState.emails.indexOf(v) === -1) eaState.emails.push(v);
      inp.value = ''; persistEA();
    }
    ov.querySelector('#msshare-addbtn').addEventListener('click', addEmail);
    ov.querySelector('#msshare-addemail').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addEmail(); } });
    ov.querySelector('#msshare-editcopy').addEventListener('click', function () { var b = this; try { navigator.clipboard.writeText(eurl.value).then(function () { b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = 'Copy edit link'; }, 1600); }); } catch (e) { eurl.select(); } });   // cliff-ok: how long a confirmation label stays on screen
    renderEmails(); syncEditLink();

    // ── Map Portal (component 2): list/delist this map in the portal_entries catalog.
    //    The four conditions are RLS-enforced server-side; this panel mirrors them as a live
    //    checklist so the ✗ lines tell the owner exactly what to fix. ──
    var pBox = ov.querySelector('#msshare-portal');
    var portalHref = location.pathname.indexOf('/map/') > -1 ? '../portal.html' : 'portal.html';
    var PBTN = 'padding:6px 12px;border:1px solid #d9cff1;border-radius:6px;background:#efeaf8;color:#4a3f66;font-weight:600;font-size:12px;cursor:pointer;';
    var PBTN_RED = 'padding:6px 12px;border:1px solid #f0d4d0;border-radius:6px;background:#fdf1ef;color:#b4453a;font-weight:600;font-size:12px;cursor:pointer;';
    var PTA = 'width:100%;box-sizing:border-box;margin-top:8px;padding:7px 9px;border:1px solid #cdc6e0;border-radius:8px;font-size:12px;font-family:inherit;resize:vertical;';
    function pEsc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function pLine(ok, txt) { return '<div style="margin:2px 0;color:' + (ok ? '#2d7a2d' : '#b4453a') + ';">' + (ok ? '✓' : '✗') + ' ' + txt + '</div>'; }

    // best-effort thumbnail: the live map canvas, downscaled to a small jpeg. Maps render
    // without preserveDrawingBuffer, so a between-paints read comes back blank — detect a
    // flat frame and drop it (the portal card falls back to its styled placeholder).
    function captureThumb() {
      try {
        var m = window.beforeMap || window.afterMap; if (!m || !m.getCanvas) return null;
        var src = m.getCanvas();
        var w2 = 480, h2 = Math.max(1, Math.round(src.height * w2 / Math.max(1, src.width)));
        var cv = document.createElement('canvas'); cv.width = w2; cv.height = h2;
        var cx = cv.getContext('2d'); cx.drawImage(src, 0, 0, w2, h2);
        var d = cx.getImageData(0, 0, w2, h2).data, first = [d[0], d[1], d[2]], varies = false;
        for (var i = 4; i < d.length; i += 4 * 997) {
          if (Math.abs(d[i] - first[0]) + Math.abs(d[i + 1] - first[1]) + Math.abs(d[i + 2] - first[2]) > 12) { varies = true; break; }
        }
        if (!varies) return null;
        var url = cv.toDataURL('image/jpeg', 0.72);
        if (url.length > 110000) url = cv.toDataURL('image/jpeg', 0.5);
        if (url.length > 110000) {
          // the share card ends up with no picture at all, and nothing says so
          if (typeof window !== "undefined" && window.MSGuard) window.MSGuard.cliff("share-thumbnail-too-big", url.length, 110000,
            "this view is too detailed to save as a share thumbnail, so the shared link will have no preview picture");
          return null;
        }
        return url;
      } catch (e) { return null; }
    }

    async function submitPortal(isUpdate) {
      var ta = ov.querySelector('#msshare-pblurb');
      var blurb = ((ta && ta.value) || '').trim().slice(0, 300);
      var st = ov.querySelector('#msshare-pstatus');
      if (st) { st.textContent = 'Saving…'; st.style.color = '#6b6680'; }
      try {
        // a DELIBERATE thumbnail (Settings → 📸 Set current view as portal thumbnail, stored in
        // raw_config.thumbnail) always beats the automatic capture of whatever is on screen
        var thumb = null;
        try {
          var rr = await db.from('projects').select('raw_config').eq('id', projectId).single();
          var tt = rr.data && rr.data.raw_config && rr.data.raw_config.thumbnail;
          if (tt && /^(data:image\/|https?:\/\/)/.test(tt)) thumb = tt;
        } catch (eT) {}
        if (!thumb) thumb = captureThumb();
        if (isUpdate) {
          var payload = { blurb: blurb }; if (thumb) payload.thumb = thumb;   // keep an existing thumb when capture fails
          var r = await db.from('portal_entries').update(payload).eq('project_id', projectId);
          if (r.error) throw new Error(r.error.message);
        } else {
          var me2 = await MapAuth.currentUser();
          var r2 = await db.from('portal_entries').insert({ project_id: projectId, user_id: me2.id, blurb: blurb, thumb: thumb });
          if (r2.error) throw new Error(r2.error.message);
        }
        loadPortal();
      } catch (e) { if (st) { st.textContent = 'Failed: ' + (e && e.message); st.style.color = '#b4453a'; } }
    }

    async function loadPortal() {
      var me = null; try { me = await MapAuth.currentUser(); } catch (e) {}
      if (!me || !me.id) { pBox.textContent = 'Sign in to list maps in the portal.'; return; }
      var fresh = null;
      try { var rf = await db.from('projects').select('user_id, is_public, raw_config, deleted_at').eq('id', projectId).maybeSingle(); fresh = rf.data; } catch (e) {}
      var entry = null;
      try { var re = await db.from('portal_entries').select('blurb').eq('project_id', projectId).maybeSingle(); entry = re.data; } catch (e) {}
      var own = !!(fresh && fresh.user_id === me.id);
      var pub = !!fresh && !fresh.deleted_at && effectiveVisibility(fresh) === 'public';
      var published = false;
      try { var rs = await db.from('project_snapshots').select('id').eq('project_id', projectId).eq('label', 'published').limit(1); published = !!(rs.data && rs.data.length); } catch (e) {}
      // 8/10 — the old "no Linked or Instance layers" condition is GONE (it blocked the flagship
      // Global Railways map, which is an MPD over raw layers as instances, and a stable dataset_id
      // solves the duplicate-catalogue problem it was standing in for). The condition now is the
      // owner's point 6: every layer of this map must already be a registered dataset. Companions
      // inherit and are skipped. Server-side this is ms_portal_eligible() in datasets-setup.sql.
      var missing = [], checked = false;
      try {
        if (window.MSDatasets) { missing = await MSDatasets.missingForProject(projectId); checked = true; }
      } catch (e) { checked = false; }   // a failed check must never read as "nothing is missing"
      var clean = checked && missing.length === 0;

      if (entry) {
        pBox.innerHTML =
          '<div style="color:#2d7a2d;font-weight:600;">✓ In the portal — <a href="' + portalHref + '" target="_blank" style="color:#7c5cbf;">see the listing</a></div>' +
          (pub ? '' : '<div style="color:#b4453a;margin-top:3px;">⚠ Listed, but hidden right now — visibility is not Public.</div>') +
          '<textarea id="msshare-pblurb" maxlength="300" rows="2" placeholder="Short description shown on the portal card" style="' + PTA + '">' + pEsc(entry.blurb) + '</textarea>' +
          '<div style="display:flex;gap:6px;margin-top:6px;">' +
          '<button id="msshare-psave" style="' + PBTN + '">Save description</button>' +
          '<button id="msshare-premove" style="' + PBTN_RED + '">Remove from portal</button></div>' +
          '<div id="msshare-pstatus" style="font-size:12px;margin-top:6px;min-height:14px;"></div>';
        ov.querySelector('#msshare-psave').addEventListener('click', function () { submitPortal(true); });
        ov.querySelector('#msshare-premove').addEventListener('click', async function () {
          var st = ov.querySelector('#msshare-pstatus'); st.textContent = 'Removing…'; st.style.color = '#6b6680';
          try { var r = await db.from('portal_entries').delete().eq('project_id', projectId); if (r.error) throw new Error(r.error.message); loadPortal(); }
          catch (e) { st.textContent = 'Failed: ' + (e && e.message); st.style.color = '#b4453a'; }
        });
        return;
      }

      var all = own && pub && published && clean;
      pBox.innerHTML =
        pLine(own, 'You own this map') +
        pLine(pub, 'Visibility is Public (set it above)') +
        pLine(published, 'Published at least once') +
        pLine(clean, !checked
          ? 'Dataset check unavailable right now — try again in a moment'
          : (clean ? 'Every layer is a registered dataset'
                   : missing.length + ' layer' + (missing.length === 1 ? '' : 's') + ' not registered as a dataset yet')) +
        ((checked && !clean) ? '<button id="msshare-pdatasets" style="' + PBTN + ';margin-top:6px;">Share info + register…</button>' : '') +
        (all
          ? '<textarea id="msshare-pblurb" maxlength="300" rows="2" placeholder="Short description shown on the portal card" style="' + PTA + '"></textarea>' +
            '<button id="msshare-padd" style="' + PBTN + ';margin-top:6px;">Add to Portal</button>' +
            '<div id="msshare-pstatus" style="font-size:12px;margin-top:6px;min-height:14px;"></div>'
          : '<div style="color:#9a93ad;margin-top:4px;">Fix the ✗ items, then reopen Share.</div>');
      var addBtn = ov.querySelector('#msshare-padd');
      if (addBtn) addBtn.addEventListener('click', function () { submitPortal(false); });
      var dsBtn = ov.querySelector('#msshare-pdatasets');
      if (dsBtn) dsBtn.addEventListener('click', function () {
        if (!window.MSDatasets) return;
        MSDatasets.openBulk(projectId, function () { loadPortal(); });   // re-check when the modal closes
      });
    }
    loadPortal();
  }

  return { open: open, effectiveVisibility: effectiveVisibility, canEdit: canEdit, editAccessOf: editAccessOf };
})();
