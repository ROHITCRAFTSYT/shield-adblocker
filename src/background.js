/*
 * background.js  (MV3 service worker)
 *
 * Responsibilities:
 *  - Initialise persisted state (enabled flag + allowlist).
 *  - Reflect the global on/off switch onto the static blocking ruleset.
 *  - Translate the allowlist into high-priority session "allow" rules so that
 *    allowlisted top-level sites are never network-filtered.
 *  - Handle popup commands with strict sender + shape validation.
 *
 * Security posture:
 *  - Only same-extension senders are honoured (sender.id === runtime id).
 *  - Action names are an explicit allowlist; unknown messages are dropped.
 *  - All inputs are type/shape checked before use.
 *  - No remote code, no eval, no network fetch.
 */
"use strict";

const STATIC_RULESET_ID = "ad_block_rules";

// Session "allow" rules occupy a reserved high id range so they never collide
// with the static ruleset ids (1..N in rules/network-rules.json).
const ALLOW_RULE_BASE = 1000000;
const ALLOW_RULE_PRIORITY = 100; // > static block priority (1) so allow wins.

const DEFAULT_STATE = Object.freeze({ enabled: true, allowlist: [] });

/* ------------------------------ state helpers ----------------------------- */

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_STATE, (s) => {
      resolve({
        enabled: s.enabled !== false,
        allowlist: sanitizeAllowlist(s.allowlist)
      });
    });
  });
}

// Accept only plausible hostnames: lowercase, no scheme, no path, no spaces.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function sanitizeHost(value) {
  if (typeof value !== "string") return null;
  let h = value.trim().toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  return HOST_RE.test(h) ? h : null;
}

function sanitizeAllowlist(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const h = sanitizeHost(item);
    if (h && out.indexOf(h) === -1) out.push(h);
    if (out.length >= 5000) break; // hard cap; defensive against bloat.
  }
  return out;
}

/* --------------------------- ruleset / allow rules ------------------------ */

async function applyEnabledState(enabled) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled
        ? { enableRulesetIds: [STATIC_RULESET_ID], disableRulesetIds: [] }
        : { enableRulesetIds: [], disableRulesetIds: [STATIC_RULESET_ID] }
    );
  } catch (e) {
    // Surface to console for debugging; never throw out of the worker.
    console.warn("[Shield] failed to toggle ruleset:", e);
  }
}

async function syncAllowRules(state) {
  // Clear any existing session allow rules, then add fresh ones.
  let existing = [];
  try {
    existing = await chrome.declarativeNetRequest.getSessionRules();
  } catch (_) {
    existing = [];
  }
  const removeIds = existing
    .filter((r) => r.id >= ALLOW_RULE_BASE)
    .map((r) => r.id);

  const addRules = [];
  if (state.enabled && state.allowlist.length) {
    state.allowlist.forEach((domain, i) => {
      addRules.push({
        id: ALLOW_RULE_BASE + i,
        priority: ALLOW_RULE_PRIORITY,
        action: { type: "allow" },
        condition: {
          // Allow every request initiated by the allowlisted top-level site.
          initiatorDomains: [domain]
        }
      });
    });
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: removeIds,
      addRules
    });
  } catch (e) {
    console.warn("[Shield] failed to sync allow rules:", e);
  }
}

async function reconcile() {
  const state = await getState();
  await applyEnabledState(state.enabled);
  await syncAllowRules(state);
  updateBadge(state.enabled);
}

function updateBadge(enabled) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: enabled ? "#2e7d32" : "#9e9e9e" });
    chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
  } catch (_) {
    /* action API may be unavailable very early; ignore. */
  }
}

/* ------------------------------- lifecycle -------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  const current = await getState();
  // Persist sanitised defaults so popup/content always read a clean shape.
  chrome.storage.local.set(current, () => reconcile());
});

chrome.runtime.onStartup.addListener(() => {
  // Session rules are cleared on browser restart; rebuild from persisted state.
  reconcile();
});

// Keep rules in sync if state changes from anywhere (popup writes storage).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled || changes.allowlist) reconcile();
});

/* ----------------------------- message handler ---------------------------- */

const ACTIONS = {
  getState: async () => {
    return await getState();
  },
  setEnabled: async (msg) => {
    if (typeof msg.value !== "boolean") throw new Error("bad value");
    await new Promise((res) => chrome.storage.local.set({ enabled: msg.value }, res));
    return await getState();
  },
  setAllowed: async (msg) => {
    // Add/remove the given host from the allowlist. value: boolean (allowed?)
    const host = sanitizeHost(msg.host);
    if (host === null || typeof msg.value !== "boolean") throw new Error("bad input");
    const state = await getState();
    const set = new Set(state.allowlist);
    if (msg.value) set.add(host);
    else set.delete(host);
    const allowlist = sanitizeAllowlist(Array.from(set));
    await new Promise((res) => chrome.storage.local.set({ allowlist }, res));
    return await getState();
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 1) Only accept messages from THIS extension's own pages (popup).
  //    Content scripts / web pages have no sender.id equal to our runtime id
  //    for externally_connectable, and we never set externally_connectable.
  if (!sender || sender.id !== chrome.runtime.id) return false;
  // 2) Reject anything originating from a tab (content scripts). The popup has
  //    no sender.tab. This stops a compromised content script from driving us.
  if (sender.tab) return false;
  // 3) Validate the message shape.
  if (!message || typeof message !== "object") return false;
  const handler = ACTIONS[message.action];
  if (!handler) return false;

  handler(message)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async response.
});

// Best-effort initial reconcile when the worker spins up.
reconcile();
