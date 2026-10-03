/* msdBadge.js — the MapStructor Dataset mark, in ONE place.
 *
 * WHY THIS FILE EXISTS. Owner 9/29: "We need there to be a clear designation of something as a
 * MapStructor Dataset (MSD). I should see it everywhere an msd is mentioned", and 10/3: "Anywhere
 * it mentions a given MSD, it should have a badge."
 *
 * Seeing it everywhere only works if it is recognisably the SAME thing each time. By the time
 * anyone looked, the dataset page, the catalogue listing and the portal browser had each grown
 * their own hand-written green pill, and the dataset page's was a pale chip identical to "curated"
 * and "read-only copy kept" sitting beside it — so the one mark meant to stand out read as
 * housekeeping. A fourth and fifth copy is how the rest drift apart. One definition, imported.
 *
 * TWO DESIGNATIONS, deliberately distinct:
 *   · MSD          — a DATASET (`datasets.msd`). The data itself is first-party.
 *   · MSD Project  — a MAP (`projects.raw_config.msdProject`), added 10/3 at the owner's ask.
 *     A project page is not a dataset; it is a map built FROM data, and the owner wants to mark
 *     the ones that are ours. It lives in raw_config rather than a new column for the same reason
 *     showcaseSlug does: no migration, and the projects table stays about projects.
 *
 * Self-contained and self-injecting, like datasets.js: include the one <script> and call
 * MSD.badge(). Deleting the file and its script tags removes the feature with nothing left behind.
 */
(function () {
  'use strict';
  if (window.MSD) return;

  /* Where the portal lives, resolved from THIS script's own URL so the link is correct from every
     page the badge appears on — /map/editor.html, /dashboard.html, /portal.html all load
     platform/msdBadge.js, at different relative depths. currentScript is only readable while the
     script first runs, so capture it here, not inside the click handler. */
  var PORTAL_URL = (function () {
    try { return document.currentScript.src.replace(/platform\/msdBadge\.js.*$/, 'portal.html'); }
    catch (e) { return 'portal.html'; }
  })();

  var PILL = 'display:inline-block;padding:1px 7px;border-radius:9px;background:#2d7a2d;' +
             'color:#ffffff;font-weight:700;font-size:10.5px;letter-spacing:.03em;' +
             'vertical-align:1px;white-space:nowrap;font-family:inherit;cursor:pointer;';

  var TITLE = {
    dataset: 'MapStructor Dataset — click to learn what this means.',
    project: 'MapStructor Dataset Project — click to learn what this means.'
  };

  /* The explanation body, the owner's own words (10/3). ONE text for both badges — it explains the
     whole MSD / MapStructor Projects idea, which is what someone wants to understand whichever mark
     they clicked. Split so the last sentence can carry a live link to the portal. */
  var EXPLAIN_TEXT =
    'A MapStructor Dataset (MSD) is an open dataset created through MapStructor Projects, from data ' +
    'users create, or combined from several data sources. They are carefully curated, and users ' +
    'work towards creating accuracy, precision and authority, and are ultimately given a finalized ' +
    'status. You can think of it like a Wikipedia for maps, and created together like OpenStreetMap. ' +
    'The purpose is for people to create datasets that are lacking and are needed or desired in the ' +
    'world today, that are often otherwise difficult to make. Anyone can submit a map for ' +
    'consideration as a MapStructor Project.';

  /* A real element, never an HTML string: these sit next to USER-TYPED names, and the pages that
     render those names build them with textContent precisely so a map called `<script>` cannot
     do anything. Handing them markup to concatenate would undo that. */
  function badge(kind) {
    var k = kind === 'project' ? 'project' : 'dataset';
    var s = document.createElement('span');
    s.className = 'ms-msd-badge';
    s.style.cssText = PILL;
    s.textContent = k === 'project' ? 'MSD PROJECT' : 'MSD';
    s.title = TITLE[k];
    return s;
  }

  /* Is this project designated? Takes the raw_config blob — callers already have it, and reading
     it here means the key is spelled in exactly one place in the codebase. */
  function isProject(rawConfig) {
    return !!(rawConfig && rawConfig.msdProject === true);
  }

  /* Put the mark in front of a name that is already on the page. Returns true if it added one,
     so a caller can tell "not designated" from "I forgot to call this". */
  function mark(el, kind, on) {
    if (!el || !on) return false;
    if (el.querySelector && el.querySelector('.ms-msd-badge')) return true;   // never twice
    el.insertBefore(badge(kind), el.firstChild);
    el.insertBefore(document.createTextNode(' '), el.childNodes[1] || null);
    return true;
  }

  /* ── The mark ON THE MAP ITSELF ────────────────────────────────────────────
   * A map has TWO places its own title can appear, and only one of them is on screen at a time:
   * the header bar's #header-text-value, and — when the header is off — the sidebar's .sb-title.
   * The header is HIDDEN BY DEFAULT (projectLoader: shown only when features.header === true), so
   * the first version of this, which mounted the badge on the header title alone, put the mark on
   * an element that is absent for most maps, including the owner's. It was reported, correctly, as
   * "not seeing the new badge anywhere".
   *
   * So this function owns BOTH surfaces and is idempotent: callers say whether the map is
   * designated and it makes the page match, adding or removing as needed. `syncProject()` re-applies
   * the last known state after something rebuilds the sidebar (the header toggle does exactly that).
   */
  var _isProj = false;
  function titleHosts() {
    var out = [];
    var hv = document.getElementById('header-text-value');
    if (hv && hv.parentNode) out.push({ anchor: hv, parent: hv.parentNode, inline: true });
    var sb = document.querySelector('#sidebar-brand .sb-title');
    // The sidebar title's textContent is rewritten whenever the header toggles, so the badge sits
    // BESIDE it in the centred column, not inside it — otherwise the rewrite would silently eat it.
    if (sb && sb.parentNode) out.push({ anchor: sb, parent: sb.parentNode, inline: false });
    return out;
  }
  function applyProject(on) {
    _isProj = !!on;
    titleHosts().forEach(function (h) {
      var has = h.parent.querySelector(':scope > .ms-msd-badge');
      if (_isProj && !has) {
        var b = badge('project');
        if (h.inline) b.style.marginLeft = '8px';
        else b.style.marginTop = '1px';
        h.parent.insertBefore(b, h.anchor.nextSibling);
      } else if (!_isProj && has) {
        has.remove();
      }
    });
    return _isProj;
  }
  function syncProject() { return applyProject(_isProj); }

  /* ── CLICK THE BADGE, GET THE EXPLANATION (10/3, owner: "Let's make the badge clickable, and
     an explanation pop up"). One DELEGATED listener on the document rather than a handler per
     badge: it covers every badge on every surface — including the dashboard's, which is built
     from the PILL string inside an innerHTML row and so is not an element badge() made — and
     every badge any future surface adds, with nothing to remember to wire up. */
  function explain(kind) {
    var old = document.getElementById('ms-msd-pop'); if (old) old.remove();
    var ov = document.createElement('div');
    ov.id = 'ms-msd-pop';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(30,27,46,.45);z-index:2147483100;' +
      'display:flex;align-items:center;justify-content:center;font-family:"Source Sans Pro",Arial,sans-serif;';
    var card = document.createElement('div');
    card.style.cssText = 'background:#ffffff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.35);' +
      'width:460px;max-width:92vw;padding:20px 22px;color:#1e1b2e;';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:10px;';
    head.appendChild(badge(kind));
    var h = document.createElement('b');
    h.style.cssText = 'font-size:15px;';
    h.textContent = kind === 'project' ? 'MapStructor Dataset Project' : 'MapStructor Dataset';
    head.appendChild(h);
    var x = document.createElement('button');
    x.textContent = '×'; x.title = 'Close';
    x.style.cssText = 'margin-left:auto;border:none;background:none;font-size:20px;line-height:1;cursor:pointer;color:#6b6680;';
    head.appendChild(x);
    card.appendChild(head);
    var body = document.createElement('div');
    body.style.cssText = 'font-size:13px;line-height:1.55;color:#3d3852;';
    body.textContent = EXPLAIN_TEXT;   // textContent, not innerHTML — fixed copy, kept safe by habit
    card.appendChild(body);
    // the portal pointer, on its own line, with a live link
    var see = document.createElement('div');
    see.style.cssText = 'font-size:13px;line-height:1.55;color:#3d3852;margin-top:10px;';
    see.appendChild(document.createTextNode('See MapStructor Projects and MapStructor Datasets in '));
    var link = document.createElement('a');
    link.href = PORTAL_URL;
    link.textContent = 'the portal';
    link.style.cssText = 'color:#7c5cbf;font-weight:700;text-decoration:none;';
    link.addEventListener('mouseenter', function () { link.style.textDecoration = 'underline'; });
    link.addEventListener('mouseleave', function () { link.style.textDecoration = 'none'; });
    see.appendChild(link);
    see.appendChild(document.createTextNode('.'));
    card.appendChild(see);
    ov.appendChild(card);
    function close() { ov.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    x.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    document.body.appendChild(ov);
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('ms-msd-badge')) return;
    e.preventDefault(); e.stopPropagation();   // a badge inside a card-link opens the explanation, not the map
    explain((t.textContent || '').indexOf('PROJECT') >= 0 ? 'project' : 'dataset');
  }, true);

  window.MSD = {
    PILL: PILL, TITLE: TITLE, badge: badge, isProject: isProject, mark: mark,
    applyProject: applyProject, syncProject: syncProject, explain: explain
  };
})();
