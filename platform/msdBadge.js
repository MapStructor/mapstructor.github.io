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

  var PILL = 'display:inline-block;padding:1px 7px;border-radius:9px;background:#2d7a2d;' +
             'color:#ffffff;font-weight:700;font-size:10.5px;letter-spacing:.03em;' +
             'vertical-align:1px;white-space:nowrap;font-family:inherit;';

  var TITLE = {
    dataset: 'MapStructor Dataset — the first-party designation',
    project: 'MapStructor Dataset Project — a first-party map, designated by MapStructor'
  };

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

  window.MSD = { PILL: PILL, TITLE: TITLE, badge: badge, isProject: isProject, mark: mark };
})();
