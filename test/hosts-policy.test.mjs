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
import {
  ALLOW_RULE_ID,
  ALLOW_RULE_PRIORITY,
  buildAllowRules,
  countBlocked,
  isTrustedSender,
  normalizeState,
  planCommand
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
