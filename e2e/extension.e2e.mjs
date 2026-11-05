/*
 * extension.e2e.mjs — load the PACKAGED extension into real Chromium and check
 * that it does what it claims: network blocking, cosmetic hiding (in place
 * before the page parses, and following the top-level site into iframes),
 * the allowlist, the master switch, live updates to tabs that are already
 * open, the exact permission set, that the popup and options page render
 * without errors, and that code running in the content script's isolated
 * world can neither read nor change the saved settings.
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
const EXT_NAME = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).name;
// The inline scripts are the page's own JS. The first records when the
// content script's <style> is removed (an allowlisted or switched-off page
// un-hides its ad slots), as ms since navigation start. The second runs while
// the parser is still on the ad element, so it sees whether the ad was ever
// visible: with the CSS injected at document_start it is already hidden.
const PAGE = `<!doctype html><html><head><title>News</title>
<script>new MutationObserver(function (ms) { for (const m of ms) for (const n of m.removedNodes) if (n.nodeName === "STYLE") window.__unhiddenAt = performance.now(); }).observe(document, { childList: true, subtree: true });</script>
<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
</head><body>
<h1 id="headline">Real content</h1>
<ins class="adsbygoogle" id="ad1" style="display:block;width:300px;height:250px">AD</ins>
<script>window.__early = getComputedStyle(document.getElementById("ad1")).display;</script>
<div id="div-gpt-ad-123" style="width:300px;height:250px">GPT AD</div>
<img src="https://www.google-analytics.com/collect?v=1" id="px">
<script src="/app.js"></script>
</body></html>`;
// /framed embeds an ad iframe from the OTHER test host (cross-site, so it is
// an out-of-process iframe with its own content script).
const FRAMED = (adHost) => `<!doctype html><html><head><title>Framed</title></head><body>
<h1>Page with a third-party ad frame</h1>
<iframe src="http://${adHost}/adframe" width="320" height="270"></iframe>
</body></html>`;
const ADFRAME = `<!doctype html><html><body>
<ins class="adsbygoogle" id="fad" style="display:block;width:300px;height:250px">AD</ins>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/app.js")) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("window.__app=1;"); }
  res.writeHead(200, { "content-type": "text/html" });
  if (req.url.startsWith("/adframe")) return res.end(ADFRAME);
  if (req.url.startsWith("/framed")) {
    const [name, port] = String(req.headers.host).split(":");
    return res.end(FRAMED(`${name === "site.test" ? "other.test" : "site.test"}:${port}`));
  }
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

    const settings = () => sw.evaluate(() => chrome.storage.local.get(["enabled", "allowlist"]));
    const display = (frameOrPage, id) => frameOrPage.evaluate((i) => getComputedStyle(document.getElementById(i)).display, id);
    // Wait (up to 5 s) for an element in an OPEN page to reach a display state
    // without reloading: that is what proves live updates.
    async function becomes(frameOrPage, id, wantHidden) {
      try {
        await frameOrPage.waitForFunction(
          ([i, hidden]) => (getComputedStyle(document.getElementById(i)).display === "none") === hidden,
          [id, wantHidden], { timeout: 5000 });
        return true;
      } catch (_) {
        return false;
      }
    }

    async function visit(host, path = "/") {
      const page = await ctx.newPage();
      const failed = [];
      page.on("requestfailed", (r) => failed.push({ url: r.url(), err: r.failure() && r.failure().errorText }));
      page.on("pageerror", (e) => errors.push(`${host}: ${e.message}`));
      await page.goto(`http://${host}:${port}${path}`, { waitUntil: "load" });
      await page.waitForTimeout(400);
      if (path !== "/") return { page, failed };
      const ad = await page.evaluate(() => ({
        ins: getComputedStyle(document.getElementById("ad1")).display,
        gpt: getComputedStyle(document.getElementById("div-gpt-ad-123")).display,
        headline: getComputedStyle(document.getElementById("headline")).display,
        app: window.__app === 1,
        early: window.__early,
        unhiddenAt: window.__unhiddenAt
      }));
      return { page, failed, ad };
    }
    const blockedBy = (failed, needle) => failed.some((f) => f.url.includes(needle) && f.err === "net::ERR_BLOCKED_BY_CLIENT");
    const adFrame = (page) => page.frames().find((f) => f.url().includes("/adframe"));

    // Run code inside the extension's content-script isolated world on a
    // page, through CDP: the same JS context, and the same chrome.* bindings,
    // as cosmetic.js. This stands in for a content script whose world a
    // hostile page has compromised.
    async function contentScriptWorld(page) {
      const cdp = await ctx.newCDPSession(page);
      const contexts = [];
      cdp.on("Runtime.executionContextCreated", (e) => contexts.push(e.context));
      await cdp.send("Runtime.enable"); // reports existing contexts first
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const world = contexts.find((c) => c.auxData && c.auxData.frameId === frameTree.frame.id &&
        c.name === EXT_NAME && c.origin === `chrome-extension://${extId}`);
      if (!world) throw new Error("content-script world not found: " + JSON.stringify(contexts.map((c) => c.name)));
      return async (expression) => {
        const r = await cdp.send("Runtime.evaluate", { expression, contextId: world.id, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
        return r.result.value;
      };
    }

    // 1. Blocking on a normal site.
    let v = await visit("site.test");
    check("blocks doubleclick script (ERR_BLOCKED_BY_CLIENT)", blockedBy(v.failed, "doubleclick.net"), JSON.stringify(v.failed));
    check("blocks google-analytics pixel", blockedBy(v.failed, "google-analytics.com"));
    check("first-party script still loads", v.ad.app);
    check("cosmetic: ins.adsbygoogle hidden", v.ad.ins === "none", v.ad.ins);
    check("cosmetic: div-gpt-ad hidden", v.ad.gpt === "none", v.ad.gpt);
    check("cosmetic: real content untouched", v.ad.headline === "block", v.ad.headline);
    check("cosmetic: ad already hidden while the page was parsing it (no flash)", v.ad.early === "none", String(v.ad.early));
    await v.page.close();
    v = await visit("site.test", "/framed");
    check("cosmetic: cross-site ad iframe hidden", (await display(adFrame(v.page), "fad")) === "none");
    await v.page.close();

    // 1b. A compromised content script cannot read or change the settings.
    // These two tabs stay open for the live-update checks below.
    const liveSite = (await visit("site.test")).page;
    const liveOther = (await visit("other.test")).page;
    const cs = await contentScriptWorld(liveSite);
    const write = await cs(`(async () => {
      try { await chrome.storage.local.set({ enabled: false, allowlist: ["evil.test"] }); return "wrote"; }
      catch (e) { return "refused: " + e.message; }
    })()`);
    const read = await cs(`(async () => {
      try { return "read " + JSON.stringify(await chrome.storage.local.get(null)); }
      catch (e) { return "refused: " + e.message; }
    })()`);
    const commands = await cs(`Promise.all([
      { action: "setEnabled", value: false },
      { action: "setAllowed", host: "evil.test", value: true },
      { action: "setAllowlist", value: ["evil.test"] },
      { action: "getState" },
      { action: "getCosmeticState", host: "site.test" }
    ].map((m) => chrome.runtime.sendMessage(m).then((r) => r === undefined ? "no reply" : JSON.stringify(r), () => "no reply")))`);
    const answer = await cs(`chrome.runtime.sendMessage({ action: "getCosmeticState" })`);
    const spy = await cs(`(() => {
      globalThis.__sabChanges = 0;
      try { chrome.storage.onChanged.addListener(() => { globalThis.__sabChanges++; }); return "listening"; }
      catch (e) { return "no onChanged: " + e.message; }
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const after = await settings();
    check("content script: storage.local write refused", write !== "wrote", write);
    check("content script: storage.local read refused (allowlist not exposed)", !read.startsWith("read "), read);
    check("content script: every command dropped without a reply", commands.every((c) => c === "no reply"), JSON.stringify(commands));
    check("content script: settings unchanged after all of the above",
      after.enabled === true && JSON.stringify(after.allowlist) === "[]", JSON.stringify(after));
    check("content script: blocking still on after all of the above",
      JSON.stringify(await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())) === '["ad_block_rules"]');
    check("content script: read-only query answers exactly { enabled, allowlisted }",
      JSON.stringify(answer) === '{"enabled":true,"allowlisted":false}', JSON.stringify(answer));

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
    check("live: allowlisting un-hides an already-open page of that site", await becomes(liveSite, "ad1", false));
    await new Promise((r) => setTimeout(r, 300));
    check("live: an open page of another site stays filtered", (await display(liveOther, "ad1")) === "none");
    check("content script: receives no storage.onChanged events (allowlist not leaked)",
      spy !== "listening" || (await cs("globalThis.__sabChanges")) === 0, spy);

    // 3. Allowlisted site: nothing blocked, nothing hidden; other site still filtered.
    v = await visit("site.test");
    check("allowlisted: doubleclick NOT blocked by extension", !blockedBy(v.failed, "doubleclick.net"), JSON.stringify(v.failed.map((f) => f.err)));
    check("allowlisted: cosmetic filtering off", v.ad.ins !== "none",
      `${v.ad.ins}; ad slots hidden until ${v.ad.unhiddenAt === undefined ? "?" : Math.round(v.ad.unhiddenAt) + " ms"} after navigation start`);
    await v.page.close();
    v = await visit("site.test", "/framed");
    check("allowlisted: cross-site ad iframe on the page is not filtered either", await becomes(adFrame(v.page), "fad", false));
    await v.page.close();
    v = await visit("other.test");
    check("non-allowlisted site still blocked", blockedBy(v.failed, "doubleclick.net"));
    check("non-allowlisted site still cosmetically filtered", v.ad.ins === "none");
    await v.page.close();
    v = await visit("other.test", "/framed");
    check("an allowlisted site's iframe on a non-allowlisted page is still filtered", (await display(adFrame(v.page), "fad")) === "none");
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
    check("live: master off un-hides an already-open page", await becomes(liveOther, "ad1", false));
    v = await visit("other.test");
    check("master off: nothing blocked", !blockedBy(v.failed, "doubleclick.net"));
    check("master off: cosmetic off", v.ad.ins !== "none");
    await v.page.close();
    if (SHOTS) await opt.screenshot({ path: join(SHOTS, "options-off.png") });
    await opt.click("label.ctl");
    await opt.waitForFunction(() => document.body.dataset.state === "on");
    check("live: master back on re-hides an already-open page", await becomes(liveOther, "ad1", true));
    await new Promise((r) => setTimeout(r, 300));
    check("live: the open allowlisted page stays unfiltered", (await display(liveSite, "ad1")) !== "none");

    // 5. Clear all (two-step).
    await opt.click("#clearBtn");
    await opt.click("#clearBtn");
    await opt.waitForFunction(() => document.querySelectorAll("#allowList li").length === 0);
    check("options: clear-all empties the list", true);
    check("live: clearing the allowlist re-hides the open page", await becomes(liveSite, "ad1", true));
    await liveSite.close();
    await liveOther.close();

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
