/*
 * validate-rules.mjs
 * CI guard for the network blocklist. Exits non-zero if any check fails:
 *
 *  1. rules/network-rules.json parses and passes the DNR schema/limit checks
 *     Chrome applies when it indexes a static ruleset (scripts/lib/dnr.mjs).
 *     Chrome drops invalid static rules with only a warning, so without
 *     this check a broken rule ships silently.
 *  2. Every rule follows this project's policy: a third-party "block" rule of
 *     the form "||domain^", at priority 1.
 *  3. The JSON is in sync with the source list rules/ad-domains.txt.
 *  4. The source list has no entries already covered by a broader entry.
 *  5. The manifest's rule_resources point at real files with valid ids.
 *  6. The rule count quoted in the docs (COUNT_DOCS) matches the ruleset.
 *
 * Usage: node scripts/validate-rules.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { COUNT_DOCS, buildRules, findRedundantEntries, findRuleCounts, parseDomains } from "./build-rules.mjs";
import { validateRuleset, validateRuleResources } from "./lib/dnr.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Project policy for the static ruleset, on top of the DNR schema.
 * @param {object[]} rules
 * @returns {string[]}
 */
export function checkPolicy(rules) {
  const errors = [];
  for (const r of rules) {
    const where = `rule ${r && r.id}`;
    if (!r || !r.action || r.action.type !== "block") errors.push(`${where}: must be a block rule`);
    if (!r || r.priority !== 1) errors.push(`${where}: must have priority 1 (allowlist rules rely on it)`);
    const c = (r && r.condition) || {};
    if (c.domainType !== "thirdParty") errors.push(`${where}: must be third-party only`);
    if (typeof c.urlFilter !== "string" || !/^\|\|[^*|^]+\^$/.test(c.urlFilter)) {
      errors.push(`${where}: urlFilter must look like "||domain^"`);
    }
  }
  return errors;
}

/**
 * Run every check against files under `root`. Returns the list of failures
 * and the parsed rule count.
 * @param {string} root
 */
export function validateProject(root) {
  const errors = [];
  const txt = readFileSync(resolve(root, "rules/ad-domains.txt"), "utf8");
  const json = readFileSync(resolve(root, "rules/network-rules.json"), "utf8");
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));

  let rules;
  try {
    rules = JSON.parse(json);
  } catch (e) {
    return { errors: ["network-rules.json is not valid JSON: " + e.message], count: 0 };
  }

  errors.push(...validateRuleset(rules, { scope: "static" }));
  if (Array.isArray(rules)) errors.push(...checkPolicy(rules));

  let domains = [];
  try {
    domains = parseDomains(txt);
  } catch (e) {
    errors.push("ad-domains.txt: " + e.message);
  }
  for (const [entry, by] of findRedundantEntries(domains)) {
    errors.push(`ad-domains.txt: "${entry}" is already covered by "${by}"; remove it`);
  }
  if (JSON.stringify(buildRules(domains)) !== JSON.stringify(rules)) {
    errors.push("network-rules.json is out of sync with ad-domains.txt; run `npm run build:rules`");
  }

  errors.push(...validateRuleResources(manifest, (p) => existsSync(resolve(root, p))));

  const count = Array.isArray(rules) ? rules.length : 0;
  for (const rel of COUNT_DOCS) {
    const path = resolve(root, rel);
    if (!existsSync(path)) continue; // docs are not part of every checkout (e.g. package fixtures)
    const found = findRuleCounts(readFileSync(path, "utf8"));
    if (found.length === 0) {
      errors.push(`${rel}: no rule count found; quote it as "<N> well-known ad and tracker…", or drop the file from COUNT_DOCS in scripts/build-rules.mjs`);
    }
    for (const n of new Set(found)) {
      if (n !== count) errors.push(`${rel} says ${n} rules but the ruleset has ${count}; run \`npm run build:rules\``);
    }
  }
  return { errors, count };
}

function main() {
  const { errors, count } = validateProject(ROOT);
  if (errors.length) {
    for (const e of errors) console.error("✗ " + e);
    console.error(`Validation FAILED (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${count} rules valid, policy-compliant and in sync`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
