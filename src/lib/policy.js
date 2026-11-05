/*
 * policy.js — the pure decision logic behind the service worker: which DNR
 * session rules represent the allowlist, and which message senders are
 * trusted. No chrome.* access, so it is unit-tested under Node.
 */
import { findAllowlistEntry, pageHost, sanitizeAllowlist, sanitizeHost } from "./hosts.js";

export const STATIC_RULESET_ID = "ad_block_rules";
export const SESSION_RULESET_ID = "_session"; // DNR's id for session rules.

// The allowlist compiles to a single session rule with this id. Static rules
// are numbered 1..N, so a high id keeps the two from ever being confused.
export const ALLOW_RULE_ID = 1000000;
// Must exceed the static block priority (1): an allowAllRequests rule only
// overrides block rules whose priority is <= its own.
export const ALLOW_RULE_PRIORITY = 100;

export const DEFAULT_STATE = Object.freeze({ enabled: true, allowlist: Object.freeze([]) });

/**
 * Normalise state read from storage. Anything malformed falls back to safe
 * defaults (blocking on, empty allowlist).
 * @param {unknown} raw
 * @returns {{enabled: boolean, allowlist: string[]}}
 */
export function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: s.enabled !== false,
    allowlist: sanitizeAllowlist(s.allowlist)
  };
}

/**
 * The session rules that implement the allowlist.
 *
 * One `allowAllRequests` rule on `main_frame`: when a top-level navigation goes
 * to an allowlisted site (or a subdomain of one), every request in that tab's
 * frame tree is allowed, third-party iframes included. That is what "pause
 * blocking on this site" means. A plain `allow` rule keyed on
 * initiatorDomains would miss requests made from inside third-party iframes.
 *
 * Because allowAllRequests is evaluated when the page is requested, a change
 * takes effect on the next load of the page.
 * @param {{enabled: boolean, allowlist: string[]}} state
 * @returns {object[]}
 */
export function buildAllowRules(state) {
  if (!state || !state.enabled) return [];
  const domains = sanitizeAllowlist(state.allowlist);
  if (domains.length === 0) return [];
  return [
    {
      id: ALLOW_RULE_ID,
      priority: ALLOW_RULE_PRIORITY,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: domains, resourceTypes: ["main_frame"] }
    }
  ];
}

/**
 * Count of requests blocked on a tab, from a getMatchedRules() result. Only
 * matches from the static block ruleset count; the session allow rule also
 * reports matches (every request on an allowlisted page), and those are not
 * blocks.
 * @param {{rulesMatchedInfo?: Array<{rule?: {rulesetId?: string}}>}|undefined} details
 * @returns {number}
 */
export function countBlocked(details) {
  const list = details && Array.isArray(details.rulesMatchedInfo) ? details.rulesMatchedInfo : [];
  let n = 0;
  for (const info of list) {
    if (info && info.rule && info.rule.rulesetId === STATIC_RULESET_ID) n++;
  }
  return n;
}

/**
 * Whether a runtime message comes from one of this extension's own pages
 * (popup or options). The browser sets `sender.id` and `sender.url`; a page
 * cannot forge them. Content scripts share our extension id, but their
 * `sender.url` is the web page they run in, so they fail the origin check.
 * This replaces a `!sender.tab` check, which wrongly rejected the options
 * page whenever it is opened in a tab.
 * @param {{id?: string, url?: string}|undefined} sender
 * @param {string} runtimeId     chrome.runtime.id
 * @param {string} extensionUrl  chrome.runtime.getURL("")
 * @returns {boolean}
 */
export function isTrustedSender(sender, runtimeId, extensionUrl) {
  if (!sender || typeof runtimeId !== "string" || sender.id !== runtimeId) return false;
  if (typeof sender.url !== "string" || typeof extensionUrl !== "string") return false;
  // Plain prefix match on "chrome-extension://<id>/" (the trailing slash
  // matters). URL#origin is not used: for this scheme it is "null" in some
  // runtimes, which would make every extension's pages look alike.
  if (!extensionUrl.endsWith("/") || extensionUrl.length < 4) return false;
  return sender.url.startsWith(extensionUrl);
}

/* --------------------- content scripts: read-only channel ------------------ */

// The one message a content script may send. It carries no data: everything
// the answer depends on comes from browser-set sender fields.
export const COSMETIC_QUERY = "getCosmeticState";
// Sent by the worker to every tab when settings change. Also carries no data;
// a content script that receives it simply asks again.
export const COSMETIC_CHANGED = "cosmeticStateChanged";

/**
 * Whether a runtime message comes from one of this extension's content
 * scripts: our extension id, but a sender URL that is not one of our own
 * pages. Disjoint from isTrustedSender by construction, so a content script
 * can never reach the command path. Other extensions' content scripts carry
 * their own id and are rejected.
 * @param {{id?: string, url?: string}|undefined} sender
 * @param {string} runtimeId
 * @param {string} extensionUrl
 * @returns {boolean}
 */
export function isContentScriptSender(sender, runtimeId, extensionUrl) {
  if (!sender || typeof runtimeId !== "string" || sender.id !== runtimeId) return false;
  if (typeof sender.url !== "string") return false;
  return !isTrustedSender(sender, runtimeId, extensionUrl);
}

/**
 * Whether `message` is exactly `{ action: "getCosmeticState" }`. Any other
 * key, or any other action, is rejected: a content script has nothing to tell
 * the worker, so there is nothing to parse.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isCosmeticQuery(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const keys = Object.keys(message);
  return keys.length === 1 && keys[0] === "action" && message.action === COSMETIC_QUERY;
}

/**
 * The top-level site a content-script sender belongs to, from fields the
 * browser sets (a renderer cannot forge them):
 *  - top frame (frameId 0): `sender.url`;
 *  - any other frame: the tab's URL, so an ad iframe on an allowlisted page is
 *    treated like the page, as the network allowlist does;
 *  - an iframe with no tab URL: unknown (null), so it is never treated as
 *    allowlisted. Falling back to the iframe's own URL would let an
 *    allowlisted host's iframe go unfiltered on every site that embeds it.
 * The content script does not report its own top-level origin. If it could,
 * a compromised renderer could ask about arbitrary hosts and read the
 * allowlist one entry at a time.
 * @param {{url?: string, frameId?: number, tab?: {url?: string}}} sender
 * @returns {string|null} display host (as pageHost), or null if unknown or not a web page
 */
export function cosmeticSiteHost(sender) {
  if (!sender || typeof sender.url !== "string") return null;
  if (sender.frameId === 0) return pageHost(sender.url);
  const tabUrl = sender.tab && typeof sender.tab.url === "string" ? sender.tab.url : null;
  return tabUrl === null ? null : pageHost(tabUrl);
}

/**
 * The answer to a cosmetic query: only whether filtering is on and whether
 * the sender's own top-level site is allowlisted. Never the allowlist itself.
 * Uses the same host normalisation as the popup, so the popup's "paused on
 * this site" and the page's behaviour cannot disagree.
 * @param {{url?: string, frameId?: number, tab?: {url?: string}}} sender
 * @param {{enabled: boolean, allowlist: string[]}} state
 * @returns {{enabled: boolean, allowlisted: boolean}}
 */
export function cosmeticStateFor(sender, state) {
  const host = sanitizeHost(cosmeticSiteHost(sender));
  return {
    enabled: state.enabled === true,
    allowlisted: findAllowlistEntry(host, state.allowlist) !== null
  };
}

/**
 * Route a runtime message. Returns:
 *  - "command": from our own pages, handled by planCommand (may write);
 *  - "cosmeticQuery": a well-formed read-only query from a content script;
 *  - null: drop it without a reply. That covers anything a content script
 *    sends other than the query (including every mutating action), every
 *    other extension, and malformed senders.
 * @param {unknown} message
 * @param {object|undefined} sender
 * @param {string} runtimeId
 * @param {string} extensionUrl
 * @returns {"command"|"cosmeticQuery"|null}
 */
export function routeMessage(message, sender, runtimeId, extensionUrl) {
  if (isTrustedSender(sender, runtimeId, extensionUrl)) {
    return message && typeof message === "object" && typeof message.action === "string" ? "command" : null;
  }
  if (isContentScriptSender(sender, runtimeId, extensionUrl) && isCosmeticQuery(message)) {
    return "cosmeticQuery";
  }
  return null;
}

/**
 * Validate a message and compute the next persisted state, without touching
 * storage. Returns `{ patch }` (keys to write; may be empty for reads) or
 * throws on malformed input. Keeping this pure makes the whole command
 * surface unit-testable.
 * @param {unknown} message
 * @param {{enabled: boolean, allowlist: string[]}} state current state
 * @returns {{patch: object}}
 */
export function planCommand(message, state) {
  if (!message || typeof message !== "object") throw new Error("bad message");
  switch (message.action) {
    case "getState":
      return { patch: {} };
    case "setEnabled":
      if (typeof message.value !== "boolean") throw new Error("bad value");
      return { patch: { enabled: message.value } };
    case "setAllowed": {
      const host = sanitizeHost(message.host);
      if (host === null || typeof message.value !== "boolean") throw new Error("bad input");
      const next = state.allowlist.filter((h) => h !== host);
      if (message.value) next.push(host);
      return { patch: { allowlist: sanitizeAllowlist(next) } };
    }
    case "setAllowlist":
      if (!Array.isArray(message.value)) throw new Error("bad value");
      return { patch: { allowlist: sanitizeAllowlist(message.value) } };
    default:
      throw new Error("unknown action");
  }
}
