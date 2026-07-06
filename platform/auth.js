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

  async function currentUser() {
    if (!db) return null;
    try { var r = await db.auth.getUser(); return (r && r.data && r.data.user) || null; }
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
})();
