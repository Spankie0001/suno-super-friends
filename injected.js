// injected.js — runs in the page's main world (not the content script isolated world).
// Loaded as <script src="..."> from the extension's web_accessible_resources.
// Bypasses Suno's strict-inline CSP since chrome-extension:// scripts are allowed.

(() => {
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const init = args[1] || {};
      const headers = init.headers;
      if (headers) {
        let auth = null;
        if (headers instanceof Headers) auth = headers.get("Authorization");
        else if (typeof headers === "object") {
          auth = headers["Authorization"] || headers["authorization"];
        }
        if (auth && auth.startsWith("Bearer ")) {
          window.postMessage({ type: "SUNO_BEARER", token: auth.slice(7) }, "*");
        }
      }
    } catch (e) { /* ignore */ }
    return origFetch.apply(this, args);
  };

  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name && name.toLowerCase() === "authorization" && value && value.startsWith("Bearer ")) {
      window.postMessage({ type: "SUNO_BEARER", token: value.slice(7) }, "*");
    }
    return origSet.apply(this, arguments);
  };
})();
