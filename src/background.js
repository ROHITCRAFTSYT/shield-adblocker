/*
 * background.js  (MV3 service worker, ES module)
 *
 * Responsibilities:
 *  - Initialise persisted state (enabled flag + allowlist).
 *  - Reflect the global on/off switch onto the static blocking ruleset.
 *  - Translate the allowlist into one high-priority session
 *    "allowAllRequests" rule, so allowlisted sites are never network-filtered.
 *  - Handle popup / options-page commands with strict sender + shape checks.
 *
 * All decisions live in src/lib/policy.js (pure, unit-tested); this file is
 * only the chrome.* wiring.
 *
 * Security posture:
 *  - Only this extension's own pages are honoured (see isTrustedSender).
 *  - Action names are an explicit allowlist; unknown messages are dropped.
 *  - Everything read from storage is re-sanitised before use.
 *  - No remote code, no eval, no network fetch.
 */
import {
  STATIC_RULESET_ID,
  buildAllowRules,
  isTrustedSender,
  normalizeState,
  planCommand
} from "./lib/policy.js";

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
// write through the message handler below, which persists to storage).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled || changes.allowlist) reconcile();
});

/* ----------------------------- message handler ---------------------------- */

const EXTENSION_URL = chrome.runtime.getURL("");

async function handle(message) {
  const state = await getState();
  const { patch } = planCommand(message, state);
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return await getState();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages (popup, options). Content scripts and
  // other extensions are ignored without a reply.
  if (!isTrustedSender(sender, chrome.runtime.id, EXTENSION_URL)) return false;
  if (!message || typeof message !== "object" || typeof message.action !== "string") return false;

  handle(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async response.
});

// Best-effort reconcile whenever the worker spins up.
reconcile();
