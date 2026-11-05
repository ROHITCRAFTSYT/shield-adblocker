/*
 * hosts.js — hostname normalisation shared by the service worker, the popup
 * and the options page.
 *
 * Pure functions only (no chrome.* access) so the exact same code runs under
 * Node's test runner. The service worker re-sanitises everything it reads
 * from storage, so these functions are the single gate for allowlist data.
 */

// Hard cap on allowlist size. The allowlist compiles into ONE session rule
// (see policy.js), so this bounds that rule's size and keeps storage small.
export const MAX_ALLOWLIST = 5000;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Last label: letters only, or an IDNA punycode label ("xn--p1ai" for .рф).
// An all-numeric last label is rejected, which also rules out IPv4 literals.
const TLD = "(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})";
const HOST_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${TLD}$`);

/**
 * Normalise a hostname for allowlisting: trim, lower-case, drop a trailing
 * FQDN dot and a leading "www." (when something domain-like remains).
 * Returns null for anything that is not a plausible public hostname
 * (IP literals, "localhost", single labels, schemes, paths, spaces).
 * @param {unknown} value
 * @returns {string|null}
 */
export function sanitizeHost(value) {
  if (typeof value !== "string") return null;
  let h = value.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("www.") && h.indexOf(".", 4) !== -1) h = h.slice(4);
  return HOST_RE.test(h) ? h : null;
}

/**
 * Sanitise a whole allowlist: drop invalid entries and duplicates, keep the
 * first-seen order, and cap the length.
 * @param {unknown} arr
 * @returns {string[]}
 */
export function sanitizeAllowlist(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const h = sanitizeHost(item);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
      if (out.length >= MAX_ALLOWLIST) break;
    }
  }
  return out;
}

/**
 * The display host of a tab URL, or null for pages the extension never acts
 * on (chrome://, about:, file:, extension pages...). "www." is stripped so the
 * value lines up with allowlist entries. The result may still be rejected by
 * sanitizeHost (e.g. an IP address), which callers use to decide whether the
 * page can be allowlisted.
 * @param {string} url
 * @returns {string|null}
 */
export function pageHost(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let h = u.hostname.toLowerCase();
  if (h.startsWith("www.") && h.indexOf(".", 4) !== -1) h = h.slice(4);
  return h || null;
}

/**
 * Parse what a person types into the "add site" box: a bare host
 * ("example.com"), a host with a path, or a full URL. Unicode hosts are
 * converted to punycode by the URL parser, which is what DNR requires.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function hostFromInput(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  let u;
  try {
    u = new URL(hasScheme ? s : "http://" + s);
  } catch (_) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.port) return null;
  return sanitizeHost(u.hostname);
}

/**
 * The allowlist entry that covers `host`, if any. An entry covers itself and
 * every subdomain — the same semantics as DNR's requestDomains — and the
 * suffix check is dot-guarded so "evil-example.com" never matches
 * "example.com".
 * @param {string|null} host
 * @param {string[]} allowlist
 * @returns {string|null}
 */
export function findAllowlistEntry(host, allowlist) {
  if (!host || !Array.isArray(allowlist)) return null;
  for (const entry of allowlist) {
    if (host === entry || host.endsWith("." + entry)) return entry;
  }
  return null;
}
