/*
 * Validation tests: the DNR schema checks in scripts/lib/dnr.mjs, the
 * project policy in scripts/validate-rules.mjs, and the shipped ruleset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { validateRule, validateRuleset, validateRuleResources, LIMITS } from "../scripts/lib/dnr.mjs";
import { checkPolicy, validateProject } from "../scripts/validate-rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = JSON.parse(readFileSync(resolve(ROOT, "rules/network-rules.json"), "utf8"));

const good = () => ({
  id: 1,
  priority: 1,
  action: { type: "block" },
  condition: { urlFilter: "||ads.example^", domainType: "thirdParty" }
});

/** Apply `mutate` to a valid rule and return its validation errors joined. */
function errorsFor(mutate, opts) {
  const r = good();
  mutate(r);
  return validateRule(r, opts).join("\n");
}

test("a well-formed block rule has no errors", () => {
  assert.deepEqual(validateRule(good()), []);
});

test("rejects bad ids and priorities", () => {
  assert.match(errorsFor((r) => { r.id = 0; }), /id must be an integer >= 1/);
  assert.match(errorsFor((r) => { r.id = 1.5; }), /id must be an integer/);
  assert.match(errorsFor((r) => { r.id = "1"; }), /id must be an integer/);
  assert.match(errorsFor((r) => { r.priority = 0; }), /priority must be an integer >= 1/);
});

test("rejects unknown keys at every level (typos never reach Chrome)", () => {
  assert.match(errorsFor((r) => { r.prority = 2; }), /unknown key "prority"/);
  assert.match(errorsFor((r) => { r.condition.urlfilter = "x"; }), /unknown condition key "urlfilter"/);
  assert.match(errorsFor((r) => { r.action.kind = "x"; }), /unknown action key "kind"/);
});

test("rejects unknown action types and missing action payloads", () => {
  assert.match(errorsFor((r) => { r.action.type = "deny"; }), /action\.type "deny" is not one of/);
  assert.match(errorsFor((r) => { r.action.type = "redirect"; }), /redirect rules need action\.redirect/);
  assert.match(errorsFor((r) => { r.action.type = "modifyHeaders"; }), /need requestHeaders or responseHeaders/);
  assert.match(errorsFor((r) => { r.action.redirect = { url: "https://x.example" }; }), /only valid for redirect/);
});

test("urlFilter: empty, non-ASCII, '||*' and urlFilter+regexFilter are rejected", () => {
  assert.match(errorsFor((r) => { r.condition.urlFilter = ""; }), /non-empty string/);
  assert.match(errorsFor((r) => { r.condition.urlFilter = "||пример.рф^"; }), /must be ASCII/);
  assert.match(errorsFor((r) => { r.condition.urlFilter = "||*ads^"; }), /cannot start with "\|\|\*"/);
  assert.match(errorsFor((r) => { r.condition.regexFilter = "ads"; }), /only specify one of/);
});

test("regexFilter must compile", () => {
  const msg = errorsFor((r) => { delete r.condition.urlFilter; r.condition.regexFilter = "ads("; });
  assert.match(msg, /regexFilter does not compile/);
});

test("domain lists: empty include list, non-ASCII and URL-shaped entries are rejected", () => {
  assert.match(errorsFor((r) => { r.condition.initiatorDomains = []; }), /initiatorDomains cannot be an empty list/);
  assert.deepEqual(validateRule({ ...good(), condition: { ...good().condition, excludedRequestDomains: [] } }), []);
  assert.match(errorsFor((r) => { r.condition.requestDomains = ["bücher.example"]; }), /use punycode/);
  assert.match(errorsFor((r) => { r.condition.requestDomains = ["https://a.example"]; }), /bare domain/);
});

test("deprecated 'domains' is rejected in favour of initiatorDomains", () => {
  assert.match(errorsFor((r) => { r.condition.domains = ["a.example"]; }), /deprecated/);
});

test("resource types and methods must be known, non-empty, and not both included and excluded", () => {
  assert.match(errorsFor((r) => { r.condition.resourceTypes = ["scripts"]; }), /unknown value "scripts"/);
  assert.match(errorsFor((r) => { r.condition.resourceTypes = []; }), /cannot be an empty list/);
  assert.match(errorsFor((r) => {
    r.condition.resourceTypes = ["script"];
    r.condition.excludedResourceTypes = ["script"];
  }), /includes and excludes the same resource type/);
  assert.match(errorsFor((r) => { r.condition.requestMethods = ["fetch"]; }), /unknown value "fetch"/);
  assert.match(errorsFor((r) => { r.condition.domainType = "3p"; }), /domainType must be one of/);
});

test("allowAllRequests needs resourceTypes limited to main_frame/sub_frame", () => {
  const aar = (cond) => validateRule({ id: 1, priority: 2, action: { type: "allowAllRequests" }, condition: cond }).join("\n");
  assert.match(aar({ requestDomains: ["a.example"] }), /allowAllRequests rules must set "resourceTypes"/);
  assert.match(aar({ requestDomains: ["a.example"], resourceTypes: ["main_frame", "script"] }), /allowAllRequests/);
  assert.equal(aar({ requestDomains: ["a.example"], resourceTypes: ["main_frame"] }), "");
});

test("tabIds are only allowed on session rules", () => {
  assert.match(errorsFor((r) => { r.condition.tabIds = [1]; }), /only supported for session rules/);
  assert.deepEqual(validateRule({ ...good(), condition: { ...good().condition, tabIds: [1] } }, { scope: "session" }), []);
});

test("validateRuleset catches duplicate ids and points at the rule index", () => {
  const errors = validateRuleset([good(), good()]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^rules\[1\] \(id 1\): duplicate id/);
  assert.deepEqual(validateRuleset({}), ["ruleset must be a JSON array of rules"]);
});

test("validateRuleset enforces the static rule and regex limits", () => {
  const many = Array.from({ length: LIMITS.GUARANTEED_MINIMUM_STATIC_RULES + 1 }, (_, i) => ({ ...good(), id: i + 1 }));
  assert.match(validateRuleset(many).join("\n"), /limit is 30000/);
  const regex = Array.from({ length: LIMITS.MAX_NUMBER_OF_REGEX_RULES + 1 }, (_, i) => ({
    id: i + 1, action: { type: "block" }, condition: { regexFilter: "^https://ads" }
  }));
  assert.match(validateRuleset(regex).join("\n"), /1001 regex rules; the limit is 1000/);
});

test("validateRuleResources checks ids, reserved prefix and paths", () => {
  const manifest = (rr) => ({ declarative_net_request: { rule_resources: rr } });
  const exists = (p) => p === "rules/a.json";
  assert.deepEqual(validateRuleResources(manifest([{ id: "a", enabled: true, path: "rules/a.json" }]), exists), []);
  assert.match(validateRuleResources(manifest([{ id: "_a", enabled: true, path: "rules/a.json" }]), exists).join(), /reserved/);
  assert.match(validateRuleResources(manifest([{ id: "a", enabled: true, path: "rules/missing.json" }]), exists).join(), /does not exist/);
  assert.match(validateRuleResources(manifest([
    { id: "a", enabled: true, path: "rules/a.json" },
    { id: "a", enabled: false, path: "rules/a.json" }
  ]), exists).join(), /duplicate ruleset id/);
});

test("project policy: only third-party '||domain^' block rules at priority 1", () => {
  assert.deepEqual(checkPolicy([good()]), []);
  assert.match(checkPolicy([{ ...good(), action: { type: "allow" } }]).join(), /must be a block rule/);
  assert.match(checkPolicy([{ ...good(), priority: 2 }]).join(), /priority 1/);
  assert.match(checkPolicy([{ ...good(), condition: { urlFilter: "||a.example^" } }]).join(), /third-party/);
  assert.match(checkPolicy([{ ...good(), condition: { urlFilter: "ads", domainType: "thirdParty" } }]).join(), /\|\|domain\^/);
});

test("the shipped ruleset passes schema, policy, sync and manifest checks", () => {
  assert.deepEqual(validateRuleset(SHIPPED), []);
  const { errors, count } = validateProject(ROOT);
  assert.deepEqual(errors, []);
  assert.equal(count, SHIPPED.length);
  assert.ok(count > 100, "expected a non-trivial blocklist");
});

test("a stale or missing rule count in the docs fails validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "shield-count-"));
  try {
    for (const p of ["manifest.json", "rules", "README.md", "docs/store-listing.md"]) {
      cpSync(join(ROOT, p), join(dir, p), { recursive: true });
    }
    assert.deepEqual(validateProject(dir).errors, []);

    const readme = join(dir, "README.md");
    const original = readFileSync(readme, "utf8");
    writeFileSync(readme, original.replace(/\b\d+(?= well-known ad and tracker)/, "999"));
    assert.match(validateProject(dir).errors.join("\n"), /README\.md says 999 rules but the ruleset has \d+; run `npm run build:rules`/);

    writeFileSync(readme, original.replace(/\b\d+ (well-known|common) ad and tracker/g, "many $1 ad and tracker"));
    assert.match(validateProject(dir).errors.join("\n"), /README\.md: no rule count found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
