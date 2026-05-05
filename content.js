// content.js — runs on suno.com pages.
// Two jobs:
//   1. Capture the Bearer JWT that Suno's web app uses, so background can call APIs.
//   2. Inject a ⭐ button next to creators on profile pages and the /following list.

(function () {
  "use strict";

  // ---- 1. Token capture ----
  // We need to monkey-patch fetch/XHR in the page's main world to read
  // Authorization headers. Content scripts run in an isolated world that
  // cannot see the page's own fetch. We must inject a script.
  //
  // Suno has a strict CSP that blocks INLINE scripts. So we cannot do
  // s.textContent = "..." — that's blocked. Instead we load injected.js
  // via src=chrome-extension://, which CSPs allow because it's a different
  // origin than the page.

  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("injected.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    if (!ev.data) return;
    if (ev.data.type === "SUNO_BEARER" && ev.data.token) {
      chrome.storage.local.set({ sunoBearer: ev.data.token });
    }
  });

  // The user's own handle is captured by suno-api.js fetchFollowing() from
  // the response body (which always includes the requesting user's handle).
  // No content-script work needed for that.

  // ---- 2. Star button injection ----
  // Suno's UI is a React SPA. We use a MutationObserver to detect when
  // creator cards or profile headers appear, then inject a star.

  const STAR_CLASS = "sf-star-btn";

  function getHandleFromUrl(href) {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^\/@([^\/?#]+)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  async function isStarred(handle) {
    try {
      const { superFriends } = await chrome.storage.local.get("superFriends");
      return (superFriends || []).some(f => f.handle === handle);
    } catch (e) {
      // Extension context invalidated (typically after reloading the extension
      // while a tab is still open). The page needs a refresh; nothing we can
      // do about it from here. Swallow silently.
      return false;
    }
  }

  function makeStar(handle, displayName, avatarUrl) {
    const btn = document.createElement("button");
    btn.className = STAR_CLASS;
    btn.dataset.handle = handle;
    btn.title = "Add to Super Friends";
    btn.textContent = "☆";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const friends = (await chrome.storage.local.get("superFriends")).superFriends || [];
        const exists = friends.some(f => f.handle === handle);
        if (exists) {
          const next = friends.filter(f => f.handle !== handle);
          await chrome.storage.local.set({ superFriends: next });
          btn.textContent = "☆";
          btn.classList.remove("active");
        } else {
          friends.push({
            handle,
            displayName: displayName || handle,
            avatarUrl: avatarUrl || "",
            seenSongIds: [],
            addedAt: Date.now(),
          });
          await chrome.storage.local.set({ superFriends: friends });
          btn.textContent = "★";
          btn.classList.add("active");
        }
      } catch (err) {
        console.warn("[SuperFriends] storage failed; refresh the page:", err.message);
        btn.title = "Refresh the page (extension was reloaded)";
      }
    });
    isStarred(handle).then(yes => {
      if (yes) { btn.textContent = "★"; btn.classList.add("active"); }
    });
    return btn;
  }

  // Find every <a href="/@handle"> on the page and inject a star next to it.
  // This handles links TO creators from elsewhere (lists, comments, search).
  // For the page you're CURRENTLY viewing (e.g. suno.com/@somebody), see
  // injectProfileHeaderStar() below — that's a different code path because
  // the profile header is a heading, not a link to itself.
  const decorated = new WeakSet();

  function scan() {
    const anchors = document.querySelectorAll('a[href^="/@"]');
    for (const a of anchors) {
      if (decorated.has(a)) continue;
      const handle = getHandleFromUrl(a.getAttribute("href"));
      if (!handle) continue;
      const text = (a.textContent || "").trim();
      if (!text) continue;
      decorated.add(a);
      const displayName = text;
      const img = a.querySelector("img") || a.parentElement?.querySelector("img");
      const avatarUrl = img?.src || "";
      const btn = makeStar(handle, displayName, avatarUrl);
      a.insertAdjacentElement("afterend", btn);
    }
    injectProfileHeaderStar();
  }

  // When the user is viewing /@somebody, inject a star into the profile
  // header itself. The handle comes from location.pathname; the display name
  // and avatar come from the page's first <h1> and first large image.
  let headerInjectedFor = null;
  function injectProfileHeaderStar() {
    const m = location.pathname.match(/^\/@([^\/?#]+)/);
    if (!m) { headerInjectedFor = null; return; }
    const handle = decodeURIComponent(m[1]);

    // If we already injected for this handle and the button still exists,
    // do nothing. Otherwise (SPA navigated to a new profile) re-inject.
    if (headerInjectedFor === handle &&
        document.querySelector(`.${STAR_CLASS}[data-handle="${cssEscape(handle)}"][data-loc="header"]`)) {
      return;
    }

    // Find the profile header heading. Try h1 first, then h2.
    const heading = document.querySelector("h1") || document.querySelector("h2");
    if (!heading) return;

    // Avoid duplicates from previous scans on the same heading.
    if (heading.querySelector(`.${STAR_CLASS}[data-loc="header"]`)) {
      headerInjectedFor = handle;
      return;
    }

    const displayName = (heading.textContent || handle).trim();
    // Best-effort avatar lookup: the largest <img> in the same section.
    let avatarUrl = "";
    const section = heading.closest("section, header, div");
    if (section) {
      const imgs = Array.from(section.querySelectorAll("img"));
      const largest = imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];
      avatarUrl = largest?.src || "";
    }

    const btn = makeStar(handle, displayName, avatarUrl);
    btn.dataset.loc = "header";
    btn.classList.add("sf-star-btn-large");
    heading.appendChild(btn);
    headerInjectedFor = handle;
  }

  // Tiny CSS.escape polyfill for the rare case it's missing.
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  const observer = new MutationObserver(() => {
    // Throttle: only scan once per animation frame.
    if (observer._pending) return;
    observer._pending = true;
    requestAnimationFrame(() => {
      observer._pending = false;
      scan();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
})();
