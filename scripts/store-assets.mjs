/*
 * store-assets.mjs — regenerate the Chrome Web Store images in docs/store/
 * from the real extension UI (requires the `playwright` dev dependency and a
 * Chromium build: `npx playwright install chromium`).
 *
 *   node scripts/store-assets.mjs
 *
 * Produces:
 *   docs/store/screenshot-1-options.png  1280x800  settings page
 *   docs/store/screenshot-2-popup.png    1280x800  popup on a caption card
 *   docs/store/promo-small.png            440x280  small promo tile
 *
 * The popup is opened as a tab here, so it cannot see a real website tab or
 * its activeTab grant. For screenshot 2 the active tab and its match count are
 * stubbed (see POPUP_STUB). The UI is real; the numbers on it are
 * illustrative, and docs/store-listing.md says so.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/store");
mkdirSync(OUT, { recursive: true });

const SAMPLE_ALLOWLIST = ["docs.python.org", "news.ycombinator.com", "wikipedia.org", "your-favourite-blog.example"];
const POPUP_STUB = `
  chrome.tabs.query = async () => [{ id: 4242, url: "https://www.example-news.com/world/today" }];
  chrome.declarativeNetRequest.getMatchedRules = async () => ({
    rulesMatchedInfo: Array.from({ length: 27 }, (_, i) => ({ rule: { ruleId: i + 1, rulesetId: "ad_block_rules" }, tabId: 4242 }))
  });
`;

const FONT = `"Cascadia Code","JetBrains Mono",Consolas,ui-monospace,Menlo,monospace`;
const SHIELD_SVG = readFileSync(join(ROOT, "src/popup/popup.html"), "utf8").match(/<svg[\s\S]*?<\/svg>/)[0];

const card = (inner, w, h) => `<!doctype html><html><head><style>
  *{box-sizing:border-box} html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}
  body{background:radial-gradient(90% 70% at 30% 0%,#0f1a16 0%,#07090a 60%);color:#dfeee6;font-family:${FONT};-webkit-font-smoothing:antialiased}
  .ring{width:100%;height:100%;overflow:visible}.ring-track{fill:none;stroke:rgba(120,150,138,.18);stroke-width:2}
  .ring-arc{fill:none;stroke:#4ff0a3;stroke-width:2.5;stroke-linecap:round;stroke-dasharray:70 256;transform-origin:60px 60px;transform:rotate(-40deg);filter:drop-shadow(0 0 4px rgba(79,240,163,.45))}
  .ring-shield{fill:rgba(79,240,163,.16);stroke:#4ff0a3;stroke-width:2;stroke-linejoin:round;filter:drop-shadow(0 0 5px rgba(79,240,163,.45))}
  .ring-check{fill:none;stroke:#4ff0a3;stroke-width:3.4;stroke-linecap:round;stroke-linejoin:round}
  .sig{color:#4ff0a3}
</style></head><body>${inner}</body></html>`;

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
});
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;

  // 1. Settings page.
  const opt = await ctx.newPage();
  await opt.setViewportSize({ width: 1280, height: 800 });
  await opt.goto(`chrome-extension://${extId}/src/options/options.html`);
  await opt.evaluate((list) => chrome.runtime.sendMessage({ action: "setAllowlist", value: list }), SAMPLE_ALLOWLIST);
  await opt.reload();
  await opt.waitForFunction(() => document.getElementById("ruleCount").textContent !== "—");
  await opt.screenshot({ path: join(OUT, "screenshot-1-options.png") });
  await opt.evaluate(() => chrome.runtime.sendMessage({ action: "setAllowlist", value: [] }));

  // 2. Popup, captured at 2x and placed on a 1280x800 caption card.
  const pop = await ctx.newPage();
  await pop.addInitScript(POPUP_STUB);
  await pop.setViewportSize({ width: 336, height: 452 });
  await pop.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await pop.waitForFunction(() => document.getElementById("blockedCount").textContent === "27");
  await pop.waitForTimeout(900); // let the entrance animation settle
  const popPng = (await pop.screenshot({ clip: { x: 0, y: 0, width: 336, height: await pop.evaluate(() => document.body.scrollHeight) } })).toString("base64");

  const comp = await ctx.newPage();
  await comp.setViewportSize({ width: 1280, height: 800 });
  await comp.setContent(card(`
    <div style="display:flex;align-items:center;gap:80px;height:100%;padding:0 110px">
      <div style="flex:1">
        <div style="font-size:14px;letter-spacing:.34em;font-weight:700"><span class="sig">◇</span> SHIELD</div>
        <h1 style="font-size:46px;line-height:1.12;margin:26px 0 22px;font-weight:700">Ads stop<br>before they load.</h1>
        <p style="font-size:19px;line-height:1.6;color:#8a9a93;margin:0;max-width:30ch">See what was blocked on every page. Pause it for sites you want to support with one switch.</p>
        <p style="font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#4ff0a3;margin-top:34px">no telemetry · no remote code</p>
      </div>
      <img src="data:image/png;base64,${popPng}" style="width:336px;border-radius:14px;border:1px solid rgba(120,150,138,.25);box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 60px rgba(79,240,163,.08)">
    </div>`, 1280, 800));
  await comp.screenshot({ path: join(OUT, "screenshot-2-popup.png") });

  // 3. Small promo tile.
  await comp.setViewportSize({ width: 440, height: 280 });
  await comp.setContent(card(`
    <div style="display:flex;align-items:center;gap:26px;height:100%;padding:0 34px">
      <div style="width:118px;height:118px;flex:none">${SHIELD_SVG}</div>
      <div>
        <div style="font-size:26px;letter-spacing:.3em;font-weight:700">SHIELD</div>
        <div style="font-size:12px;letter-spacing:.22em;color:#8a9a93;margin-top:4px">ADBLOCKER</div>
        <div style="font-size:15px;line-height:1.45;margin-top:18px">Blocks ads &amp; trackers.<br><span class="sig">Collects nothing.</span></div>
      </div>
    </div>`, 440, 280));
  await comp.screenshot({ path: join(OUT, "promo-small.png") });
  console.log("✓ wrote docs/store/screenshot-1-options.png, screenshot-2-popup.png, promo-small.png");
} finally {
  await ctx.close();
}
