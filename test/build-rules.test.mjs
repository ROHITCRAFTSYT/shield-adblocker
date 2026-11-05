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

import { parseDomains, buildRules, findRedundantEntries, findRuleCounts, syncRuleCounts } from "../scripts/build-rules.mjs";

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

test("findRedundantEntries flags subdomains and paths covered by a broader entry", () => {
  const list = ["a.com", "x.a.com", "deep.x.a.com", "a.com/tr", "b.com/tr", "notb.com", "b.co"];
  assert.deepEqual(findRedundantEntries(list), [
    ["x.a.com", "a.com"],
    ["deep.x.a.com", "x.a.com"], // nearest covering parent is reported
    ["a.com/tr", "a.com"]
  ]);
});

test("findRedundantEntries does not treat lookalike suffixes as parents", () => {
  assert.deepEqual(findRedundantEntries(["ads.com", "badads.com", "x.ads.co"]), []);
});

test("findRuleCounts reads the count only where the phrasing marks it", () => {
  const text = [
    "- Network blocking of 187 well-known ad and tracker endpoints",
    "a curated set of 12 common ad and tracker endpoints",
    "Stops requests to 3 well-known ad and tracking services",
    "Tests pin 19 real tracker URLs; 99 tests pass; 2026 well-known facts"
  ].join("\n");
  assert.deepEqual(findRuleCounts(text), [187, 12, 3]);
  assert.deepEqual(findRuleCounts("no numbers here"), []);
});

test("syncRuleCounts rewrites every marked count and nothing else", () => {
  const text = "Blocks 180 well-known ad and tracker endpoints.\n```\nStops 5 well-known ad and tracking services\n```\nSee 19 real tracker URLs.";
  assert.equal(syncRuleCounts(text, 190),
    "Blocks 190 well-known ad and tracker endpoints.\n```\nStops 190 well-known ad and tracking services\n```\nSee 19 real tracker URLs.");
  assert.equal(syncRuleCounts(text, 190), syncRuleCounts(syncRuleCounts(text, 190), 190), "idempotent");
});
