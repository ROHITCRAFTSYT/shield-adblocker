/*
 * Unit tests for the blocklist compiler (scripts/build-rules.mjs).
 * Uses Node's built-in test runner (node --test) — no dependencies.
 *
 * parseDomains + buildRules are the whole pipeline from ad-domains.txt to the
 * declarativeNetRequest rules the extension ships, so their parsing, de-duping,
 * validation, and rule shape are worth pinning down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDomains, buildRules } from "../scripts/build-rules.mjs";

test("parseDomains skips blank lines and comments", () => {
  const out = parseDomains("# a comment\n\n  \nfacebook.com\n");
  assert.deepEqual(out, ["facebook.com"]);
});

test("parseDomains lowercases and trims entries", () => {
  assert.deepEqual(parseDomains("  DoubleClick.NET  "), ["doubleclick.net"]);
});

test("parseDomains de-dupes silently, preserving first-seen order", () => {
  const out = parseDomains("a.com\nb.com\na.com\n");
  assert.deepEqual(out, ["a.com", "b.com"]);
});

test("parseDomains accepts a domain with a path fragment", () => {
  assert.deepEqual(parseDomains("facebook.com/tr"), ["facebook.com/tr"]);
});

test("parseDomains rejects invalid entries", () => {
  for (const bad of ["not a domain", "http://x.com", "x", "-lead.com", ".com"]) {
    assert.throws(() => parseDomains(bad), /Invalid domain entry/, `should reject: ${bad}`);
  }
});

test("buildRules assigns 1-based sequential ids", () => {
  const rules = buildRules(["a.com", "b.com", "c.com"]);
  assert.deepEqual(rules.map((r) => r.id), [1, 2, 3]);
});

test("buildRules produces third-party block rules with the right urlFilter", () => {
  const [rule] = buildRules(["ads.example.com"]);
  assert.equal(rule.action.type, "block");
  assert.equal(rule.priority, 1);
  assert.equal(rule.condition.urlFilter, "||ads.example.com^");
  assert.equal(rule.condition.domainType, "thirdParty");
});

test("buildRules on an empty list yields no rules", () => {
  assert.deepEqual(buildRules([]), []);
});

test("pipeline is deterministic: same input -> identical rules", () => {
  const txt = "a.com\nb.com\n# skip\nA.COM\n";
  const first = buildRules(parseDomains(txt));
  const second = buildRules(parseDomains(txt));
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
});
