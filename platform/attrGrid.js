// MSAttrWindow v3 — FIXED-VIEWPORT windowed table ("Excel model", 7/18).
//
// v1/v2 let the browser natively scroll a 2.5-million-pixel table and re-rendered the window
// to keep up. Two unfixable problems: (a) the compositor scrolls AHEAD of JS, so anything not
// pre-painted shows WHITE (per-cell sticky-left pinned cells were slowest, but scrollbar-thumb
// drags teleport ~2,600 content px per thumb px — no buffer can ever cover that); (b) rebuilds
// landing mid-frame = jitter.
//
// v3 inverts the model: THE TABLE NEVER SCROLLS VERTICALLY. It sits fixed in the panel and
// JS decides WHICH rows render (quantized to row boundaries, like Excel/AG-Grid):
//   - two-finger / wheel scrolling: wheel events accumulate into a row offset,
//   - scrollbar: a slim REAL scrollbar (empty tall div) whose scroll position maps to the row
//     offset — the compositor only ever scrolls emptiness, so there is nothing to outrun.
// Renders are recycled (only rows entering/leaving change; a teleport rebuilds just one
// screenful ≈ 3ms) — white and jitter are structurally impossible, at any speed, any input.
//
// The DATA seam is unchanged: rows are the caller's array; "give me rows N..M" can later be
// served by a paged/columnar (Parquet+DuckDB) provider without touching this class.
// Contract: uniform row height (self-measured); events DELEGATED on tbody; horizontal
// scrolling stays NATIVE on scrollEl (only overflow-y is taken over).
(function () {
  function MSAttrWindow(opts) {
    this.scrollEl = opts.scrollEl;              // container: keeps native X scroll; Y is ours
    this.tbody = opts.tbody;
    this.renderRow = opts.renderRow;            // (row, index) -> "<tr…>…</tr>"
    this.colCount = opts.colCount || function () { return 1; };
    this.rowH = opts.rowH || 30;                // estimate until measured
    this.rows = [];
    this._row = 0;                              // FIRST visible row index (the single source of truth)
    this._start = -1; this._end = -1;           // row range currently in the DOM
    this._measured = false;
    this._syncingBar = false;
    var self = this;

    this.scrollEl.style.overflowY = 'hidden';   // vertical scrolling is ours now

    // slim real scrollbar: an absolutely-positioned scrolling div holding only an empty
    // height. Native thumb feel, keyboard/page clicks, and the compositor scrolls nothing.
    var host = this.scrollEl.parentNode;
    this.vbar = document.createElement('div');
    this.vbar.className = 'ms-attr-vbar';
    this.vbar.style.cssText = 'position:absolute;right:0;width:14px;overflow-y:scroll;overflow-x:hidden;z-index:8;background:transparent;';
    this.vbar.innerHTML = '<div style="width:1px;"></div>';
    host.appendChild(this.vbar);
    this._onBar = function () {
      if (self._syncingBar) { self._syncingBar = false; return; }
      var range = self.vbar.scrollHeight - self.vbar.clientHeight;
      var maxRow = Math.max(0, self.rows.length - self._visRows());
      self._row = range > 0 ? Math.round(self.vbar.scrollTop / range * maxRow) : 0;
      self._render();
    };
    this.vbar.addEventListener('scroll', this._onBar, { passive: true });

    // wheel / trackpad: consume Y (rows), keep X native by applying it ourselves
    this._acc = 0;
    this._onWheel = function (e) {
      var dy = e.deltaY, dx = e.deltaX;
      if (e.deltaMode === 1) { dy *= self.rowH; dx *= self.rowH; }   // line-mode mice
      if (Math.abs(dy) > Math.abs(dx)) {
        e.preventDefault();
        self._acc += dy;
        var step = Math.trunc(self._acc / self.rowH);
        if (step !== 0) {
          self._acc -= step * self.rowH;
          self._setRow(self._row + step);
        }
      } else if (dx) { e.preventDefault(); self.scrollEl.scrollLeft += dx; }
    };
    this.scrollEl.addEventListener('wheel', this._onWheel, { passive: false });

    // panel resizes (drag handles) → re-place the bar and refill the taller/shorter viewport
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self._layout(); self._start = -1; self._render(); });
      this._ro.observe(this.scrollEl);
    }
  }

  MSAttrWindow.prototype._visRows = function () {
    var headH = 0;
    try { headH = this.tbody.parentNode.tHead ? this.tbody.parentNode.tHead.offsetHeight : 0; } catch (e) {}
    return Math.max(1, Math.ceil(((this.scrollEl.clientHeight || 400) - headH) / this.rowH));
  };

  MSAttrWindow.prototype._setRow = function (r) {
    var maxRow = Math.max(0, this.rows.length - this._visRows());
    this._row = Math.max(0, Math.min(maxRow, r));
    this._syncBar();
    this._render();
  };

  MSAttrWindow.prototype._syncBar = function () {
    var maxRow = Math.max(0, this.rows.length - this._visRows());
    var range = this.vbar.scrollHeight - this.vbar.clientHeight;
    if (range > 0 && maxRow > 0) {
      this._syncingBar = true;
      this.vbar.scrollTop = this._row / maxRow * range;
    }
  };

  // size + place the vbar and its virtual height (compressed: the bar maps RATIO → row, so it
  // never needs millions of pixels — big thumb, precise control)
  MSAttrWindow.prototype._layout = function () {
    var se = this.scrollEl;
    this.vbar.style.top = se.offsetTop + 'px';
    this.vbar.style.height = se.clientHeight + 'px';
    var virt = Math.min(Math.max(this.rows.length * this.rowH, se.clientHeight + 1), 400000);
    this.vbar.firstElementChild.style.height = virt + 'px';
    var need = this.rows.length > this._visRows();
    this.vbar.style.display = need ? '' : 'none';
  };

  MSAttrWindow.prototype.setRows = function (rows, keepScroll) {
    this.rows = rows || [];
    if (!keepScroll) this._row = 0;
    var maxRow = Math.max(0, this.rows.length - this._visRows());
    if (this._row > maxRow) this._row = maxRow;
    this._layout();
    this._syncBar();
    this._start = -1; this._end = -1;
    this._render();
  };

  MSAttrWindow.prototype._render = function () {
    // never swap rows under a focused cell input (removal isn't blur — typing would vanish)
    var ae = document.activeElement;
    if (ae && ae.tagName === 'INPUT' && this.tbody.contains(ae)) return;
    var n = this.rows.length;
    var start = Math.min(this._row, Math.max(0, n - this._visRows()));
    var end = Math.min(n, start + this._visRows() + 1);   // +1: partial last row fills the clip
    if (start === this._start && end === this._end) return;
    var t = this.tbody, el;
    // stray content (e.g. an external "Loading…" row) → clean rebuild
    if (this._start < 0 || start >= this._end || end <= this._start || t.children.length !== (this._end - this._start)) {
      var all = '';
      for (var i = start; i < end; i++) all += this.renderRow(this.rows[i], i);
      t.innerHTML = all;
    } else {
      var oldStart = this._start, oldEnd = this._end;
      while (oldStart < start && t.firstElementChild) { t.removeChild(t.firstElementChild); oldStart++; }
      while (oldEnd > end && t.lastElementChild) { t.removeChild(t.lastElementChild); oldEnd--; }
      if (start < oldStart) { var hT = ''; for (var a = start; a < oldStart; a++) hT += this.renderRow(this.rows[a], a); t.insertAdjacentHTML('afterbegin', hT); }
      if (end > oldEnd) { var hB = ''; for (var b = oldEnd; b < end; b++) hB += this.renderRow(this.rows[b], b); t.insertAdjacentHTML('beforeend', hB); }
    }
    this._start = start; this._end = end;
    // VIRTUAL row sets (big-data tier): rows may be a sparse array — undefined entries render
    // as the caller's placeholder; tell the provider which range to fetch, it re-renders on arrival
    if (this.onMissing) {
      for (var m = start; m < end; m++) if (this.rows[m] === undefined) { this.onMissing(start, end); break; }
    }
    if (!this._measured) {
      var tr = t.querySelector('tr[data-fid]');
      if (tr && tr.offsetHeight) {
        this._measured = true;
        if (Math.abs(tr.offsetHeight - this.rowH) > 0.5) {
          this.rowH = tr.offsetHeight;
          this._layout();
          this._start = -1; this._render();
        }
      }
    }
  };

  // legacy alias (v1/v2 API) — a plain re-render at the current position
  MSAttrWindow.prototype.update = function () { this._start = -1; this._end = -1; this._render(); };

  MSAttrWindow.prototype.scrollToIndex = function (idx) {
    if (idx < 0 || idx >= this.rows.length) return;
    this._setRow(idx - Math.floor(this._visRows() / 2));
  };

  MSAttrWindow.prototype.destroy = function () {
    if (this._ro) this._ro.disconnect();
    this.scrollEl.removeEventListener('wheel', this._onWheel);
    this.vbar.removeEventListener('scroll', this._onBar);
    if (this.vbar.parentNode) this.vbar.parentNode.removeChild(this.vbar);
    this.rows = [];
  };

  window.MSAttrWindow = MSAttrWindow;
})();
