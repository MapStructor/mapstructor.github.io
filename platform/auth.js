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
      + '.mapauth-spam{margin:2px 0 12px;font-size:12px;color:#6b6680;}.mapauth-spam summary{cursor:pointer;color:#7c5cbf;}.mapauth-spam p{margin:6px 0 0;line-height:1.4;}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var ov = document.createElement('div'); ov.className = 'mapauth-overlay'; ov.id = 'mapauth-overlay';
    ov.innerHTML = '<div class="mapauth-modal">'
      + '<button class="mapauth-close" type="button" id="mapauth-close">&times;</button>'
      + '<div class="mapauth-tabs"><button class="mapauth-tab" id="mapauth-tab-login" type="button">Log in</button><button class="mapauth-tab" id="mapauth-tab-signup" type="button">Sign up</button></div>'
      + '<form id="mapauth-form">'
      + '<input id="mapauth-email" type="email" placeholder="you@email.com" autocomplete="email" required>'
      + '<input id="mapauth-pw" type="password" placeholder="password (6+ characters)" minlength="6" required>'
      + '<div class="mapauth-spam" id="mapauth-spam" style="display:none;"><details><summary>We will never spam you. Ever.</summary><p>We only contact you when we have to — resetting your password, telling you your storage is full. No newsletters. No promotions. Nothing you didn’t ask for. That’s a promise, not a policy.</p></details></div>'
      + '<button class="mapauth-submit" id="mapauth-submit" type="submit">Log in</button>'
      + '<div class="mapauth-msg" id="mapauth-msg"></div>'
      + '</form></div>';
    document.body.appendChild(ov);
    var mode = 'login';
    function setMode(m) { mode = m; document.getElementById('mapauth-tab-login').classList.toggle('on', m === 'login'); document.getElementById('mapauth-tab-signup').classList.toggle('on', m === 'signup'); document.getElementById('mapauth-submit').textContent = m === 'login' ? 'Log in' : 'Sign up'; document.getElementById('mapauth-spam').style.display = m === 'signup' ? 'block' : 'none'; var msg = document.getElementById('mapauth-msg'); msg.textContent = ''; msg.className = 'mapauth-msg'; }
    function closeM() { ov.classList.remove('open'); }
    ov._setMode = setMode; ov._close = closeM;
    document.getElementById('mapauth-tab-login').onclick = function () { setMode('login'); };
    document.getElementById('mapauth-tab-signup').onclick = function () { setMode('signup'); };
    document.getElementById('mapauth-close').onclick = closeM;
    ov.onclick = function (e) { if (e.target === ov) closeM(); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ov.classList.contains('open')) closeM(); });
    document.getElementById('mapauth-form').onsubmit = async function (e) {
      e.preventDefault();
      var email = document.getElementById('mapauth-email').value.trim(), pw = document.getElementById('mapauth-pw').value, msg = document.getElementById('mapauth-msg'), btn = document.getElementById('mapauth-submit');
      btn.disabled = true; msg.textContent = '…'; msg.className = 'mapauth-msg';
      var res = (mode === 'login') ? await signIn(email, pw) : await signUp(email, pw);
      btn.disabled = false;
      if (res && res.error) { msg.textContent = res.error.message || 'Something went wrong.'; msg.className = 'mapauth-msg err'; return; }
      if (mode === 'signup' && res && res.data && !res.data.session) { msg.textContent = 'Check your email to confirm your account.'; msg.className = 'mapauth-msg ok'; return; }
      msg.textContent = (mode === 'login') ? 'Welcome back.' : 'Account created.'; msg.className = 'mapauth-msg ok';
      setTimeout(closeM, 700);
    };
  }
  function openAuthModal(mode) { ensureAuthModal(); var ov = document.getElementById('mapauth-overlay'); ov._setMode(mode || 'login'); ov.classList.add('open'); setTimeout(function () { var e = document.getElementById('mapauth-email'); if (e) e.focus(); }, 50); }

  window.MapAuth = { db: db, currentUser: currentUser, isReal: isReal, signUp: signUp, signIn: signIn, signOut: signOut, onChange: onChange, openAuthModal: openAuthModal };

  // ── Admin infra alert (7/15): the platform rides Supabase's FREE plan (500 MB database). When
  // total platform data crosses 30%, the ADMIN gets a prominent on-open notice with an Okay button.
  // Okay snoozes it until usage climbs into the NEXT 10% band (40%, 50%, …) or 7 days pass.
  // The email arm is .github/workflows/storage-alert.yml (daily check → GitHub issue → email).
  // Lives in auth.js because every page loads it — the alert follows the admin anywhere on the site.
  (function () {
    var ADMIN_EMAILS = ['nittyjee@gmail.com'];   // same client owner-gate as admin.html / editing.js
    var FREE_DB_BYTES = 500 * 1024 * 1024, THRESHOLD = 0.30, ACK_KEY = 'ms-infra-alert-ack';
    function fmtMB(b) { return (b / (1024 * 1024)).toFixed(0) + ' MB'; }
    async function check() {
      try {
        var u = await currentUser();
        if (!u || !u.email || ADMIN_EMAILS.indexOf(u.email) === -1) return;
        var seam = (location.search.match(/[?&]infratest=(\d+)/) || [])[1];   // test seam (same idiom as ?storagefull=1)
        var r = seam ? { data: FREE_DB_BYTES * (+seam / 100) } : await db.rpc('mapstructor_total_storage');
        if (r.error || typeof r.data !== 'number') return;
        var frac = r.data / FREE_DB_BYTES;
        if (frac < THRESHOLD) return;
        var band = Math.floor(frac * 10) * 10;   // 30, 40, 50, … — each new band re-alerts
        try { var ack = JSON.parse(localStorage.getItem(ACK_KEY) || 'null'); if (ack && ack.band >= band && (Date.now() - ack.t) < 7 * 864e5) return; } catch (e) {}
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(20,18,30,0.55);z-index:6000;display:flex;align-items:center;justify-content:center;font-family:Source Sans Pro,Arial,sans-serif;';
        ov.innerHTML =
          '<div style="width:430px;max-width:92vw;background:#fff;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,0.45);padding:22px 26px;color:#2a2a33;">' +
            '<div style="font-size:19px;font-weight:800;color:' + (frac >= 0.8 ? '#b4453a' : '#c47c00') + ';">⚠ Platform storage at ' + Math.round(frac * 100) + '%</div>' +
            '<p style="margin:10px 0 4px;font-size:14px;line-height:1.5;">MapStructor\'s Supabase free plan holds <b>' + fmtMB(FREE_DB_BYTES) + '</b> of data; the platform is using <b>' + fmtMB(r.data) + '</b>. Plan the infra upgrade before it fills — imports and edits stop working for everyone at 100%.</p>' +
            '<button id="ms-infra-ok" style="margin-top:14px;width:100%;padding:9px 0;border:none;border-radius:8px;background:#7c5cbf;color:#fff;font-size:14px;font-weight:700;cursor:pointer;">Okay</button>' +
          '</div>';
        document.body.appendChild(ov);
        ov.querySelector('#ms-infra-ok').addEventListener('click', function () {
          try { localStorage.setItem(ACK_KEY, JSON.stringify({ band: band, t: Date.now() })); } catch (e) {}
          ov.remove();
        });
      } catch (e) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(check, 1200); });
    else setTimeout(check, 1200);
  })();
})();
