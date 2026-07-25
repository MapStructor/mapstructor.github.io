/* viewer-no-auth.test.js — MAU tripwire (2026-07-24).
   Supabase bills monthly-active USERS: any visitor who AUTHENTICATES (sign-in, token refresh —
   anonymous sign-ins count too) becomes an MAU. Public map VIEWING must therefore never touch
   /auth/v1/* for a session-less visitor, or cost tracks total visitors instead of creators.

   This test loads a PUBLISHED map as a cold anonymous visitor (fresh profile, no session),
   exercises the viewer (boot, tiles, timeline, feature list), and FAILS if even one request
   hits the Supabase auth API. Run:  node test/viewer-no-auth/viewer-no-auth.test.js
   (needs puppeteer-core + Chrome; serves the repo root itself). */
const http = require('http'), fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.join(__dirname, '..', '..');
const CH = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MAP_ID = process.env.MAP_ID || 'f914d5e6-7aad-477d-8613-5bd4aac350d5';   // any PUBLISHED public map
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const s = http.createServer((q, r) => {
  let u = decodeURIComponent(q.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html';
  const fp = path.join(ROOT, u);
  fs.stat(fp, (se, st) => {
    if (se || !st.isFile()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Service-Worker-Allowed': '/' });
    fs.createReadStream(fp).pipe(r);
  });
});
const w = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => s.listen(9010, r));
  const b = await puppeteer.launch({ executablePath: CH, headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
  const authCalls = [], restCalls = [];
  p.on('request', rq => {
    const u = rq.url();
    if (/supabase\.co\/auth\/v1\//.test(u)) authCalls.push(rq.method() + ' ' + u.slice(0, 140));
    if (/supabase\.co\/rest\/v1\//.test(u)) restCalls.push(u);
  });
  // COLD visitor: straight to the viewer, no login page, fresh profile = no stored session
  await p.goto('http://localhost:9010/map/index.html?id=' + MAP_ID, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await w(9000); await p.reload({ waitUntil: 'domcontentloaded' });   // second load runs under the tile service worker
  await p.waitForFunction('typeof beforeMap !== "undefined" && beforeMap && beforeMap.loaded && beforeMap.loaded()', { timeout: 120000 }).catch(() => {});
  await w(12000);
  // exercise the viewer a little: timeline + a feature-list open if present
  await p.evaluate(() => { try { jQuery('#slider').slider('value', jQuery('#slider').slider('option', 'min') + 1e9); if (typeof changeDate === 'function') changeDate(jQuery('#slider').slider('value')); } catch (e) {} });
  await w(2500);
  await p.evaluate(() => { const t = document.querySelector('.attr-table-btn'); if (t) t.click(); });
  await w(5000);
  await b.close(); s.close();
  const pass = authCalls.length === 0;
  console.log(JSON.stringify({ PASS: pass, authCalls: authCalls, restCallCount: restCalls.length }, null, 1));
  if (!pass) { console.error('FAIL: the viewer path called Supabase AUTH for an anonymous visitor — every visitor would count as a billable MAU.'); process.exit(1); }
  console.log('OK: zero auth calls — anonymous viewers cost no MAU.');
})();
