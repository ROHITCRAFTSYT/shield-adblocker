/*
 * Tests for the shared pure modules the extension itself ships:
 * src/lib/hosts.js and src/lib/policy.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ALLOWLIST,
  findAllowlistEntry,
  hostFromInput,
  pageHost,
  sanitizeAllowlist,
  sanitizeHost
} from "../src/lib/hosts.js";
import { readFileSync } from "node:fs";

import {
  ALLOW_RULE_ID,
  ALLOW_RULE_PRIORITY,
  COSMETIC_CHANGED,
  COSMETIC_QUERY,
  buildAllowRules,
  cosmeticSiteHost,
  cosmeticStateFor,
  countBlocked,
  isContentScriptSender,
  isCosmeticQuery,
  isTrustedSender,
  normalizeState,
  planCommand,
  routeMessage
} from "../src/lib/policy.js";
import { validateRuleset } from "../scripts/lib/dnr.mjs";

/* --------------------------------- hosts ---------------------------------- */

test("sanitizeHost normalises case, whitespace, trailing dot and www.", () => {
  assert.equal(sanitizeHost("  WWW.Example.COM. "), "example.com");
  assert.equal(sanitizeHost("news.example.co.uk"), "news.example.co.uk");
});

test("sanitizeHost accepts punycode TLDs (IDN sites)", () => {
  assert.equal(sanitizeHost("xn--e1afmkfd.xn--p1ai"), "xn--e1afmkfd.xn--p1ai");
});

test("sanitizeHost rejects IPs, localhost, schemes, paths, ports and junk", () => {
  for (const bad of ["192.168.1.1", "localhost", "http://a.com", "a.com/x", "a.com:80",
    "a b.com", "-a.com", "a-.com", "", ".", "com", 42, null, undefined, {}, "a".repeat(64) + ".com"]) {
    assert.equal(sanitizeHost(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("sanitizeHost keeps 'www.com' rather than reducing it to a bare TLD", () => {
  assert.equal(sanitizeHost("www.com"), "www.com");
});

test("sanitizeAllowlist dedupes after normalising, keeps order, caps length", () => {
  assert.deepEqual(sanitizeAllowlist(["b.com", "www.B.com", "a.com", "bad host", 7]), ["b.com", "a.com"]);
  assert.deepEqual(sanitizeAllowlist("a.com"), []);
  const big = Array.from({ length: MAX_ALLOWLIST + 10 }, (_, i) => `s${i}.example`);
  assert.equal(sanitizeAllowlist(big).length, MAX_ALLOWLIST);
});

test("pageHost: http(s) only, www. stripped, everything else null", () => {
  assert.equal(pageHost("https://www.youtube.com/watch?v=1"), "youtube.com");
  assert.equal(pageHost("http://192.168.1.1/admin"), "192.168.1.1");
  for (const u of ["chrome://extensions", "about:blank", "file:///C:/x.html", "chrome-extension://abc/p.html", "nonsense"]) {
    assert.equal(pageHost(u), null, u);
  }
});

test("hostFromInput accepts bare hosts, paths and URLs; converts unicode to punycode", () => {
  assert.equal(hostFromInput("example.com"), "example.com");
  assert.equal(hostFromInput("https://www.example.com/some/path?q=1"), "example.com");
  assert.equal(hostFromInput("example.com/path"), "example.com");
  assert.equal(hostFromInput("пример.рф"), "xn--e1afmkfd.xn--p1ai");
  for (const bad of ["", "   ", "two words.com", "ftp://example.com", "example.com:8080", "user@example.com", "localhost", null]) {
    assert.equal(hostFromInput(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("findAllowlistEntry covers subdomains, never lookalikes", () => {
  const list = ["example.com", "other.org"];
  assert.equal(findAllowlistEntry("example.com", list), "example.com");
  assert.equal(findAllowlistEntry("news.example.com", list), "example.com");
  assert.equal(findAllowlistEntry("evil-example.com", list), null);
  assert.equal(findAllowlistEntry("example.com.evil.test", list), null);
  assert.equal(findAllowlistEntry(null, list), null);
});

/* --------------------------------- policy --------------------------------- */

test("normalizeState falls back to safe defaults", () => {
  assert.deepEqual(normalizeState(undefined), { enabled: true, allowlist: [] });
  assert.deepEqual(normalizeState({ enabled: "no", allowlist: "x" }), { enabled: true, allowlist: [] });
  assert.deepEqual(normalizeState({ enabled: false, allowlist: ["A.com", "a.com"] }), { enabled: false, allowlist: ["a.com"] });
});

test("buildAllowRules emits one valid allowAllRequests session rule", () => {
  const rules = buildAllowRules({ enabled: true, allowlist: ["a.com", "b.org"] });
  assert.equal(rules.length, 1);
  const [r] = rules;
  assert.equal(r.id, ALLOW_RULE_ID);
  assert.equal(r.priority, ALLOW_RULE_PRIORITY);
  assert.ok(r.priority > 1, "must outrank the static block rules");
  assert.deepEqual(r.action, { type: "allowAllRequests" });
  assert.deepEqual(r.condition, { requestDomains: ["a.com", "b.org"], resourceTypes: ["main_frame"] });
  assert.deepEqual(validateRuleset(rules, { scope: "session" }), []);
});

test("buildAllowRules re-sanitises its input", () => {
  const [r] = buildAllowRules({ enabled: true, allowlist: ["WWW.A.com", "not a host"] });
  assert.deepEqual(r.condition.requestDomains, ["a.com"]);
});

test("countBlocked counts only static-ruleset matches, not allowlist matches", () => {
  const details = {
    rulesMatchedInfo: [
      { rule: { ruleId: 1, rulesetId: "ad_block_rules" } },
      { rule: { ruleId: 2, rulesetId: "ad_block_rules" } },
      { rule: { ruleId: ALLOW_RULE_ID, rulesetId: "_session" } }
    ]
  };
  assert.equal(countBlocked(details), 2);
  assert.equal(countBlocked(undefined), 0);
  assert.equal(countBlocked({ rulesMatchedInfo: [null, {}] }), 0);
});

const RID = "abcdefghijklmnopabcdefghijklmnop";
const EXT = `chrome-extension://${RID}/`;

test("isTrustedSender: popup and options page (even opened in a tab) are trusted", () => {
  assert.equal(isTrustedSender({ id: RID, url: EXT + "src/popup/popup.html" }, RID, EXT), true);
  assert.equal(isTrustedSender({ id: RID, url: EXT + "src/options/options.html", tab: { id: 5 } }, RID, EXT), true);
});

test("isTrustedSender: content scripts, other extensions and malformed senders are not", () => {
  // A content script has our id but reports the web page's URL.
  assert.equal(isTrustedSender({ id: RID, url: "https://evil.test/", tab: { id: 3 } }, RID, EXT), false);
  assert.equal(isTrustedSender({ id: "other", url: "chrome-extension://other/x.html" }, RID, EXT), false);
  assert.equal(isTrustedSender({ id: RID, url: `chrome-extension://${RID}x/p.html` }, RID, EXT), false);
  assert.equal(isTrustedSender({ id: RID }, RID, EXT), false);
  assert.equal(isTrustedSender(undefined, RID, EXT), false);
  assert.equal(isTrustedSender({ id: RID, url: "not a url" }, RID, EXT), false);
  // A base URL without its trailing slash would let "<id>x" pages through.
  assert.equal(isTrustedSender({ id: RID, url: EXT + "p.html" }, RID, EXT.slice(0, -1)), false);
});

const S = (allowlist = [], enabled = true) => ({ enabled, allowlist });

test("planCommand: getState and setEnabled", () => {
  assert.deepEqual(planCommand({ action: "getState" }, S()), { patch: {} });
  assert.deepEqual(planCommand({ action: "setEnabled", value: false }, S()), { patch: { enabled: false } });
  assert.throws(() => planCommand({ action: "setEnabled", value: "false" }, S()), /bad value/);
});

test("planCommand: setAllowed adds and removes, normalising the host", () => {
  assert.deepEqual(planCommand({ action: "setAllowed", host: "WWW.A.com", value: true }, S(["b.com"])),
    { patch: { allowlist: ["b.com", "a.com"] } });
  assert.deepEqual(planCommand({ action: "setAllowed", host: "a.com", value: true }, S(["a.com"])),
    { patch: { allowlist: ["a.com"] } }, "adding twice is idempotent");
  assert.deepEqual(planCommand({ action: "setAllowed", host: "a.com", value: false }, S(["a.com", "b.com"])),
    { patch: { allowlist: ["b.com"] } });
  assert.throws(() => planCommand({ action: "setAllowed", host: "192.168.0.1", value: true }, S()), /bad input/);
  assert.throws(() => planCommand({ action: "setAllowed", host: "a.com" }, S()), /bad input/);
});

test("planCommand: setAllowlist replaces the list, dropping invalid entries", () => {
  assert.deepEqual(planCommand({ action: "setAllowlist", value: ["b.com", "x y", "a.com"] }, S(["z.com"])),
    { patch: { allowlist: ["b.com", "a.com"] } });
  assert.deepEqual(planCommand({ action: "setAllowlist", value: [] }, S(["z.com"])), { patch: { allowlist: [] } });
  assert.throws(() => planCommand({ action: "setAllowlist", value: "a.com" }, S()), /bad value/);
});

test("planCommand: unknown actions and non-objects are rejected", () => {
  assert.throws(() => planCommand({ action: "__proto__" }, S()), /unknown action/);
  assert.throws(() => planCommand({ action: "eval" }, S()), /unknown action/);
  assert.throws(() => planCommand(null, S()), /bad message/);
});

/* ------------------------ content scripts: read-only ----------------------- */

// Senders as Chromium builds them for a content script (the shape the e2e
// probe recorded): our id, the frame's URL, frameId, and the tab.
const CS_TOP = { id: RID, url: "https://news.example.com/a", origin: "https://news.example.com", frameId: 0, tab: { id: 7, url: "https://news.example.com/a" } };
const CS_IFRAME = { id: RID, url: "https://ads.adnet.test/slot", origin: "https://ads.adnet.test", frameId: 12, tab: { id: 7, url: "https://news.example.com/a" } };
const Q = { action: COSMETIC_QUERY };

test("isContentScriptSender: our id from a web page; never one of our own pages", () => {
  assert.equal(isContentScriptSender(CS_TOP, RID, EXT), true);
  assert.equal(isContentScriptSender(CS_IFRAME, RID, EXT), true);
  // The popup and options page are trusted pages, not content scripts.
  assert.equal(isContentScriptSender({ id: RID, url: EXT + "src/popup/popup.html" }, RID, EXT), false);
  assert.equal(isContentScriptSender({ id: RID, url: EXT + "src/options/options.html", tab: { id: 5 } }, RID, EXT), false);
  // Another extension's content script, or no URL at all.
  assert.equal(isContentScriptSender({ ...CS_TOP, id: "other" }, RID, EXT), false);
  assert.equal(isContentScriptSender({ id: RID, frameId: 0 }, RID, EXT), false);
  assert.equal(isContentScriptSender(undefined, RID, EXT), false);
});

test("isCosmeticQuery accepts exactly { action: 'getCosmeticState' }", () => {
  assert.equal(isCosmeticQuery({ action: "getCosmeticState" }), true);
  // Any extra field is rejected: the content script has nothing to say. In
  // particular it cannot nominate the host it wants an answer for.
  assert.equal(isCosmeticQuery({ action: COSMETIC_QUERY, host: "bank.test" }), false);
  assert.equal(isCosmeticQuery({ action: COSMETIC_QUERY, top: "https://bank.test" }), false);
  assert.equal(isCosmeticQuery({ action: COSMETIC_QUERY, value: false }), false);
  for (const bad of [null, undefined, "getCosmeticState", 1, [], [COSMETIC_QUERY], {}, { action: "getState" }, { action: "setEnabled", value: false }]) {
    assert.equal(isCosmeticQuery(bad), false, JSON.stringify(bad));
  }
});

test("routeMessage: content scripts reach only the read-only query, never a command", () => {
  assert.equal(routeMessage(Q, CS_TOP, RID, EXT), "cosmeticQuery");
  assert.equal(routeMessage(Q, CS_IFRAME, RID, EXT), "cosmeticQuery");
  // Every mutating command, and the full-state read, is dropped for content scripts.
  for (const msg of [
    { action: "setEnabled", value: false },
    { action: "setAllowed", host: "evil.test", value: true },
    { action: "setAllowlist", value: ["evil.test"] },
    { action: "getState" },
    { action: COSMETIC_QUERY, value: false },
    null
  ]) {
    assert.equal(routeMessage(msg, CS_TOP, RID, EXT), null, JSON.stringify(msg));
  }
});

test("routeMessage: our pages keep the command path; strangers get nothing", () => {
  const popup = { id: RID, url: EXT + "src/popup/popup.html" };
  assert.equal(routeMessage({ action: "setEnabled", value: false }, popup, RID, EXT), "command");
  // A page sending the content-script query goes to planCommand, which
  // rejects it as an unknown action; it is not answered as a content script.
  assert.equal(routeMessage(Q, popup, RID, EXT), "command");
  assert.throws(() => planCommand(Q, S()), /unknown action/);
  assert.equal(routeMessage({ action: 1 }, popup, RID, EXT), null);
  assert.equal(routeMessage(Q, { ...CS_TOP, id: "other" }, RID, EXT), null);
  assert.equal(routeMessage(Q, { id: "other", url: "chrome-extension://other/p.html" }, RID, EXT), null);
  assert.equal(routeMessage(Q, undefined, RID, EXT), null);
});

test("cosmeticSiteHost uses browser-set fields: frame URL on top, tab URL in iframes", () => {
  assert.equal(cosmeticSiteHost(CS_TOP), "news.example.com");
  // An ad iframe is judged by the page it is on, as the network allowlist is.
  assert.equal(cosmeticSiteHost(CS_IFRAME), "news.example.com");
  // An iframe with no tab URL: the site is unknown, never its own host.
  assert.equal(cosmeticSiteHost({ ...CS_IFRAME, tab: { id: 7 } }), null);
  assert.equal(cosmeticSiteHost({ ...CS_IFRAME, tab: undefined }), null);
  assert.equal(cosmeticSiteHost({ ...CS_IFRAME, frameId: undefined }), "news.example.com", "non-zero/absent frameId = iframe");
  // In the top frame the frame's URL wins even if the tab URL differs.
  assert.equal(cosmeticSiteHost({ ...CS_TOP, tab: { id: 7, url: "https://other.test/" } }), "news.example.com");
  assert.equal(cosmeticSiteHost({ ...CS_TOP, url: "https://www.Example.COM/x" }), "example.com");
  assert.equal(cosmeticSiteHost({ ...CS_TOP, url: "file:///etc/passwd" }), null);
  assert.equal(cosmeticSiteHost({ frameId: 0 }), null);
  assert.equal(cosmeticSiteHost(undefined), null);
});

test("cosmeticStateFor answers two booleans about the sender's own site, nothing else", () => {
  const state = S(["example.com", "other.org"]);
  const top = cosmeticStateFor(CS_TOP, state);
  assert.deepEqual(top, { enabled: true, allowlisted: true }, "subdomain of an entry");
  assert.deepEqual(Object.keys(top).sort(), ["allowlisted", "enabled"], "the allowlist is never sent");
  assert.deepEqual(cosmeticStateFor(CS_IFRAME, state), { enabled: true, allowlisted: true }, "iframe follows the page");
  assert.deepEqual(cosmeticStateFor({ ...CS_TOP, url: "https://evil-example.com/" }, state), { enabled: true, allowlisted: false });
  assert.deepEqual(cosmeticStateFor(CS_TOP, S(["example.com"], false)), { enabled: false, allowlisted: true });
  // An ad host that happens to be allowlisted does not unfilter the page it is on,
  // even when the tab URL is missing (fail closed).
  assert.deepEqual(cosmeticStateFor(CS_IFRAME, S(["adnet.test"])), { enabled: true, allowlisted: false });
  assert.deepEqual(cosmeticStateFor({ ...CS_IFRAME, tab: { id: 7 } }, S(["adnet.test", "example.com"])), { enabled: true, allowlisted: false });
  // IP literals and non-web URLs can never be allowlisted (as in the popup).
  assert.deepEqual(cosmeticStateFor({ ...CS_TOP, url: "http://192.168.1.1/" }, state), { enabled: true, allowlisted: false });
  assert.deepEqual(cosmeticStateFor({ frameId: 0 }, state), { enabled: true, allowlisted: false });
});

test("cosmetic.js uses the same message names as the worker", () => {
  // Content scripts cannot import modules, so the strings are duplicated.
  const src = readFileSync(new URL("../src/content/cosmetic.js", import.meta.url), "utf8");
  assert.match(src, new RegExp(`const QUERY = "${COSMETIC_QUERY}";`));
  assert.match(src, new RegExp(`const CHANGED = "${COSMETIC_CHANGED}";`));
  // And it no longer touches chrome.storage at all.
  assert.doesNotMatch(src, /chrome\.storage\.(local|sync|session|managed|onChanged)\b/);
});
