/*
 * background.js  (MV3 service worker, ES module)
 *
 * Responsibilities:
 *  - Initialise persisted state (enabled flag + allowlist).
 *  - Reflect the global on/off switch onto the static blocking ruleset.
 *  - Translate the allowlist into one high-priority session
 *    "allowAllRequests" rule, so allowlisted sites are never network-filtered.
 *  - Handle popup / options-page commands with strict sender + shape checks.
 *  - Answer content scripts' read-only cosmetic query, and ping open tabs
 *    when settings change so they ask again.
 *
 * All decisions live in src/lib/policy.js (pure, unit-tested); this file is
 * only the chrome.* wiring.
 *
 * Security posture:
 *  - chrome.storage.local is restricted to trusted contexts (extension pages
 *    and this worker), so content scripts cannot read or write it.
 *  - Commands come only from this extension's own pages (isTrustedSender).
 *  - Content scripts get one read-only query, answered from browser-set
 *    sender fields; they can never reach planCommand.
 *  - Action names are an explicit allowlist; unknown messages are dropped.
 *  - Everything read from storage is re-sanitised before use.
 *  - No remote code, no eval, no network fetch.
 */
import {
  COSMETIC_CHANGED,
  STATIC_RULESET_ID,
  buildAllowRules,
  cosmeticStateFor,
  normalizeState,
  planCommand,
  routeMessage
} from "./lib/policy.js";

/* ------------------------------ storage lock ------------------------------ */

// First thing on every worker start. Chromium's default lets content scripts
// read and write storage.local; TRUSTED_CONTEXTS limits it to extension pages
// and this worker. The browser enforces it (by process, not by anything the
// renderer claims) and persists it in the profile, so after the first run it
// already applies when the browser starts, before any page loads. Calling it
// on every start is cheap and re-asserts it if the pref is ever lost.
// local accepts setAccessLevel from Chromium 140; older versions reject it,
// which is why manifest.json requires 140 (scripts/package.mjs enforces it).
// async, so even a synchronous throw (an API missing in some fork) becomes a
// logged rejection instead of failing the whole worker module.
async function lockStorage() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (e) {
    console.error("[Shield] could not restrict storage.local to trusted contexts:", e);
  }
}
const storageLocked = lockStorage();

/* ------------------------------ state helpers ----------------------------- */

async function getState() {
  const raw = await chrome.storage.local.get(["enabled", "allowlist"]);
  return normalizeState(raw);
}

/* --------------------------- ruleset / allow rules ------------------------ */

async function applyEnabledState(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    enabled
      ? { enableRulesetIds: [STATIC_RULESET_ID] }
      : { disableRulesetIds: [STATIC_RULESET_ID] }
  );
}

async function syncAllowRules(state) {
  // We own every session rule, so replace them wholesale in one atomic call.
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: buildAllowRules(state)
  });
}

function updateBadge(enabled) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: enabled ? "#2e7d32" : "#9e9e9e" });
    chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
  } catch (_) {
    /* action API may be unavailable very early; ignore. */
  }
}

async function doReconcile() {
  try {
    const state = await getState();
    await applyEnabledState(state.enabled);
    await syncAllowRules(state);
    updateBadge(state.enabled);
  } catch (e) {
    // Surface for debugging; never throw out of the worker.
    console.warn("[Shield] reconcile failed:", e);
  }
}

// Reconciles are serialised. Several triggers fire close together (worker
// start-up, onInstalled, storage.onChanged); run concurrently, two passes
// could both read an empty session ruleset and the slower, older one could
// overwrite the newer state. Each pass re-reads storage, so running them in
// order always converges on the latest state.
let reconcileQueue = Promise.resolve();
function reconcile() {
  reconcileQueue = reconcileQueue.then(doReconcile);
  return reconcileQueue;
}

/* ------------------------------- lifecycle -------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  // The worker's top-level code (the storage lock) has already run by the time
  // this fires; wait for it so defaults are written with storage locked.
  await storageLocked;
  // Persist sanitised defaults so every reader sees a clean shape. Enabled
  // static rulesets reset to the manifest default on update, so reconcile.
  const current = await getState();
  await chrome.storage.local.set(current);
  reconcile();
});

chrome.runtime.onStartup.addListener(() => {
  // Session rules are cleared on browser restart; rebuild from storage.
  reconcile();
});

// Keep rules in sync whenever state changes (the popup and options page both
// write through the message handler below, which persists to storage). Only
// trusted contexts can write storage.local, so this only fires for them.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled || changes.allowlist) {
    reconcile();
    notifyTabs();
  }
});

// Tell every open tab's content scripts to ask again. Without the "tabs"
// permission, tabs.query returns ids but no URLs, which is all this needs.
// The ping carries no state; each frame re-queries and gets an answer for its
// own site. Tabs with no content script (chrome://, the new tab page,
// discarded tabs) reject; that is expected and ignored.
async function notifyTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {
    return;
  }
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    chrome.tabs.sendMessage(tab.id, { action: COSMETIC_CHANGED }).catch(() => {});
  }
}

/* ----------------------------- message handler ---------------------------- */

const EXTENSION_URL = chrome.runtime.getURL("");

async function handle(message) {
  const state = await getState();
  const { patch } = planCommand(message, state);
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return await getState();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (routeMessage(message, sender, chrome.runtime.id, EXTENSION_URL)) {
    case "command":
      // The popup or options page.
      handle(message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true; // async response.
    case "cosmeticQuery":
      // A content script. Read-only: answers { enabled, allowlisted } for the
      // sender's own top-level site, and never writes anything.
      getState()
        .then((state) => sendResponse(cosmeticStateFor(sender, state)))
        .catch(() => sendResponse(null));
      return true;
    default:
      // Anything else, from anyone, is dropped without a reply. That
      // includes every mutating action sent from a content script.
      return false;
  }
});

// Best-effort reconcile whenever the worker spins up.
reconcile();
