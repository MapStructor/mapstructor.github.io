/* auth.js — shared Supabase auth for MapStructor (front page, editor, dashboard).
   Anonymous-first (dev plan Step 6): a visitor can use the app with an anonymous session;
   signing up UPGRADES that anonymous user in place (auth.updateUser) so their work — same
   user_id, same rows — is never lost. A fresh visitor with no session just signs up normally.
   Exposes window.MapAuth (+ MapAuth.db = the single Supabase client for the page). */
(function () {
  var SUPABASE_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';
  var db = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

  // LOCAL-first: getSession() reads the persisted session (instant, no network) — getUser() made a
  // server round-trip on EVERY call, so every widget (top-bar chip, save callout, create button)
  // visibly waited on the network before painting. Writes still validate server-side via RLS.
  async function currentUser() {
    if (!db) return null;
    try { var s = await db.auth.getSession(); return (s && s.data && s.data.session && s.data.session.user) || null; }
    catch (e) { return null; }
  }
  // A "real" (claimed) account = signed in, not anonymous, has an email.
  function isReal(u) { return !!(u && u.is_anonymous === false && u.email); }

  // Sign up, OR upgrade the current anonymous session in place (keeps user_id + all data).
  // Returns { data, error }. With email confirmation ON, the account isn't usable until confirmed
  // (data.session is null) — callers should surface "check your email".
  async function signUp(email, password) {
    if (!db) return { error: { message: 'Auth unavailable.' } };
    var u = await currentUser();
    if (u && u.is_anonymous) {
      return await db.auth.updateUser({ email: email, password: password });   // claim the anon user
    }
    return await db.auth.signUp({ email: email, password: password });
  }
  async function signIn(email, password) {
    if (!db) return { error: { message: 'Auth unavailable.' } };
    return await db.auth.signInWithPassword({ email: email, password: password });
  }
  async function signOut() { if (db) return await db.auth.signOut(); }

  // ── Password recovery (added 8/22) ──────────────────────────────────────────────────────────
  // There was none. Not a broken flow — NO flow: `resetPasswordForEmail` appeared nowhere in the
  // repository, and neither did the word "forgot". A person who forgot their password was locked
  // out of every map they had made, permanently, with no path back. Found by surveying auth as a
  // surface rather than chasing a report, which is the only way a MISSING thing gets found: there
  // is no bug report for a button that was never there.
  //
  // The sign-up modal has promised this in writing the whole time — "We only contact you when we
  // have to — resetting your password, telling you your storage is full." The copy described a
  // feature that did not exist.
  //
  // Supabase's recovery link returns the visitor to `redirectTo` with a recovery session already
  // established, and fires PASSWORD_RECOVERY. So the flow is: ask for the email → they click the
  // link → they land back here signed in for one purpose → set a new password.
  var RECOVER_URL = location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html?recover=1";
  async function resetPassword(email) {
    if (!db) return { error: { message: "Auth unavailable." } };
    return await db.auth.resetPasswordForEmail(email, { redirectTo: RECOVER_URL });
  }
  async function setNewPassword(password) {
    if (!db) return { error: { message: "Auth unavailable." } };
    return await db.auth.updateUser({ password: password });
  }

  // Bounced-from-a-gated-page flow (7/28): a gated page (dashboard) with no session redirects to
  // index.html?login=1&next=<page> — the front page auto-opens the login modal and returns to the
  // page after login, so the visit's intent survives the bounce. `next` is allow-listed to a bare
  // site page name (no slashes/protocols) so it can never become an open redirect.
  function bounceNext() {
    var m = location.search.match(/[?&]next=([A-Za-z0-9_.-]+)/);
    return (m && /^[A-Za-z0-9_-]+\.html$/.test(m[1])) ? m[1] : null;
  }

  // Fires the callback with the current user (or null) on every auth change.
  function onChange(cb) { if (db) db.auth.onAuthStateChange(function (_e, s) { cb(s && s.user ? s.user : null); }); }

  // ── Shared login / signup modal (one implementation, used on every page) ──
  function ensureAuthModal() {
    if (document.getElementById('mapauth-overlay')) return;
    var css = '.mapauth-overlay{display:none;position:fixed;inset:0;background:rgba(20,16,40,.55);z-index:99999;align-items:center;justify-content:center;}'
      + '.mapauth-overlay.open{display:flex;}'
      + '.mapauth-modal{background:#fff;border-radius:14px;width:340px;max-width:92vw;padding:26px 24px 22px;box-shadow:0 18px 50px rgba(0,0,0,.3);position:relative;font-family:Source Sans Pro,system-ui,Arial,sans-serif;color:#1e1b2e;}'
      + '.mapauth-modal *{box-sizing:border-box;}'
      + '.mapauth-close{position:absolute;top:10px;right:12px;border:none;background:none;font-size:22px;color:#9b8ec4;cursor:pointer;line-height:1;}'
      + '.mapauth-tabs{display:flex;gap:6px;margin-bottom:16px;}'
      + '.mapauth-tab{flex:1;padding:8px 0;border:1px solid rgba(124,92,191,.3);border-radius:8px;background:rgba(255,255,255,.6);color:#1e1b2e;font-weight:600;font-size:14px;cursor:pointer;}'
      + '.mapauth-tab.on{background:#7c5cbf;color:#fff;border-color:#7c5cbf;}'
      + '.mapauth-modal input{width:100%;margin-bottom:10px;padding:10px 12px;border:1px solid #cdc6e0;border-radius:8px;font-size:14px;}'
      + '.mapauth-submit{width:100%;padding:11px 0;border:none;border-radius:8px;background:#7c5cbf;color:#fff;font-weight:700;font-size:15px;cursor:pointer;}'
      + '.mapauth-submit:disabled{opacity:.6;cursor:default;}'
      + '.mapauth-msg{margin-top:10px;font-size:13px;min-height:18px;}.mapauth-msg.err{color:#b4453a;}.mapauth-msg.ok{color:#2d7a2d;}'
      + '.mapauth-spam{margin:2px 0 12px;font-size:12px;color:#6b6680;}.mapauth-spam summary{cursor:pointer;color:#7c5cbf;}.mapauth-spam p{margin:6px 0 0;line-height:1.4;}'
      + '.mapauth-link{display:block;margin:10px auto 0;border:none;background:none;padding:0;font-size:13px;color:#7c5cbf;cursor:pointer;text-decoration:underline;font-family:inherit;}'
      + '.mapauth-note{margin:-2px 0 12px;font-size:12.5px;color:#6b6680;line-height:1.45;}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var ov = document.createElement('div'); ov.className = 'mapauth-overlay'; ov.id = 'mapauth-overlay';
    ov.innerHTML = '<div class="mapauth-modal">'
      + '<button class="mapauth-close" type="button" id="mapauth-close">&times;</button>'
      + '<div class="mapauth-tabs"><button class="mapauth-tab" id="mapauth-tab-login" type="button">Log in</button><button class="mapauth-tab" id="mapauth-tab-signup" type="button">Sign up</button></div>'
      + '<form id="mapauth-form">'
      + '<input id="mapauth-email" type="email" placeholder="you@email.com" autocomplete="email" required>'
      + '<div class="mapauth-note" id="mapauth-note" style="display:none;"></div>'
      + '<input id="mapauth-pw" type="password" placeholder="password (6+ characters)" minlength="6" required>'
      + '<div class="mapauth-spam" id="mapauth-spam" style="display:none;"><details><summary>We will never spam you. Ever.</summary><p>We only contact you when we have to — resetting your password, telling you your storage is full. No newsletters. No promotions. Nothing you didn’t ask for. That’s a promise, not a policy.</p></details></div>'
      + '<button class="mapauth-submit" id="mapauth-submit" type="submit">Log in</button>'
      + '<div class="mapauth-msg" id="mapauth-msg"></div>'
      + '<button type="button" class="mapauth-link" id="mapauth-forgot">Forgot your password?</button>'
      + '<button type="button" class="mapauth-link" id="mapauth-back" style="display:none;">Back to log in</button>'
      + '</form></div>';
    document.body.appendChild(ov);
    var mode = 'login';
    // Four modes now. `reset` asks for an email only; `newpw` asks for a password only — the two
    // halves of recovery. Each mode says which fields exist rather than each field asking which
    // mode it is in, so adding the third and fourth did not touch the submit handler's structure.
    var LABEL = { login: 'Log in', signup: 'Sign up', reset: 'Email me a reset link', newpw: 'Set new password' };
    function setMode(m) {
      mode = m;
      var isRecovery = (m === 'reset' || m === 'newpw');
      document.getElementById('mapauth-tab-login').classList.toggle('on', m === 'login');
      document.getElementById('mapauth-tab-signup').classList.toggle('on', m === 'signup');
      document.querySelector('.mapauth-tabs').style.display = isRecovery ? 'none' : 'flex';
      document.getElementById('mapauth-submit').textContent = LABEL[m] || 'Log in';
      document.getElementById('mapauth-spam').style.display = m === 'signup' ? 'block' : 'none';
      // password field is pointless when we are emailing a link; email field is pointless when the
      // recovery session already knows who they are
      var em = document.getElementById('mapauth-email'), pw = document.getElementById('mapauth-pw');
      em.style.display = (m === 'newpw') ? 'none' : ''; em.required = (m !== 'newpw');
      pw.style.display = (m === 'reset') ? 'none' : ''; pw.required = (m !== 'reset');
      pw.placeholder = (m === 'newpw') ? 'new password (6+ characters)' : 'password (6+ characters)';
      var note = document.getElementById('mapauth-note');
      note.style.display = isRecovery ? 'block' : 'none';
      note.textContent = (m === 'reset')
        ? 'Enter the email you signed up with and we will send you a link to set a new password.'
        : (m === 'newpw' ? 'Choose a new password. You are signed in from the link in your email.' : '');
      document.getElementById('mapauth-forgot').style.display = (m === 'login') ? 'block' : 'none';
      document.getElementById('mapauth-back').style.display = (m === 'reset') ? 'block' : 'none';
      var msg = document.getElementById('mapauth-msg'); msg.textContent = ''; msg.className = 'mapauth-msg';
    }
    function closeM() { ov.classList.remove('open'); }
    ov._setMode = setMode; ov._close = closeM;
    document.getElementById('mapauth-tab-login').onclick = function () { setMode('login'); };
    document.getElementById('mapauth-tab-signup').onclick = function () { setMode('signup'); };
    document.getElementById('mapauth-close').onclick = closeM;
    document.getElementById('mapauth-forgot').onclick = function () { setMode('reset'); };
    document.getElementById('mapauth-back').onclick = function () { setMode('login'); };
    ov.onclick = function (e) { if (e.target === ov) closeM(); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('open')) closeM(); });
    document.getElementById('mapauth-form').onsubmit = async function (e) {
      e.preventDefault();
      var email = document.getElementById('mapauth-email').value.trim(), pw = document.getElementById('mapauth-pw').value, msg = document.getElementById('mapauth-msg'), btn = document.getElementById('mapauth-submit');
      btn.disabled = true; msg.textContent = '…'; msg.className = 'mapauth-msg';
      var res = (mode === 'login') ? await signIn(email, pw)
              : (mode === 'reset') ? await resetPassword(email)
              : (mode === 'newpw') ? await setNewPassword(pw)
              : await signUp(email, pw);
      btn.disabled = false;
      if (res && res.error) { msg.textContent = res.error.message || 'Something went wrong.'; msg.className = 'mapauth-msg err'; return; }
      // Deliberately the SAME answer whether or not that email has an account: telling a stranger
      // which addresses are registered is an account-enumeration gift, and it costs the real user
      // nothing to read "if there is an account".
      if (mode === 'reset') {
        msg.textContent = 'If there is an account for that email, a reset link is on its way.';
        msg.className = 'mapauth-msg ok'; return;
      }
      if (mode === 'newpw') {
        msg.textContent = 'Password changed. You are signed in.';
        msg.className = 'mapauth-msg ok'; setTimeout(closeM, 900);
        // strip ?recover=1 so a refresh does not re-open the set-password step over a session that
        // is now an ordinary one
        try { history.replaceState({}, '', location.pathname); } catch (e) {}
        return;
      }
      if (mode === 'signup' && res && res.data && !res.data.session) { msg.textContent = 'Check your email to confirm your account.'; msg.className = 'mapauth-msg ok'; return; }
      msg.textContent = (mode === 'login') ? 'Welcome back.' : 'Account created.'; msg.className = 'mapauth-msg ok';
      setTimeout(closeM, 700);
      // came here via a gated-page bounce → carry on to where they were headed (login, or a signup
      // that produced a session — anon upgrade / confirmations off)
      var nx = bounceNext();
      if (nx && (mode === 'login' || (res && res.data && res.data.session))) setTimeout(function () { location.href = nx; }, 750);
    };
  }
  function openAuthModal(mode) { ensureAuthModal(); var ov = document.getElementById('mapauth-overlay'); ov._setMode(mode || 'login'); ov.classList.add('open'); setTimeout(function () { var e = document.getElementById('mapauth-email'); if (e) e.focus(); }, 50); }

  // Catch the click-through from a recovery email and finish the job. Two triggers on purpose,
  // because either one alone has a hole: PASSWORD_RECOVERY is the event Supabase actually fires,
  // but it can land BEFORE this listener is attached on a slow page; `?recover=1` is our own marker
  // on the redirect and survives that race. Whichever arrives first opens the step, and `opened`
  // stops the second one re-opening it over a finished flow.
  // auth.js is loaded from <head> on every page, so at this point `document.body` IS NULL and
  // ensureAuthModal's appendChild throws — which it did, silently swallowing the whole recovery
  // landing: ?recover=1 produced no modal, no message, nothing. Family E in the file where I had
  // just finished counting family E. Everything that touches the DOM waits for a body.
  function whenBody(fn) {
    if (document.body) return fn();
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  }
  var recoveryOpened = false;
  function openRecovery() {
    if (recoveryOpened) return;
    recoveryOpened = true;
    whenBody(function () { openAuthModal('newpw'); });
  }
  if (db) {
    db.auth.onAuthStateChange(function (e) { if (e === 'PASSWORD_RECOVERY') openRecovery(); });
    if (/[?&]recover=1/.test(location.search)) {
      // only if the link really signed them in — landing on ?recover=1 with no session means the
      // link expired or was already used, and showing a password box that cannot work is worse
      // than saying so.
      currentUser().then(function (u) {
        if (u) return openRecovery();
        whenBody(function () {
          openAuthModal('reset');
          var m = document.getElementById('mapauth-msg');
          if (m) { m.textContent = 'That reset link has expired or was already used. Send a new one.'; m.className = 'mapauth-msg err'; }
        });
      });
    }
  }

  window.MapAuth = { db: db, currentUser: currentUser, isReal: isReal, signUp: signUp, signIn: signIn, signOut: signOut, onChange: onChange, openAuthModal: openAuthModal, resetPassword: resetPassword, setNewPassword: setNewPassword };

  // ?login=1 (the gated-page bounce above): pop the login modal on arrival — or, if a session
  // already exists, skip straight back to the page the visitor was headed to.
  if (/[?&]login=1/.test(location.search)) {
    (function () {
      var nx = bounceNext();
      Promise.resolve(currentUser()).then(function (u) {
        if (isReal(u)) { if (nx) location.replace(nx); return; }
        var open = function () { openAuthModal('login'); };
        if (document.body) open(); else document.addEventListener('DOMContentLoaded', open);
      }).catch(function () {});
    })();
  }

  // ── Platform storage guard (7/15, rethresholded 7/23): the platform rides Supabase PRO (8 GB
  // database; the spend cap keeps that hard). Policy (user 7/23): stay under 50% in general —
  // the ADMIN gets an on-open alert from 50%; at 80% the whole site goes EDIT-LOCKDOWN for
  // everyone (window.__msStorageLockdown — the editor refuses to boot into editing) until space
  // is cleared. Okay snoozes the alert until usage climbs into the NEXT 10% band or 7 days pass.
  // The email arm is .github/workflows/storage-alert.yml (daily check → GitHub issue → email).
  // Lives in auth.js because every page loads it — the alert follows the admin anywhere on the site.
  (function () {
    var ADMIN_EMAILS = ['nittyjee@gmail.com'];   // same client owner-gate as admin.html / editing.js
    var PLAN_DB_BYTES = 8 * 1024 * 1024 * 1024, ALERT_AT = 0.50, LOCKDOWN_AT = 0.80, ACK_KEY = 'ms-infra-alert-ack';
    window.MSStorageGuard = { planBytes: PLAN_DB_BYTES, alertAt: ALERT_AT, lockdownAt: LOCKDOWN_AT, frac: null, ready: null };
    function fmtGB(b) { return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB'; }
    async function check() {
      try {
        var seam = (location.search.match(/[?&]infratest=(\d+)/) || [])[1];   // test seam (same idiom as ?storagefull=1)
        var r = seam ? { data: PLAN_DB_BYTES * (+seam / 100) } : await db.rpc('mapstructor_total_storage');
        if (r.error || typeof r.data !== 'number') return;
        var frac = r.data / PLAN_DB_BYTES;
        window.MSStorageGuard.frac = frac;
        // 80%+: site-wide edit lockdown flag — EVERYONE (admin included; the point is protecting
        // the platform). editing.js checks this at boot and refuses to wire editing.
        if (frac >= LOCKDOWN_AT) window.__msStorageLockdown = { frac: frac, used: r.data, plan: PLAN_DB_BYTES };
        // the on-open alert stays admin-only
        var u = await currentUser();
        if (!u || !u.email || ADMIN_EMAILS.indexOf(u.email) === -1) return;
        if (frac < ALERT_AT) return;
        var band = Math.floor(frac * 10) * 10;   // 50, 60, 70, … — each new band re-alerts
        var hard = frac >= LOCKDOWN_AT;
        if (!hard) { try { var ack = JSON.parse(localStorage.getItem(ACK_KEY) || 'null'); if (ack && ack.band >= band && (Date.now() - ack.t) < 7 * 864e5) return; } catch (e) {} }
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(20,18,30,0.55);z-index:6000;display:flex;align-items:center;justify-content:center;font-family:Source Sans Pro,Arial,sans-serif;';
        ov.innerHTML =
          '<div style="width:460px;max-width:92vw;background:#fff;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,0.45);padding:22px 26px;color:#2a2a33;">' +
            '<div style="font-size:19px;font-weight:800;color:' + (hard ? '#b4453a' : '#c47c00') + ';">⚠ Platform storage at ' + Math.round(frac * 100) + '%</div>' +
            '<p style="margin:10px 0 4px;font-size:14px;line-height:1.5;">The Supabase Pro database holds <b>' + fmtGB(PLAN_DB_BYTES) + '</b>; the platform is using <b>' + fmtGB(r.data) + '</b>. Policy: stay under 50%.' +
            (hard ? ' <b>Editing is now locked down site-wide (80% rule)</b> until space is cleared.' : '') + '</p>' +
            '<p style="margin:8px 0 0;font-size:13px;line-height:1.5;color:#555;">To clear space: delete unwanted maps/copies (Dashboard), sweep orphan datasets (<a href="/manage-datasets.html" style="color:#7c5cbf;">Manage datasets</a>), then run <code>VACUUM FULL;</code> in the Supabase SQL editor — deletes don\'t shrink the database until the vacuum runs.</p>' +
            '<button id="ms-infra-ok" style="margin-top:14px;width:100%;padding:9px 0;border:none;border-radius:8px;background:#7c5cbf;color:#fff;font-size:14px;font-weight:700;cursor:pointer;">Okay</button>' +
          '</div>';
        document.body.appendChild(ov);
        ov.querySelector('#ms-infra-ok').addEventListener('click', function () {
          try { localStorage.setItem(ACK_KEY, JSON.stringify({ band: band, t: Date.now() })); } catch (e) {}
          ov.remove();
        });
      } catch (e) {}
    }
    var p; if (document.readyState === 'loading') { p = new Promise(function (res) { document.addEventListener('DOMContentLoaded', function () { setTimeout(function () { res(check()); }, 1200); }); }); }   // cliff-ok: settle time before reading the storage figure; a miss costs a warning banner, never data
    else { p = new Promise(function (res) { setTimeout(function () { res(check()); }, 1200); }); }   // cliff-ok: the same settle time on the already-loaded path
    window.MSStorageGuard.ready = p;
  })();
})();
