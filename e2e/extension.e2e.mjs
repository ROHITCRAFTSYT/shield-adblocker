/*
 * extension.e2e.mjs — load the PACKAGED extension into real Chromium and check
 * that it does what it claims: network blocking, cosmetic hiding, the
 * allowlist, the master switch, the exact permission set, and that the popup
 * and options page render without errors.
 *
 *   npm run package && npm run test:e2e
 *   npx playwright install chromium   # once, if no Chromium is installed
 *
 * By default it extracts dist/shield-adblocker-<version>.zip into a temp dir
 * and loads that, so the exact artifact that would be uploaded is tested.
 * Pass a directory to load an unpacked tree instead:
 *   node e2e/extension.e2e.mjs .
 * Set E2E_SCREENSHOTS=<dir> to save screenshots of the options page.
 *
 * Test pages are served from 127.0.0.1 under the names site.test and
 * other.test. --host-resolver-rules maps those and makes every other host
 * unresolvable, so nothing touches the real network.
 */
import { chromium } from "playwright";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip } from "../scripts/lib/zip.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.E2E_SCREENSHOTS ? resolve(process.env.E2E_SCREENSHOTS) : null;
const EXPECTED_RULES = JSON.parse(readFileSync(join(ROOT, "rules/network-rules.json"), "utf8")).length;

function unpackBuiltZip() {
  const { version } = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const { name } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const zipPath = join(ROOT, "dist", `${name}-${version}.zip`);
  const dir = mkdtempSync(join(tmpdir(), "shield-e2e-"));
  for (const [entry, data] of readZip(readFileSync(zipPath))) {
    const out = join(dir, ...entry.split("/"));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
  }
  console.log(`loading packaged build ${zipPath}`);
  return dir;
}

const EXT = process.argv[2] ? resolve(process.argv[2]) : unpackBuiltZip();
const cleanup = process.argv[2] ? () => {} : () => rmSync(EXT, { recursive: true, force: true });
const PAGE = `<!doctype html><html><head><title>News</title>
<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
</head><body>
<h1 id="headline">Real content</h1>
<ins class="adsbygoogle" id="ad1" style="display:block;width:300px;height:250px">AD</ins>
<div id="div-gpt-ad-123" style="width:300px;height:250px">GPT AD</div>
<img src="https://www.google-analytics.com/collect?v=1" id="px">
<script src="/app.js"></script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/app.js")) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("window.__app=1;"); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-proxy-server",
      // Every other host fails to resolve, so the test is hermetic: a request
      // the extension lets through ends in ERR_NAME_NOT_RESOLVED instead of
      // reaching a real ad server.
      "--host-resolver-rules=MAP site.test 127.0.0.1, MAP other.test 127.0.0.1, MAP * ~NOTFOUND"
    ]
  });
  const errors = [];
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    check("service worker (ES module) starts", !!extId, sw.url());
    await new Promise((r) => setTimeout(r, 800));

    const rulesets = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
    check("static ruleset enabled after install", JSON.stringify(rulesets) === '["ad_block_rules"]', JSON.stringify(rulesets));
    const perms = await sw.evaluate(() => chrome.permissions.getAll());
    check("granted API permissions are exactly the minimal set",
      JSON.stringify(perms.permissions.sort()) === JSON.stringify(["activeTab", "declarativeNetRequest", "storage"]),
      JSON.stringify(perms));

    async function visit(host) {
      const page = await ctx.newPage();
      const failed = [];
      page.on("requestfailed", (r) => failed.push({ url: r.url(), err: r.failure() && r.failure().errorText }));
      page.on("pageerror", (e) => errors.push(`${host}: ${e.message}`));
      await page.goto(`http://${host}:${port}/`, { waitUntil: "load" });
      await page.waitForTimeout(400);
      const ad = await page.evaluate(() => ({
        ins: getComputedStyle(document.getElementById("ad1")).display,
        gpt: getComputedStyle(document.getElementById("div-gpt-ad-123")).display,
        headline: getComputedStyle(document.getElementById("headline")).display,
        app: window.__app === 1
      }));
      return { page, failed, ad };
    }
    const blockedBy = (failed, needle) => failed.some((f) => f.url.includes(needle) && f.err === "net::ERR_BLOCKED_BY_CLIENT");

    // 1. Blocking on a normal site.
    let v = await visit("site.test");
    check("blocks doubleclick script (ERR_BLOCKED_BY_CLIENT)", blockedBy(v.failed, "doubleclick.net"), JSON.stringify(v.failed));
    check("blocks google-analytics pixel", blockedBy(v.failed, "google-analytics.com"));
    check("first-party script still loads", v.ad.app);
    check("cosmetic: ins.adsbygoogle hidden", v.ad.ins === "none", v.ad.ins);
    check("cosmetic: div-gpt-ad hidden", v.ad.gpt === "none", v.ad.gpt);
    check("cosmetic: real content untouched", v.ad.headline === "block", v.ad.headline);
    await v.page.close();

    // 2. Options page: add site.test via the UI.
    const opt = await ctx.newPage();
    opt.on("pageerror", (e) => errors.push(`options: ${e.message}`));
    opt.on("console", (m) => { if (m.type() === "error") errors.push(`options console: ${m.text()}`); });
    await opt.setViewportSize({ width: 1280, height: 800 });
    await opt.goto(`chrome-extension://${extId}/src/options/options.html`);
    await opt.waitForFunction(() => document.getElementById("ruleCount").textContent !== "—");
    const ruleCount = await opt.textContent("#ruleCount");
    check("options: rule count read from packaged ruleset", ruleCount === String(EXPECTED_RULES), ruleCount);
    await opt.fill("#addInput", "not a site");
    await opt.click("#addForm button[type=submit]");
    check("options: invalid input rejected with message", (await opt.getAttribute("#addInput", "aria-invalid")) === "true");
    await opt.fill("#addInput", "https://www.site.test/some/page");
    await opt.click("#addForm button[type=submit]");
    await opt.waitForSelector("#allowList li");
    const listed = await opt.$$eval("#allowList .host", (n) => n.map((x) => x.textContent));
    check("options: URL normalised and added to allowlist", JSON.stringify(listed) === '["site.test"]', JSON.stringify(listed));
    const session = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    check("worker installed one allowAllRequests session rule",
      session.length === 1 && session[0].action.type === "allowAllRequests" && session[0].condition.requestDomains[0] === "site.test",
      JSON.stringify(session));

    // 3. Allowlisted site: nothing blocked, nothing hidden; other site still filtered.
    v = await visit("site.test");
    check("allowlisted: doubleclick NOT blocked by extension", !blockedBy(v.failed, "doubleclick.net"), JSON.stringify(v.failed.map((f) => f.err)));
    check("allowlisted: cosmetic filtering off", v.ad.ins !== "none", v.ad.ins);
    await v.page.close();
    v = await visit("other.test");
    check("non-allowlisted site still blocked", blockedBy(v.failed, "doubleclick.net"));
    check("non-allowlisted site still cosmetically filtered", v.ad.ins === "none");
    await v.page.close();

    // Screenshot options with a few entries.
    await opt.fill("#addInput", "news.example.org"); await opt.click("#addForm button[type=submit]");
    await opt.fill("#addInput", "docs.python.org"); await opt.click("#addForm button[type=submit]");
    await opt.waitForTimeout(300);
    await opt.evaluate(() => document.activeElement && document.activeElement.blur());
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await opt.screenshot({ path: join(SHOTS, "options.png") }); }

    // 4. Master switch off.
    await opt.click("label.ctl");
    await opt.waitForFunction(() => document.body.dataset.state === "off");
    await new Promise((r) => setTimeout(r, 400));
    const rs2 = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
    check("master off disables the static ruleset", rs2.length === 0, JSON.stringify(rs2));
    v = await visit("other.test");
    check("master off: nothing blocked", !blockedBy(v.failed, "doubleclick.net"));
    check("master off: cosmetic off", v.ad.ins !== "none");
    await v.page.close();
    if (SHOTS) await opt.screenshot({ path: join(SHOTS, "options-off.png") });
    await opt.click("label.ctl");
    await opt.waitForFunction(() => document.body.dataset.state === "on");

    // 5. Clear all (two-step).
    await opt.click("#clearBtn");
    await opt.click("#clearBtn");
    await opt.waitForFunction(() => document.querySelectorAll("#allowList li").length === 0);
    check("options: clear-all empties the list", true);

    // 6. Popup renders (opened as a tab it sees itself as the active tab).
    const pop = await ctx.newPage();
    pop.on("pageerror", (e) => errors.push(`popup: ${e.message}`));
    await pop.setViewportSize({ width: 336, height: 420 });
    await pop.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await pop.waitForFunction(() => document.getElementById("ruleCount").textContent !== "—");
    check("popup: rule count + version rendered",
      (await pop.textContent("#ruleCount")) === String(EXPECTED_RULES) && (await pop.textContent("#ver")).startsWith("v1."),
      `${await pop.textContent("#ruleCount")} ${await pop.textContent("#ver")}`);
    check("popup: internal page is not allowlistable", await pop.isDisabled("#siteToggle"));

    // 7. The page's own JS world gets no channel to the extension (no
    // externally_connectable), so a hostile page cannot message the worker.
    v = await visit("site.test");
    const pageCanMessage = await v.page.evaluate(() => typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.sendMessage));
    check("web page has no runtime.sendMessage to the extension", !pageCanMessage);
    await v.page.close();
  } catch (e) {
    check("e2e run completed", false, e.stack);
  } finally {
    check("no page errors in extension pages", errors.length === 0, errors.join(" | "));
    await ctx.close();
    server.close();
    cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  }
})();
