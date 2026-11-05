/*
 * client.js — helpers for the extension's own pages (popup, options).
 * Every state change goes through the service worker, which validates it;
 * pages never write chrome.storage directly.
 */

/**
 * Send a command to the service worker. Always resolves to
 * `{ ok: true, data }` or `{ ok: false, error }`, never rejects.
 * @param {object} message
 */
export async function send(message) {
  try {
    const resp = await chrome.runtime.sendMessage(message);
    return resp || { ok: false, error: "no response" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Number of rules in the bundled static blocklist, read from the packaged
 * file (a local chrome-extension:// read, not a network request).
 * Resolves to null if it cannot be read.
 * @returns {Promise<number|null>}
 */
export async function getStaticRuleCount() {
  try {
    const manifest = chrome.runtime.getManifest();
    const res = manifest.declarative_net_request.rule_resources;
    let total = 0;
    for (const r of res) {
      const rules = await (await fetch(chrome.runtime.getURL(r.path))).json();
      if (Array.isArray(rules)) total += rules.length;
    }
    return total;
  } catch (_) {
    return null;
  }
}

/** Extension version from the manifest, e.g. "1.1.0". */
export function version() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_) {
    return "";
  }
}
