/* Compatibility + error reporting, loaded first.
   - Photoshop's panel engine (UXP) may lack TextEncoder/TextDecoder: tiny
     UTF-8 versions are added when missing.
   - Any uncaught error is shown at the bottom of the panel, so a problem
     inside Photoshop shows a message you can screenshot instead of doing
     nothing. */
(function () {
  'use strict';
  var g = typeof globalThis !== 'undefined' ? globalThis : window;
  if (typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = function () {};
    g.TextEncoder.prototype.encode = function (str) {
      var s = unescape(encodeURIComponent(String(str)));
      var out = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    };
  }
  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = function () {};
    g.TextDecoder.prototype.decode = function (buf) {
      var a = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);
      var s = '';
      for (var i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
      try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
    };
  }
  function show(msg) {
    try {
      var el = document.getElementById('status');
      if (el) { el.textContent = 'Problem: ' + msg + ' (send a screenshot of this to get it fixed)'; el.className = 'status small err'; }
      if (g.console) console.error(msg);
    } catch (e) { /* nothing else to do */ }
  }
  g.addEventListener && g.addEventListener('error', function (e) { show((e && (e.message || (e.error && e.error.message))) || 'unknown error'); });
  g.addEventListener && g.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; show((r && (r.message || String(r))) || 'unknown error'); });
  g.EckoShowError = show;
})();
