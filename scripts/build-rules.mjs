/*
 * build-rules.mjs
 * Compiles rules/ad-domains.txt into rules/network-rules.json — a set of
 * declarativeNetRequest "block" rules (third-party only).
 *
 * Usage: node scripts/build-rules.mjs
 *
 * No dependencies; Node 18+ (uses node: imports).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "rules/ad-domains.txt");
const OUT = resolve(ROOT, "rules/network-rules.json");

// Accept a registrable domain optionally followed by a path fragment
// (e.g. "facebook.com/tr"). Path part is kept verbatim in the urlFilter.
const DOMAIN_RE = /^(?=.{1,253}(?:\/|$))([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(\/[\w.\-/]*)?$/;

export function parseDomains(text) {
  const seen = new Set();
  const domains = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const d = line.toLowerCase();
    if (!DOMAIN_RE.test(d)) {
      throw new Error(`Invalid domain entry: "${rawLine}"`);
    }
    if (seen.has(d)) continue; // de-dupe silently
    seen.add(d);
    domains.push(d);
  }
  return domains;
}

export function buildRules(domains) {
  return domains.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: "block" },
    condition: { urlFilter: `||${domain}^`, domainType: "thirdParty" }
  }));
}

function main() {
  const text = readFileSync(SRC, "utf8");
  const domains = parseDomains(text);
  const rules = buildRules(domains);
  writeFileSync(OUT, JSON.stringify(rules, null, 2) + "\n", "utf8");
  console.log(`Built ${rules.length} rules → ${OUT}`);
}

// Only run when executed directly (not when imported by the validator).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
