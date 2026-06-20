/*
 * validate-rules.mjs
 * CI guard: verifies rules/network-rules.json is valid AND in sync with the
 * source rules/ad-domains.txt. Exits non-zero on any problem.
 *
 * Usage: node scripts/validate-rules.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseDomains, buildRules } from "./build-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function fail(msg) {
  console.error("✗ " + msg);
  process.exitCode = 1;
}

const txt = readFileSync(resolve(ROOT, "rules/ad-domains.txt"), "utf8");
const json = readFileSync(resolve(ROOT, "rules/network-rules.json"), "utf8");

let rules;
try {
  rules = JSON.parse(json);
} catch (e) {
  fail("network-rules.json is not valid JSON: " + e.message);
  process.exit(1);
}

if (!Array.isArray(rules)) fail("network-rules.json must be an array");

// Unique, in-range ids; required shape.
const ids = new Set();
for (const r of rules) {
  if (typeof r.id !== "number" || r.id < 1 || r.id > 999999) fail(`bad id: ${r && r.id}`);
  if (ids.has(r.id)) fail(`duplicate id: ${r.id}`);
  ids.add(r.id);
  if (!r.action || r.action.type !== "block") fail(`rule ${r.id} is not a block rule`);
  if (!r.condition || typeof r.condition.urlFilter !== "string") fail(`rule ${r.id} has no urlFilter`);
}

// In-sync check: regenerating from the txt must reproduce the committed JSON.
const expected = buildRules(parseDomains(txt));
if (JSON.stringify(expected) !== JSON.stringify(rules)) {
  fail("network-rules.json is out of sync with ad-domains.txt — run `npm run build:rules`");
}

if (process.exitCode) {
  console.error("Validation FAILED");
} else {
  console.log(`✓ ${rules.length} rules valid and in sync`);
}
