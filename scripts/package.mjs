/*
 * package.mjs — build the store-ready ZIP (Chrome Web Store / Edge Add-ons).
 *
 *   node scripts/package.mjs            -> dist/shield-adblocker-<version>.zip
 *   node scripts/package.mjs --out DIR
 *
 * Before writing anything it refuses to package a build that would be
 * rejected or would quietly widen the extension's footprint:
 *  - manifest sanity (MV3, version format, version == package.json,
 *    store length limits);
 *  - the permission set is exactly EXPECTED_PERMISSIONS, with no host
 *    permissions, no externally_connectable, and a CSP without unsafe or
 *    remote sources;
 *  - every file the manifest, an HTML page or an ES-module import references
 *    exists, is local, and contains no inline <script>;
 *  - the DNR ruleset passes scripts/validate-rules.mjs;
 *  - nothing under src/ is shipped that nothing references (stray files).
 *
 * The archive contains only what the browser loads, plus LICENSE. It is
 * deterministic (scripts/lib/zip.mjs): the same tree gives the same bytes and
 * SHA-256 on every OS.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { createZip } from "./lib/zip.mjs";
import { validateProject } from "./validate-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Adding a permission is a deliberate act: change this list, and add the
// justification to docs/store-listing.md (the store's reviewers ask for one).
export const EXPECTED_PERMISSIONS = Object.freeze(["activeTab", "declarativeNetRequest", "storage"]);

// Chrome Web Store limits for the listing fields that come from the manifest.
export const MAX_DESCRIPTION = 132;
export const MAX_NAME = 75;

const EXTRA_FILES = ["LICENSE"];

const toPosix = (p) => p.split(sep).join("/");
const isRemote = (u) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(u);

/**
 * Manifest-level checks. Returns a list of problems.
 * @param {object} manifest
 * @param {object} pkg package.json
 */
export function checkManifest(manifest, pkg) {
  const errors = [];
  if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");

  const v = manifest.version;
  if (typeof v !== "string" || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(v) || v.split(".").some((n) => Number(n) > 65535 || (n.length > 1 && n.startsWith("0")))) {
    errors.push(`version "${v}" must be 1-4 dot-separated integers (0-65535, no leading zeros)`);
  }
  if (pkg && v !== pkg.version) errors.push(`manifest version ${v} != package.json version ${pkg.version}`);

  if (typeof manifest.name !== "string" || !manifest.name.trim()) errors.push("name is required");
  else if (manifest.name.length > MAX_NAME) errors.push(`name is ${manifest.name.length} chars; max ${MAX_NAME}`);
  if (typeof manifest.description !== "string" || !manifest.description.trim()) errors.push("description is required");
  else if (manifest.description.length > MAX_DESCRIPTION) {
    errors.push(`description is ${manifest.description.length} chars; the store allows ${MAX_DESCRIPTION}`);
  }

  const perms = Array.isArray(manifest.permissions) ? manifest.permissions.slice().sort() : [];
  if (JSON.stringify(perms) !== JSON.stringify(EXPECTED_PERMISSIONS.slice().sort())) {
    errors.push(`permissions ${JSON.stringify(perms)} != expected ${JSON.stringify(EXPECTED_PERMISSIONS)} (update EXPECTED_PERMISSIONS deliberately)`);
  }
  for (const key of ["host_permissions", "optional_host_permissions", "optional_permissions"]) {
    if (Array.isArray(manifest[key]) && manifest[key].length) errors.push(`${key} must be empty`);
  }
  if ("externally_connectable" in manifest) errors.push("externally_connectable must not be set");
  if ("web_accessible_resources" in manifest) errors.push("web_accessible_resources must not be set (it makes the extension detectable by pages)");

  const csp = manifest.content_security_policy && manifest.content_security_policy.extension_pages;
  if (typeof csp !== "string" || !/script-src 'self'(;|$)/.test(csp)) errors.push("CSP extension_pages must be exactly script-src 'self'");
  else if (/unsafe-|https?:|wasm/.test(csp)) errors.push("CSP must not contain unsafe-*, wasm or remote sources");

  const icons = manifest.icons || {};
  if (!icons["128"]) errors.push("a 128px icon is required by the store");
  return errors;
}

/** Files directly referenced by the manifest. */
export function manifestRefs(m) {
  const refs = new Set();
  const add = (p) => { if (typeof p === "string") refs.add(p); };
  Object.values(m.icons || {}).forEach(add);
  if (m.action) {
    add(m.action.default_popup);
    Object.values(m.action.default_icon || {}).forEach(add);
  }
  if (m.options_ui) add(m.options_ui.page);
  add(m.options_page);
  if (m.background) add(m.background.service_worker);
  for (const cs of m.content_scripts || []) {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  }
  for (const r of (m.declarative_net_request && m.declarative_net_request.rule_resources) || []) add(r.path);
  return refs;
}

const HTML_REF_RE = /<(script|link|img)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
const INLINE_SCRIPT_RE = /<script\b(?![^>]*\ssrc\s*=)[^>]*>\s*\S/i;
const IMPORT_RE = /(?:^|[;\s])(?:import|export)\s(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Walk everything reachable from the manifest: HTML pages -> scripts/styles,
 * JS modules -> imports. Returns { files, errors }.
 * @param {string} root
 * @param {object} manifest
 */
export function collectFiles(root, manifest) {
  const errors = [];
  const files = new Set();
  const queue = [...manifestRefs(manifest)];

  while (queue.length) {
    const rel = posix.normalize(queue.shift());
    if (files.has(rel)) continue;
    if (rel.startsWith("../") || rel.startsWith("/")) { errors.push(`reference escapes the extension root: ${rel}`); continue; }
    const abs = join(root, ...rel.split("/"));
    if (!existsSync(abs) || !statSync(abs).isFile()) { errors.push(`referenced file is missing: ${rel}`); continue; }
    if (rel.split("/").some((seg) => seg.startsWith("_"))) errors.push(`"${rel}": names starting with "_" are reserved by Chrome`);
    files.add(rel);

    const dir = posix.dirname(rel);
    if (rel.endsWith(".html")) {
      const html = readFileSync(abs, "utf8");
      if (INLINE_SCRIPT_RE.test(html)) errors.push(`${rel}: inline <script> is blocked by the CSP`);
      if (/\son[a-z]+\s*=/i.test(html)) errors.push(`${rel}: inline event handlers are blocked by the CSP`);
      for (const [, tag, ref] of html.matchAll(HTML_REF_RE)) {
        if (isRemote(ref)) { errors.push(`${rel}: remote ${tag} "${ref}" is not allowed`); continue; }
        if (ref.startsWith("data:") || ref.startsWith("#")) continue;
        queue.push(posix.join(dir, ref.split(/[?#]/)[0]));
      }
    } else if (rel.endsWith(".js") || rel.endsWith(".mjs")) {
      const src = readFileSync(abs, "utf8");
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] || m[2];
        if (isRemote(spec)) { errors.push(`${rel}: remote import "${spec}" is not allowed`); continue; }
        if (!spec.startsWith(".")) { errors.push(`${rel}: bare import "${spec}" cannot resolve in an extension`); continue; }
        queue.push(posix.join(dir, spec));
      }
    }
  }

  for (const extra of EXTRA_FILES) {
    if (existsSync(join(root, extra))) files.add(extra);
  }

  // Anything in src/ nobody references is dead weight in the package.
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [toPosix(relative(root, join(d, e.name)))]);
  for (const f of walk(join(root, "src"))) {
    if (!files.has(f)) errors.push(`${f} is not referenced by the manifest or any page/module; delete it or wire it up`);
  }

  return { files: [...files].sort(), errors };
}

/**
 * Validate and build the package.
 * @param {{root?: string, outDir?: string, write?: boolean}} [opts]
 */
export function buildPackage({ root = ROOT, outDir = join(root, "dist"), write = true } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const errors = [...checkManifest(manifest, pkg)];
  errors.push(...validateProject(root).errors.map((e) => "rules: " + e));
  const { files, errors: refErrors } = collectFiles(root, manifest);
  errors.push(...refErrors);
  files.unshift("manifest.json");
  if (errors.length) {
    const err = new Error("package checks failed:\n  - " + errors.join("\n  - "));
    err.problems = errors;
    throw err;
  }

  const entries = [...new Set(files)].map((name) => ({ name, data: readFileSync(join(root, ...name.split("/"))) }));
  const zip = createZip(entries);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const name = `${pkg.name}-${manifest.version}.zip`;
  const zipPath = join(outDir, name);
  if (write) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(zipPath, zip);
    writeFileSync(zipPath + ".sha256", `${sha256}  ${name}\n`);
  }
  return { zipPath, sha256, bytes: zip.length, files: entries.map((e) => e.name), zip };
}

function main() {
  const i = process.argv.indexOf("--out");
  const outDir = i !== -1 ? resolve(process.argv[i + 1]) : undefined;
  try {
    const { zipPath, sha256, bytes, files } = buildPackage({ outDir });
    for (const f of files) console.log("  + " + f);
    console.log(`\n✓ ${toPosix(relative(process.cwd(), zipPath))}  (${files.length} files, ${(bytes / 1024).toFixed(1)} KiB)`);
    console.log(`  sha256 ${sha256}`);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
