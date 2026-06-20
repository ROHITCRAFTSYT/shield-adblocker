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

  const host = location.hostname || "";

  // Match the current host against a registrable-domain key (suffix match,
  // guarded so "evil-youtube.com" does not match "youtube.com").
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
    const selectors = buildSelectorList().join(",\n");
    // Collapse, do not remove: less jarring and less detectable than node removal.
    return selectors + " { display: none !important; }";
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
    const allow = state.allowlist || [];
    for (const d of allow) {
      if (host === d || host.endsWith("." + d)) return false;
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
