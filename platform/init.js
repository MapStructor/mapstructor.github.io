/* init.js — sets the browser tab title to the map's name. That is its whole job.
 *
 * IT USED TO LOAD A SECOND COPY OF SUPABASE-JS TO DO IT (found 8/22). Twenty-nine lines that
 * injected the library again, built a third client, and ran one query for one string. Three
 * consequences, in rising order of how long they would have taken to find:
 *
 *  1. An extra library download and a third auth manager on every editor boot — two token-refresh
 *     timers running against one session.
 *  2. An extra `projects?select=id,name` read, one of the nine reads of that row per boot.
 *  3. The one that cost an hour: its `onload` REPLACED `window.supabase` with a fresh namespace,
 *     so the read-dedupe that auth.js installs on `createClient` was silently discarded for every
 *     client built afterwards. The wrapper installed correctly, reported success, and then the
 *     object it had patched was thrown away. Nothing errored; the dedupe simply had no effect, and
 *     the request count did not move.
 *
 * That third one is the whole family in one place: two owners of `window.supabase`, and the second
 * one wins by arriving later. It was only findable by comparing object identity before and after —
 * every other signal said the patch had worked, because it had.
 *
 * Now it waits for the client the page already has. No second library, no second client, and the
 * title still gets set. If no client ever appears the title is left alone, which is the right
 * failure for something cosmetic.
 */
(function () {
  var TRIES = 100, EVERY = 50;   // ~5s, then give up quietly

  function existingDb() {
    if (window.MapAuth && window.MapAuth.db) return window.MapAuth.db;
    return null;
  }

  function whenReady(cb, n) {
    var db = existingDb();
    if (db) return cb(db);
    if ((n || 0) >= TRIES) {
      // Cosmetic-only, so this is a note rather than a warning. Saying nothing at all is how the
      // last silent failure here lasted as long as it did.
      try { console.info('[MapStructor] init: no shared Supabase client appeared; leaving the tab title alone.'); } catch (e) {}
      return;
    }
    setTimeout(function () { whenReady(cb, (n || 0) + 1); }, EVERY);
  }

  async function run(db) {
    var projectId = new URLSearchParams(window.location.search).get('id');
    if (!projectId) return;
    try {
      // MSBoot (8/25): configLoader already fetched this whole row — share the RESULT inside the
      // boot window instead of re-asking for two of its columns.
      var mb = window.MSBoot;
      var r = (mb && mb.pid === projectId && Date.now() < mb.until)
        ? await mb.project
        : await db.from('projects').select('id, name').eq('id', projectId).single();
      if (r.error || !r.data) return;
      // projectLoader owns the on-page header name — for the viewer that is the PUBLISHED name, so
      // setting the header here would leak the live name onto a published view. Tab title only.
      document.title = r.data.name;
    } catch (e) {}
  }

  whenReady(run);
})();
