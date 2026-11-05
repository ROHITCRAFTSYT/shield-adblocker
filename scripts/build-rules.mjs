/*
 * build-rules.mjs
 * Compiles rules/ad-domains.txt into rules/network-rules.json — a set of
 * declarativeNetRequest "block" rules (third-party only).
 *
 * Usage: node scripts/build-rules.mjs
 *
 * Also rewrites the rule count quoted in COUNT_DOCS (see below).
 *
 * No dependencies.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Entries already covered by a broader entry in the same list. "||a.com^"
 * matches a.com and every subdomain and path, so "x.a.com" or "a.com/path"
 * next to "a.com" only spends rule quota. Returns [entry, coveredBy] pairs.
 * @param {string[]} domains output of parseDomains
 * @returns {Array<[string, string]>}
 */
export function findRedundantEntries(domains) {
  const bare = new Set(domains.filter((d) => !d.includes("/")));
  const out = [];
  for (const d of domains) {
    const slash = d.indexOf("/");
    const host = slash === -1 ? d : d.slice(0, slash);
    // A path entry is covered by its own bare host, or by any parent of it.
    const labels = host.split(".");
    for (let i = slash === -1 ? 1 : 0; i < labels.length - 1; i++) {
      const parent = labels.slice(i).join(".");
      if (bare.has(parent)) {
        out.push([d, parent]);
        break;
      }
    }
  }
  return out;
}

export function buildRules(domains) {
  return domains.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: "block" },
    condition: { urlFilter: `||${domain}^`, domainType: "thirdParty" }
  }));
}

/*
 * Rule count in the docs. Markdown can't compute, so the number is
 * generated: build:rules rewrites it and validate-rules fails CI when it is
 * stale (the same contract as network-rules.json).
 *
 * The count is found by the words that follow it, not by an HTML-comment
 * marker, because one mention sits inside the fenced store description that
 * is copied into the dashboard verbatim, where a marker would be pasted too.
 * Write it as "<N> well-known ad and tracker…" or "<N> common ad and
 * tracker…" ("tracking" also matches).
 */
export const COUNT_DOCS = Object.freeze(["README.md", "docs/store-listing.md"]);
const COUNT_RE = /\b\d+(?= (?:well-known|common) ad and track(?:er|ing)\b)/g;

/** Every rule count quoted in `text`, as numbers. */
export function findRuleCounts(text) {
  return (text.match(COUNT_RE) || []).map(Number);
}

/** `text` with every quoted rule count set to `count`. */
export function syncRuleCounts(text, count) {
  return text.replace(COUNT_RE, String(count));
}

function main() {
  const text = readFileSync(SRC, "utf8");
  const domains = parseDomains(text);
  const rules = buildRules(domains);
  writeFileSync(OUT, JSON.stringify(rules, null, 2) + "\n", "utf8");
  console.log(`Built ${rules.length} rules → ${OUT}`);

  for (const rel of COUNT_DOCS) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf8");
    const after = syncRuleCounts(before, rules.length);
    if (after !== before) {
      writeFileSync(path, after, "utf8");
      console.log(`Updated rule count in ${rel}`);
    }
  }
}

// Only run when executed directly (not when imported by the validator).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
