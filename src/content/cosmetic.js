/*
 * cosmetic.js
 * Cosmetic ad filtering for the page (runs in the isolated content-script world).
 *
 * Design goals:
 *  - Stealth: inject CSS via a constructable stylesheet / <style> that we keep a
 *    handle to but do not advertise; set no extension-identifying globals or
 *    attributes on hidden nodes; collapse rather than violently remove nodes.
 *  - Safety: selectors are static constants from selectors.js; nothing here is
 *    built from page-controlled strings, so there is no injection sink.
 *  - Correctness: respects the global on/off switch and the per-site allowlist.
 */
(function () {
  "use strict";

  const sel = window.__sab_sel__;
  if (!sel) return; // selectors failed to load; fail closed (do nothing).

  const host = (location.hostname || "").toLowerCase();

  // The top-level site decides the allowlist, as it does for network rules:
  // an ad iframe on an allowlisted page is not filtered either.
  // location.ancestorOrigins is Chromium-only and readable cross-origin.
  function topHost() {
    try {
      const anc = location.ancestorOrigins;
      if (anc && anc.length) return new URL(anc[anc.length - 1]).hostname.toLowerCase();
    } catch (_) {
      /* opaque ("null") origin, e.g. sandboxed frame: fall through */
    }
    return host;
  }
  const siteHost = window === window.top ? host : topHost();

  // Match a host against a registrable-domain key (suffix match, guarded so
  // "evil-youtube.com" does not match "youtube.com").
  function hostMatches(h, key) {
    return h === key || h.endsWith("." + key);
  }
  function matchesDomainKey(key) {
    return hostMatches(host, key);
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

  function applyHiding() {
    if (styleEl && styleEl.isConnected) return;
    const css = buildCss();
    styleEl = document.createElement("style");
    // textContent only — never innerHTML. Content is our own static CSS.
    styleEl.textContent = css;
    const parent = document.head || document.documentElement;
    if (parent) parent.appendChild(styleEl);
  }

  function removeHiding() {
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }
    styleEl = null;
  }

  // Decide whether to run, based on global enable flag + allowlist.
  function shouldRun(state) {
    if (!state || state.enabled === false) return false;
    const allow = Array.isArray(state.allowlist) ? state.allowlist : [];
    for (const d of allow) {
      if (typeof d === "string" && hostMatches(siteHost, d)) return false;
    }
    return true;
  }

  let observer = null;

  function startObserver() {
    if (observer) return;
    // A MutationObserver is only needed as a safety net; the CSS rule already
    // covers nodes added later. We keep it lightweight: re-attach our style if a
    // site wipes <head> (some SPAs do), nothing more.
    observer = new MutationObserver(function () {
      if (styleEl && !styleEl.isConnected) {
        const parent = document.head || document.documentElement;
        if (parent) parent.appendChild(styleEl);
      }
    });
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {
      /* documentElement not ready yet; will retry on next init tick */
    }
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function refresh(state) {
    if (shouldRun(state)) {
      applyHiding();
      startObserver();
    } else {
      stopObserver();
      removeHiding();
    }
  }

  // Pull state from the background/service worker via storage (no message round
  // trip needed for read; storage is synchronous-enough and avoids exposing a
  // message listener that a page could try to reach).
  function loadStateAndApply() {
    try {
      chrome.storage.local.get({ enabled: true, allowlist: [] }, function (state) {
        if (chrome.runtime.lastError) return; // context invalidated; ignore.
        refresh(state);
      });
    } catch (_) {
      // Extension context gone (e.g. during reload). Fail safe: do nothing.
    }
  }

  // React to live changes from the popup.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (changes.enabled || changes.allowlist) loadStateAndApply();
    });
  } catch (_) {
    /* ignore */
  }

  loadStateAndApply();
})();
