/*
 * dnr.mjs — an offline model of Chrome's declarativeNetRequest (DNR) rules:
 *
 *  1. validateRule / validateRuleset / validateRuleResources: schema and
 *     limit checks that mirror what Chrome enforces when it indexes a ruleset,
 *     so a bad rule fails in CI instead of being silently skipped at install
 *     (Chrome drops invalid static rules with only a console warning).
 *  2. compileUrlFilter / matchesCondition / evaluateRequest: a matcher for
 *     the urlFilter syntax and action precedence, used by the tests to pin
 *     down what the shipped rules do and do not block.
 *
 * Sources (Chromium @ c6d70f76a8636531ae3ae2c51603f83703ea8dbc):
 *  - extensions/common/api/declarative_net_request.webidl  (API, limits)
 *  - extensions/browser/api/declarative_net_request/indexed_rule.cc
 *      (urlFilter parsing, domain canonicalisation, action-type priority)
 *  - extensions/browser/api/declarative_net_request/constants.cc (errors)
 *
 * Known simplification: first/third-party is decided by eTLD+1, and Chrome
 * uses the full Public Suffix List for that. This model knows only the common
 * multi-label suffixes in MULTI_LABEL_SUFFIXES. That is enough for the tests;
 * it is not a general-purpose PSL.
 */

/* --------------------------------- schema --------------------------------- */

export const LIMITS = Object.freeze({
  GUARANTEED_MINIMUM_STATIC_RULES: 30000,
  MAX_NUMBER_OF_REGEX_RULES: 1000,
  MAX_NUMBER_OF_SESSION_RULES: 5000,
  MAX_NUMBER_OF_STATIC_RULESETS: 100,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50
});

export const RESOURCE_TYPES = Object.freeze([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
  "webbundle", "other"
]);

export const REQUEST_METHODS = Object.freeze([
  "connect", "delete", "get", "head", "options", "patch", "post", "put", "other"
]);

export const DOMAIN_TYPES = Object.freeze(["firstParty", "thirdParty"]);

// Tie-break order when two matching rules share a priority (indexed_rule.cc,
// GetActionTypePriority): higher wins.
export const ACTION_TYPE_PRIORITY = Object.freeze({
  allow: 5,
  allowAllRequests: 4,
  block: 3,
  upgradeScheme: 2,
  redirect: 1,
  modifyHeaders: 0
});
export const ACTION_TYPES = Object.freeze(Object.keys(ACTION_TYPE_PRIORITY));

const RULE_KEYS = new Set(["id", "priority", "condition", "action"]);
const ACTION_KEYS = new Set(["type", "redirect", "requestHeaders", "responseHeaders"]);
const DOMAIN_LIST_KEYS = [
  "initiatorDomains", "excludedInitiatorDomains",
  "requestDomains", "excludedRequestDomains",
  "topDomains", "excludedTopDomains"
];
const CONDITION_KEYS = new Set([
  "urlFilter", "regexFilter", "isUrlFilterCaseSensitive",
  ...DOMAIN_LIST_KEYS,
  "domains", "excludedDomains",
  "resourceTypes", "excludedResourceTypes",
  "requestMethods", "excludedRequestMethods",
  "domainType", "tabIds", "excludedTabIds",
  "responseHeaders", "excludedResponseHeaders"
]);

// eslint-disable-next-line no-control-regex
const ASCII_RE = /^[\x00-\x7f]*$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v >= 1;

function checkEnumList(errors, cond, key, allowed, { allowEmpty = false } = {}) {
  if (!(key in cond)) return;
  const v = cond[key];
  if (!Array.isArray(v)) return errors.push(`condition.${key} must be an array`);
  if (!allowEmpty && v.length === 0) errors.push(`condition.${key} cannot be an empty list`);
  for (const item of v) {
    if (!allowed.includes(item)) errors.push(`condition.${key} has unknown value ${JSON.stringify(item)}`);
  }
}

function checkIncludeExclude(errors, cond, inc, exc, what) {
  if (!Array.isArray(cond[inc]) || !Array.isArray(cond[exc])) return;
  const ex = new Set(cond[exc]);
  for (const v of cond[inc]) {
    if (ex.has(v)) errors.push(`includes and excludes the same ${what} ${JSON.stringify(v)}`);
  }
}

/**
 * Validate one rule. Returns a list of human-readable problems (empty = OK).
 * @param {unknown} rule
 * @param {{scope?: "static"|"dynamic"|"session"}} [opts]
 * @returns {string[]}
 */
export function validateRule(rule, { scope = "static" } = {}) {
  const errors = [];
  if (!isObj(rule)) return ["rule must be an object"];

  for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k)) errors.push(`unknown key "${k}"`);
  if (!isPosInt(rule.id)) errors.push("id must be an integer >= 1");
  if ("priority" in rule && !isPosInt(rule.priority)) errors.push("priority must be an integer >= 1");

  // --- action ---
  const action = rule.action;
  if (!isObj(action)) {
    errors.push("action must be an object");
  } else {
    for (const k of Object.keys(action)) if (!ACTION_KEYS.has(k)) errors.push(`unknown action key "${k}"`);
    if (!ACTION_TYPES.includes(action.type)) {
      errors.push(`action.type ${JSON.stringify(action.type)} is not one of ${ACTION_TYPES.join(", ")}`);
    }
    if (action.type === "redirect") {
      if (!isObj(action.redirect)) errors.push("redirect rules need action.redirect");
    } else if ("redirect" in action) {
      errors.push("action.redirect is only valid for redirect rules");
    }
    if (action.type === "modifyHeaders") {
      const hasReq = Array.isArray(action.requestHeaders) && action.requestHeaders.length > 0;
      const hasRes = Array.isArray(action.responseHeaders) && action.responseHeaders.length > 0;
      if (!hasReq && !hasRes) errors.push("modifyHeaders rules need requestHeaders or responseHeaders");
    } else if ("requestHeaders" in action || "responseHeaders" in action) {
      errors.push("requestHeaders/responseHeaders are only valid for modifyHeaders rules");
    }
  }

  // --- condition ---
  const cond = rule.condition;
  if (!isObj(cond)) {
    errors.push("condition must be an object");
    return errors;
  }
  for (const k of Object.keys(cond)) if (!CONDITION_KEYS.has(k)) errors.push(`unknown condition key "${k}"`);

  if ("domains" in cond || "excludedDomains" in cond) {
    errors.push('condition.domains/excludedDomains are deprecated; use "initiatorDomains"/"excludedInitiatorDomains"');
  }

  if ("urlFilter" in cond && "regexFilter" in cond) {
    errors.push('can only specify one of "urlFilter" or "regexFilter"');
  }
  if ("urlFilter" in cond) {
    const f = cond.urlFilter;
    if (typeof f !== "string" || f.length === 0) {
      errors.push("condition.urlFilter must be a non-empty string");
    } else {
      if (!ASCII_RE.test(f)) errors.push("condition.urlFilter must be ASCII (punycode hosts, %-encode the rest)");
      if (f.startsWith("||*")) errors.push('condition.urlFilter cannot start with "||*"; use "*" instead');
    }
  }
  if ("regexFilter" in cond) {
    const f = cond.regexFilter;
    if (typeof f !== "string" || f.length === 0) {
      errors.push("condition.regexFilter must be a non-empty string");
    } else {
      if (!ASCII_RE.test(f)) errors.push("condition.regexFilter must be ASCII");
      try {
        new RegExp(f); // Chrome uses RE2; this is a best-effort syntax check.
      } catch (e) {
        errors.push(`condition.regexFilter does not compile: ${e.message}`);
      }
    }
  }
  if ("isUrlFilterCaseSensitive" in cond && typeof cond.isUrlFilterCaseSensitive !== "boolean") {
    errors.push("condition.isUrlFilterCaseSensitive must be a boolean");
  }

  for (const key of DOMAIN_LIST_KEYS) {
    if (!(key in cond)) continue;
    const list = cond[key];
    if (!Array.isArray(list)) {
      errors.push(`condition.${key} must be an array`);
      continue;
    }
    // Chrome rejects an empty include list; an empty exclude list is a no-op.
    if (list.length === 0 && !key.startsWith("excluded")) errors.push(`condition.${key} cannot be an empty list`);
    for (const d of list) {
      if (typeof d !== "string" || d.length === 0) errors.push(`condition.${key} has an empty/non-string entry`);
      else if (!ASCII_RE.test(d)) errors.push(`condition.${key} entry "${d}" must be ASCII (use punycode)`);
      else if (/[/:\s]/.test(d)) errors.push(`condition.${key} entry "${d}" must be a bare domain`);
    }
  }

  checkEnumList(errors, cond, "resourceTypes", RESOURCE_TYPES);
  checkEnumList(errors, cond, "excludedResourceTypes", RESOURCE_TYPES, { allowEmpty: true });
  checkIncludeExclude(errors, cond, "resourceTypes", "excludedResourceTypes", "resource type");
  if (Array.isArray(cond.excludedResourceTypes) && !("resourceTypes" in cond) &&
      RESOURCE_TYPES.every((t) => cond.excludedResourceTypes.includes(t))) {
    errors.push("rule is not applicable to any resource type");
  }

  checkEnumList(errors, cond, "requestMethods", REQUEST_METHODS);
  checkEnumList(errors, cond, "excludedRequestMethods", REQUEST_METHODS, { allowEmpty: true });
  checkIncludeExclude(errors, cond, "requestMethods", "excludedRequestMethods", "request method");

  if ("domainType" in cond && !DOMAIN_TYPES.includes(cond.domainType)) {
    errors.push(`condition.domainType must be one of ${DOMAIN_TYPES.join(", ")}`);
  }

  if (("tabIds" in cond || "excludedTabIds" in cond) && scope !== "session") {
    errors.push("condition.tabIds/excludedTabIds are only supported for session rules");
  }

  if (isObj(action) && action.type === "allowAllRequests") {
    const rt = cond.resourceTypes;
    if (!Array.isArray(rt) || rt.length === 0 || rt.some((t) => t !== "main_frame" && t !== "sub_frame")) {
      errors.push('allowAllRequests rules must set "resourceTypes" to only "main_frame" and/or "sub_frame"');
    }
  }

  return errors;
}

/**
 * Validate a whole ruleset (the parsed JSON array). Errors are prefixed with
 * the rule's index and id so they point straight at the offending entry.
 * @param {unknown} rules
 * @param {{scope?: "static"|"dynamic"|"session"}} [opts]
 * @returns {string[]}
 */
export function validateRuleset(rules, { scope = "static" } = {}) {
  if (!Array.isArray(rules)) return ["ruleset must be a JSON array of rules"];
  const errors = [];
  const ids = new Set();
  let regexCount = 0;
  rules.forEach((rule, i) => {
    const where = `rules[${i}]` + (isObj(rule) && rule.id !== undefined ? ` (id ${rule.id})` : "");
    for (const e of validateRule(rule, { scope })) errors.push(`${where}: ${e}`);
    if (isObj(rule) && isPosInt(rule.id)) {
      if (ids.has(rule.id)) errors.push(`${where}: duplicate id`);
      ids.add(rule.id);
    }
    if (isObj(rule) && isObj(rule.condition) && "regexFilter" in rule.condition) regexCount++;
  });
  const max = scope === "static" ? LIMITS.GUARANTEED_MINIMUM_STATIC_RULES
    : scope === "session" ? LIMITS.MAX_NUMBER_OF_SESSION_RULES : 30000;
  if (rules.length > max) errors.push(`ruleset has ${rules.length} rules; the ${scope} limit is ${max}`);
  if (regexCount > LIMITS.MAX_NUMBER_OF_REGEX_RULES) {
    errors.push(`ruleset has ${regexCount} regex rules; the limit is ${LIMITS.MAX_NUMBER_OF_REGEX_RULES}`);
  }
  return errors;
}

/**
 * Validate manifest.declarative_net_request.rule_resources.
 * @param {object} manifest parsed manifest.json
 * @param {(path: string) => boolean} fileExists
 * @returns {string[]}
 */
export function validateRuleResources(manifest, fileExists) {
  const dnr = manifest && manifest.declarative_net_request;
  const list = dnr && dnr.rule_resources;
  if (!Array.isArray(list)) return ["manifest.declarative_net_request.rule_resources must be an array"];
  const errors = [];
  const ids = new Set();
  let enabled = 0;
  for (const r of list) {
    if (!isObj(r) || typeof r.id !== "string" || !r.id) { errors.push("rule resource needs a non-empty string id"); continue; }
    if (r.id.startsWith("_")) errors.push(`ruleset id "${r.id}" starts with "_", which is reserved`);
    if (ids.has(r.id)) errors.push(`duplicate ruleset id "${r.id}"`);
    ids.add(r.id);
    if (typeof r.enabled !== "boolean") errors.push(`ruleset "${r.id}" needs a boolean "enabled"`);
    if (r.enabled) enabled++;
    if (typeof r.path !== "string" || !fileExists(r.path)) errors.push(`ruleset "${r.id}" path "${r.path}" does not exist`);
  }
  if (list.length > LIMITS.MAX_NUMBER_OF_STATIC_RULESETS) errors.push("too many static rulesets");
  if (enabled > LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) errors.push("too many enabled static rulesets");
  return errors;
}

/* -------------------------------- matching -------------------------------- */

const SEPARATOR = "(?:[^A-Za-z0-9_\\-.%]|$)";
// Domain-name anchor ("||"): the pattern starts at the beginning of the host
// or right after a "." inside it.
const DOMAIN_ANCHOR = "^[a-z][a-z0-9+.-]*:(?://)?(?:[^/?#@]*@)?(?:[^/?#]*\\.)?";

/**
 * Compile a DNR urlFilter into an equivalent JS RegExp, following the parser
 * in indexed_rule.cc: an optional left anchor ("|" or "||"), the pattern
 * ("*" wildcard, "^" separator, everything else literal), then an optional
 * right anchor ("|" as the last character).
 * @param {string} filter
 * @param {boolean} [caseSensitive=false] DNR default is case-insensitive.
 * @returns {RegExp}
 */
export function compileUrlFilter(filter, caseSensitive = false) {
  let i = 0;
  let end = filter.length;
  let prefix = "";
  if (filter.startsWith("||")) { prefix = DOMAIN_ANCHOR; i = 2; }
  else if (filter.startsWith("|")) { prefix = "^"; i = 1; }
  let suffix = "";
  if (end > i && filter[end - 1] === "|" && end - 1 > 0) { suffix = "$"; end -= 1; }
  let body = "";
  for (const ch of filter.slice(i, end)) {
    if (ch === "*") body += ".*";
    else if (ch === "^") body += SEPARATOR;
    else body += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(prefix + body + suffix, caseSensitive ? "" : "i");
}

const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au", "co.jp", "ne.jp", "or.jp",
  "co.in", "com.br", "com.cn", "co.nz", "co.za", "com.mx", "com.tr",
  "github.io", "blogspot.com", "appspot.com", "herokuapp.com",
  "vercel.app", "netlify.app", "pages.dev"
]);

/** Approximate registrable domain (eTLD+1). See the file header. */
export function registrableDomain(host) {
  const labels = String(host).toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function domainListMatches(host, list) {
  if (!host) return false;
  return list.some((d) => {
    const dl = d.toLowerCase();
    return host === dl || host.endsWith("." + dl);
  });
}

/**
 * Whether a rule's condition matches a request.
 * @param {object} cond rule.condition
 * @param {{url: string, type: string, initiator?: string, method?: string, tabId?: number}} req
 *   `initiator` is the origin of the frame that made the request; omit it for
 *   browser-initiated navigations.
 */
export function matchesCondition(cond, req) {
  const href = new URL(req.url).href;
  if (typeof cond.urlFilter === "string" &&
      !compileUrlFilter(cond.urlFilter, cond.isUrlFilterCaseSensitive === true).test(href)) return false;
  if (typeof cond.regexFilter === "string" &&
      !new RegExp(cond.regexFilter, cond.isUrlFilterCaseSensitive === true ? "" : "i").test(href)) return false;

  const reqHost = hostOf(req.url);
  const initHost = req.initiator ? hostOf(req.initiator) : null;

  if (cond.requestDomains && !domainListMatches(reqHost, cond.requestDomains)) return false;
  if (cond.excludedRequestDomains && domainListMatches(reqHost, cond.excludedRequestDomains)) return false;
  if (cond.initiatorDomains && !domainListMatches(initHost, cond.initiatorDomains)) return false;
  if (cond.excludedInitiatorDomains && domainListMatches(initHost, cond.excludedInitiatorDomains)) return false;

  if (cond.resourceTypes) {
    if (!cond.resourceTypes.includes(req.type)) return false;
  } else if (cond.excludedResourceTypes) {
    if (cond.excludedResourceTypes.includes(req.type)) return false;
  } else if (req.type === "main_frame") {
    return false; // Default: every resource type except main_frame.
  }

  const method = req.method || "get";
  if (cond.requestMethods && !cond.requestMethods.includes(method)) return false;
  if (cond.excludedRequestMethods && cond.excludedRequestMethods.includes(method)) return false;

  if (cond.domainType) {
    // No initiator (e.g. typed navigation) counts as first party.
    const third = initHost !== null && registrableDomain(initHost) !== registrableDomain(reqHost);
    if ((cond.domainType === "thirdParty") !== third) return false;
  }

  if (cond.tabIds && !cond.tabIds.includes(req.tabId)) return false;
  if (cond.excludedTabIds && cond.excludedTabIds.includes(req.tabId)) return false;
  return true;
}

const rank = (rule) => [rule.priority || 1, ACTION_TYPE_PRIORITY[rule.action.type]];
const outranks = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];

/**
 * Decide what DNR does with a request, given the extension's enabled rules.
 *
 * `frames` lists the document requests of the frames the request belongs to,
 * top-level first (e.g. [{url: "https://site.example/", type: "main_frame"}]).
 * allowAllRequests rules matched by any of those frame requests, or by the
 * request itself if it is a frame, allow everything in that frame tree that is
 * not outranked by a higher-priority rule.
 *
 * @param {Array<{id: string, rules: object[]}>} rulesets
 * @param {{url: string, type: string, initiator?: string, method?: string,
 *          frames?: Array<{url: string, type: string, initiator?: string}>}} request
 * @returns {{action: string, rulesetId?: string, ruleId?: number}}
 */
export function evaluateRequest(rulesets, request) {
  let best = null;
  const consider = (rulesetId, rule, onlyType) => {
    if (onlyType && rule.action.type !== onlyType) return;
    if (!onlyType && rule.action.type === "allowAllRequests" &&
        request.type !== "main_frame" && request.type !== "sub_frame") return;
    const r = rank(rule);
    if (!best || outranks(r, best.rank)) best = { rank: r, rulesetId, rule };
  };

  for (const frame of request.frames || []) {
    for (const rs of rulesets) {
      for (const rule of rs.rules) {
        if (rule.action.type === "allowAllRequests" && matchesCondition(rule.condition, frame)) {
          consider(rs.id, rule, "allowAllRequests");
        }
      }
    }
  }
  for (const rs of rulesets) {
    for (const rule of rs.rules) {
      if (matchesCondition(rule.condition, request)) consider(rs.id, rule, null);
    }
  }
  if (!best) return { action: "none" };
  return { action: best.rule.action.type, rulesetId: best.rulesetId, ruleId: best.rule.id };
}

/** Convenience: true if `evaluateRequest` ends in a block. */
export function isBlocked(rulesets, request) {
  return evaluateRequest(rulesets, request).action === "block";
}
