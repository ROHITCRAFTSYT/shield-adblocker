/*
 * policy.js — the pure decision logic behind the service worker: which DNR
 * session rules represent the allowlist, and which message senders are
 * trusted. No chrome.* access, so it is unit-tested under Node.
 */
import { sanitizeAllowlist, sanitizeHost } from "./hosts.js";

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
