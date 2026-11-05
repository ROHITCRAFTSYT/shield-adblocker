/*
 * Packaging tests: manifest gates, file collection, and the ZIP writer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_PERMISSIONS, buildPackage, checkManifest, collectFiles } from "../scripts/package.mjs";
import { createZip, crc32, readZip } from "../scripts/lib/zip.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------- the real build ---------------------------- */

test("the repo packages cleanly with exactly the runtime files", () => {
  const { files, zip } = buildPackage({ write: false });
  assert.equal(files[0], "manifest.json");
  for (const must of ["manifest.json", "LICENSE", "rules/network-rules.json", "src/background.js",
    "src/lib/policy.js", "src/lib/hosts.js", "src/lib/client.js", "src/popup/popup.html",
    "src/options/options.html", "src/content/cosmetic.js", "icons/icon128.png"]) {
    assert.ok(files.includes(must), `missing ${must}`);
  }
  for (const f of files) {
    assert.ok(!/^(test|scripts|docs|e2e|node_modules|\.github)\//.test(f), `dev file shipped: ${f}`);
    assert.notEqual(f, "rules/ad-domains.txt", "the blocklist source is not shipped");
    assert.notEqual(f, "package.json");
  }
  // The archive holds exactly those files, byte for byte.
  const entries = readZip(zip);
  assert.deepEqual([...entries.keys()].sort(), files.slice().sort());
  for (const [name, data] of entries) assert.ok(data.equals(readFileSync(join(ROOT, ...name.split("/")))), name);
});

test("the build is deterministic", () => {
  const a = buildPackage({ write: false });
  const b = buildPackage({ write: false });
  assert.equal(a.sha256, b.sha256);
});

test("the shipped permission set is the minimal one", () => {
  assert.deepEqual(EXPECTED_PERMISSIONS.slice().sort(), ["activeTab", "declarativeNetRequest", "storage"]);
  assert.deepEqual(MANIFEST.permissions.slice().sort(), EXPECTED_PERMISSIONS.slice().sort());
  assert.equal(MANIFEST.host_permissions, undefined);
});

/* ------------------------------- manifest gates ---------------------------- */

const problems = (mutate) => {
  const m = clone(MANIFEST);
  mutate(m);
  return checkManifest(m, PKG).join("\n");
};

test("checkManifest passes the real manifest", () => {
  assert.deepEqual(checkManifest(MANIFEST, PKG), []);
});

test("checkManifest rejects permission creep", () => {
  assert.match(problems((m) => m.permissions.push("tabs")), /permissions .* != expected/);
  assert.match(problems((m) => { m.permissions = m.permissions.filter((p) => p !== "storage"); }), /!= expected/);
  assert.match(problems((m) => { m.host_permissions = ["<all_urls>"]; }), /host_permissions must be empty/);
  assert.match(problems((m) => { m.optional_permissions = ["scripting"]; }), /optional_permissions must be empty/);
  assert.match(problems((m) => { m.externally_connectable = { matches: ["https://*/*"] }; }), /externally_connectable/);
  assert.match(problems((m) => { m.web_accessible_resources = []; }), /web_accessible_resources/);
});

test("checkManifest rejects a weakened CSP", () => {
  assert.match(problems((m) => { m.content_security_policy.extension_pages = "script-src 'self' 'unsafe-eval'"; }), /CSP/);
  assert.match(problems((m) => { m.content_security_policy.extension_pages = "script-src 'self' https://cdn.example"; }), /CSP/);
  assert.match(problems((m) => { delete m.content_security_policy; }), /CSP/);
});

test("checkManifest enforces version format, version sync and store length limits", () => {
  assert.match(problems((m) => { m.version = "1.1"; }), /!= package\.json version/);
  assert.match(problems((m) => { m.version = "1.01.0"; }), /no leading zeros/);
  assert.match(problems((m) => { m.version = "1.2.3.4.5"; }), /1-4 dot-separated/);
  assert.match(problems((m) => { m.version = "70000.0.0"; }), /0-65535/);
  assert.match(problems((m) => { m.description = "x".repeat(133); }), /133 chars; the store allows 132/);
  assert.match(problems((m) => { m.manifest_version = 2; }), /manifest_version must be 3/);
  assert.match(problems((m) => { delete m.icons["128"]; }), /128px icon/);
});

/* ------------------------------- file collection --------------------------- */

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shield-pkg-"));
  for (const p of ["manifest.json", "package.json", "LICENSE", "src", "rules", "icons"]) {
    cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  }
  return dir;
}

test("collectFiles flags stray files, missing references, inline scripts and remote code", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "src/lib/unused.js"), "export const x = 1;\n");
    let { errors } = collectFiles(dir, MANIFEST);
    assert.match(errors.join("\n"), /src\/lib\/unused\.js is not referenced/);
    rmSync(join(dir, "src/lib/unused.js"));

    const popup = join(dir, "src/popup/popup.html");
    const html = readFileSync(popup, "utf8");
    writeFileSync(popup, html.replace("</body>", '<script>alert(1)</script><script src="https://cdn.example/x.js"></script></body>'));
    ({ errors } = collectFiles(dir, MANIFEST));
    assert.match(errors.join("\n"), /inline <script>/);
    assert.match(errors.join("\n"), /remote script "https:\/\/cdn\.example\/x\.js"/);
    writeFileSync(popup, html);

    const opts = join(dir, "src/options/options.js");
    const js = readFileSync(opts, "utf8");
    writeFileSync(opts, 'import "./missing.js";\nimport x from "lodash";\n' + js);
    ({ errors } = collectFiles(dir, MANIFEST));
    assert.match(errors.join("\n"), /referenced file is missing: src\/options\/missing\.js/);
    assert.match(errors.join("\n"), /bare import "lodash"/);
    writeFileSync(opts, js);

    ({ errors } = collectFiles(dir, MANIFEST));
    assert.deepEqual(errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPackage refuses to write when a check fails", () => {
  const dir = fixture();
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.permissions.push("tabs");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    assert.throws(() => buildPackage({ root: dir, write: false }), /package checks failed[\s\S]*permissions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------ zip ---------------------------------- */

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("zip round-trips stored and deflated entries in sorted order", () => {
  const files = [
    { name: "b/two.txt", data: Buffer.from("hello ".repeat(200)) }, // deflates
    { name: "a.bin", data: Buffer.from([0, 1, 2, 3]) },             // stored
    { name: "empty.txt", data: Buffer.alloc(0) }
  ];
  const out = readZip(createZip(files));
  assert.deepEqual([...out.keys()], ["a.bin", "b/two.txt", "empty.txt"]);
  for (const f of files) assert.ok(out.get(f.name).equals(f.data), f.name);
});

test("zip refuses unsafe or duplicate entry names", () => {
  for (const name of ["../evil", "/abs", "a\\b", "a/../../b"]) {
    assert.throws(() => createZip([{ name, data: Buffer.from("x") }]), /unsafe zip entry/, name);
  }
  assert.throws(() => createZip([{ name: "a", data: Buffer.from("1") }, { name: "a", data: Buffer.from("2") }]), /duplicate/);
});

test("readZip detects corruption", () => {
  const zip = createZip([{ name: "a.txt", data: Buffer.from("stored!") }]);
  const bad = Buffer.from(zip);
  bad[30 + "a.txt".length] ^= 0xff; // flip a byte of the stored data
  assert.throws(() => readZip(bad), /CRC mismatch/);
  assert.throws(() => readZip(Buffer.from("not a zip at all, definitely")), /not a zip/);
});
