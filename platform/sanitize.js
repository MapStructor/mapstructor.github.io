// sanitize.js — MSSanitize(html): tiny allowlist-leaning cleaner for user-authored rich text that OTHER
// people will see (public profiles). Strips active-content elements, every on* handler attribute, and
// javascript:/data:/vbscript: URLs in href/src. Profile HTML is the only cross-user HTML surface today —
// if more appear (map descriptions etc.), run them through this too.
(function () {
  var BAD_TAGS = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, FORM: 1, LINK: 1, META: 1, BASE: 1 };
  window.MSSanitize = function (html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html == null ? '' : html);
    (function walk(node) {
      var kids = Array.prototype.slice.call(node.children || []);
      kids.forEach(function (el) {
        if (BAD_TAGS[el.tagName]) { el.parentNode.removeChild(el); return; }
        Array.prototype.slice.call(el.attributes).forEach(function (a) {
          var n = a.name.toLowerCase(), v = String(a.value || '');
          if (n.indexOf('on') === 0) el.removeAttribute(a.name);
          else if ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*(javascript|data|vbscript):/i.test(v)) el.removeAttribute(a.name);
        });
        walk(el);
      });
    })(tpl.content);
    return tpl.innerHTML;
  };
})();
