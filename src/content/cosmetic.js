/*
 * cosmetic.js
 * Cosmetic ad filtering for the page (runs in the isolated content-script world).
 *
 * Design goals:
 *  - No ad flash: the hiding CSS goes in synchronously at document_start,
 *    before the page has parsed anything, and comes out again only if the
 *    service worker says filtering is off or this site is allowlisted.
 *  - Least privilege: this script cannot read or write chrome.storage (the
 *    worker restricts storage.local to trusted contexts). It sends one
 *    read-only query and gets back two booleans for its own site; it never
 *    sees the allowlist and has no way to change settings.
 *  - Stealth: inject CSS via a <style> that we keep a handle to but do not
 *    advertise; set no extension-identifying globals or attributes on hidden
 *    nodes; collapse rather than violently remove nodes.
 *  - Safety: selectors are static constants from selectors.js; nothing here is
 *    built from page-controlled strings, so there is no injection sink.
 */
(function () {
  "use strict";

  const sel = window.__sab_sel__;
  if (!sel) return; // selectors failed to load; fail closed (do nothing).

  // Must equal COSMETIC_QUERY / COSMETIC_CHANGED in src/lib/policy.js. A
  // content script cannot import modules; test/hosts-policy.test.mjs pins them.
  const QUERY = "getCosmeticState";
  const CHANGED = "cosmeticStateChanged";

  const host = (location.hostname || "").toLowerCase();

  // Match the frame's own host against a per-domain selector key (suffix
  // match, guarded so "evil-youtube.com" does not match "youtube.com").
  function matchesDomainKey(key) {
    return host === key || host.endsWith("." + key);
  }

  function buildSelectorList() {
    const list = sel.GENERIC.slice();
    for (const key in sel.PER_DOMAIN) {
      if (Object.prototype.hasOwnProperty.call(sel.PER_DOMAIN, key) && matchesDomainKey(key)) {
        for (const s of sel.PER_DOMAIN[key]) list.push(s);
      }
    }
    return list;
  }

  let styleEl = null;

  function buildCss() {
    // One rule per selector. In a selector list, a single selector the
    // browser can't parse invalidates the whole rule, so one bad entry would
    // silently switch off all cosmetic filtering.
    // Collapse, do not remove: less jarring and less detectable than node removal.
    return buildSelectorList()
      .map((s) => s + " { display: none !important; }")
      .join("\n");
  }

  function attachStyle() {
    // At document_start <head> does not exist yet, but <html> does: Chromium
    // runs document_start scripts once the document element is created.
    const parent = document.head || document.documentElement;
    if (styleEl && !styleEl.isConnected && parent) parent.appendChild(styleEl);
  }

  function applyHiding() {
    if (!styleEl) {
      styleEl = document.createElement("style");
      // textContent only — never innerHTML. Content is our own static CSS.
      styleEl.textContent = buildCss();
    }
    attachStyle();
  }

  function removeHiding() {
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }
    styleEl = null;
  }

  let observer = null;

  function startObserver() {
    if (observer) return;
    // A MutationObserver is only needed as a safety net; the CSS rule already
    // covers nodes added later. We keep it lightweight: re-attach our style if a
    // site wipes <head> or replaces <html> (some SPAs do), nothing more.
    observer = new MutationObserver(function () {
      if (styleEl && !styleEl.isConnected) attachStyle();
    });
    observer.observe(document, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function hide() {
    applyHiding();
    startObserver();
  }

  function unhide() {
    stopObserver();
    removeHiding();
  }

  // Ask the worker whether to filter this page. Queries are numbered and only
  // the reply to the latest one is applied, so a slow reply can never
  // overwrite a newer one. Anything other than a well-formed reply (worker
  // error, extension reloaded) leaves the current state alone, which on first
  // load means filtering stays on.
  let latest = 0;
  function query() {
    const n = ++latest;
    let pending;
    try {
      pending = chrome.runtime.sendMessage({ action: QUERY });
    } catch (_) {
      return; // extension context invalidated (reload/update): keep state.
    }
    pending.then(
      function (reply) {
        if (n !== latest) return;
        if (!reply || typeof reply.enabled !== "boolean" || typeof reply.allowlisted !== "boolean") return;
        if (reply.enabled && !reply.allowlisted) hide();
        else unhide();
      },
      function () {
        /* no answer: keep the current state */
      }
    );
  }

  // Live updates: when settings change, the worker pings every tab. The ping
  // carries no state, so this only ever triggers a fresh query.
  try {
    chrome.runtime.onMessage.addListener(function (message, sender) {
      if (!sender || sender.id !== chrome.runtime.id) return;
      if (message && message.action === CHANGED) query();
    });
  } catch (_) {
    /* ignore */
  }

  // A page restored from the back/forward cache keeps this script's state
  // from before it was cached, and misses pings sent meanwhile: ask again.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) query();
  });

  // Optimistic: hide now, ask afterwards. The common case (filtering on, site
  // not allowlisted) never shows an ad; an allowlisted or switched-off page
  // shows its ad slots once the reply arrives.
  hide();

  // A prerendered page is not the tab's page yet, so the worker would judge
  // it by the wrong URL. Ask when it is activated (and not at all if it never
  // is).
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", query, { once: true });
  } else {
    query();
  }
})();
