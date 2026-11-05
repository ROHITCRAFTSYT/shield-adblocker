# Store listing: Chrome Web Store / Edge Add-ons

Copy for the store dashboards, plus the release checklist. The store limits
quoted below come from Google's listing documentation (see
[Sources](#sources)). Recheck them when you submit, because the dashboard
changes.

> Nothing in this repository publishes to a store. Uploading is a manual step
> for the maintainer.

---

## Package

| Field | Value |
| --- | --- |
| File to upload | `dist/shield-adblocker-<version>.zip`, from `npm run package` or the CI artifact `shield-adblocker-zip` |
| Integrity | `dist/shield-adblocker-<version>.zip.sha256`. Builds are deterministic, so a rebuild of the same commit gives the same hash. |
| Contents | `manifest.json` at the root, then `src/`, `rules/network-rules.json`, `icons/` and `LICENSE`. No tests, tooling or docs. |

## Store listing tab

**Name** (from the manifest)

```
Shield AdBlocker
```

**Summary** (from the manifest `description`; the limit is 132 characters, this is 105; the packager enforces the limit)

```
Blocks ads and trackers before they load and hides leftover ad slots. No data collection, no remote code.
```

**Category:** Privacy & Security. If the dashboard doesn't offer it, use the closest match under Tools or Productivity.

**Language:** English

**Description**

```
Shield is a small, private ad and tracker blocker built on Chrome's Manifest V3.

WHAT IT DOES
• Stops requests to 187 well-known ad and tracking services before they load: Google's ad and analytics services, Amazon and Microsoft ad systems, major ad exchanges, content-recommendation widgets, social-media pixels and session-recording tools.
• Hides the empty boxes ads leave behind, with tuned rules for YouTube, Reddit, LinkedIn, X and Facebook.
• Shows how many requests were blocked on the page you're on.
• Lets you pause blocking on any site you want to support, with one switch. Manage the full list on the settings page, and import or export it.
• Turns off completely with one switch. The toolbar badge shows OFF.

PRIVATE BY DESIGN
• No account, no telemetry, no analytics.
• Shield makes no network requests of its own and runs no remote code. Its blocking rules ship inside the extension.
• Your settings (the on/off switch and your allowlist) stay in this browser.
• Blocking is done by Chrome's built-in declarativeNetRequest engine, so the extension never sees the contents of your requests.

PERMISSIONS, EXPLAINED
Chrome will say Shield can "read and change all your data on all websites". That warning comes from the stylesheet Shield adds to pages to hide ad slots. Shield does not read page content, and it cannot run scripts in sites or fetch data from them.

HONEST LIMITS
Shield ships a curated list of common ad and tracker networks, not every filter list on the internet, so it won't catch everything. Some sites can tell that an ad was blocked. If a site breaks, switch on "Allow this site" and report it on GitHub.

Open source (MIT): https://github.com/ROHITCRAFTSYT/shield-adblocker
```

**Graphic assets** (in `docs/store/`; regenerate with `node scripts/store-assets.mjs`)

| Asset | File | Size | Required |
| --- | --- | --- | --- |
| Store icon | `icons/icon128.png` (in the package) | 128×128 | yes |
| Screenshot 1 | `docs/store/screenshot-1-options.png` | 1280×800 | at least one, max 5 |
| Screenshot 2 | `docs/store/screenshot-2-popup.png` | 1280×800 | — |
| Small promo tile | `docs/store/promo-small.png` | 440×280 | yes |
| Marquee promo tile | not provided | 1400×560 | optional |

Screenshot 2 shows the real popup UI. The site name and the "27 blocked"
count are sample values: the script stubs the active tab, because a popup
opened by automation has no real tab to read.

**Official URL / homepage:** `https://github.com/ROHITCRAFTSYT/shield-adblocker`
**Support URL:** `https://github.com/ROHITCRAFTSYT/shield-adblocker/issues`

## Privacy practices tab

**Single purpose**

```
Shield blocks ads and trackers on web pages: it stops known ad and tracking requests with Chrome's declarativeNetRequest API and hides leftover ad placeholders with CSS. Users can pause it globally or for specific sites.
```

**Permission justifications**

| Permission | Justification to paste |
| --- | --- |
| `declarativeNetRequest` | Core function: a bundled static ruleset blocks requests to known third-party ad and tracking domains, and one session rule exempts sites the user has allowlisted. Rules are evaluated by Chrome; the extension does not observe request contents. |
| `storage` | Stores the user's two settings locally: whether blocking is on, and the list of sites the user has allowlisted. Nothing is synced or transmitted. |
| `activeTab` | When the user opens the popup, reads the active tab's URL to show which site they're on and let them allowlist it, and reads how many of the extension's rules matched on that tab to display a blocked-request count. |
| Host access (content script on `http://*/*`, `https://*/*`) | The content script injects a static stylesheet that hides common ad containers on every site. It does not read page content, modify page scripts, or communicate with any server. |

**Remote code:** No. All JavaScript is included in the package. The
extension pages' CSP is `script-src 'self'`, and the packager rejects remote
scripts and imports.

**Data usage:** tick **none** of the data categories. Then certify:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** `https://github.com/ROHITCRAFTSYT/shield-adblocker/blob/main/PRIVACY.md`

## Distribution tab

- Visibility: Public. Unlisted works if you want a soft launch first.
- Regions: all.
- Pricing: free. No in-app purchases.

## Microsoft Edge Add-ons

Upload the same ZIP. Reuse the summary, description and screenshots. Edge asks
for a short description, the privacy policy URL, and "notes for
certification". For those notes, paste:

```
No account or test credentials are needed. To verify: open any news site, click the toolbar icon to see the blocked-request count, toggle "Allow this site" and reload to see blocking paused. Settings: extension options page.
```

## Release checklist

1. Bump `version` in `manifest.json` **and** `package.json`. The packager refuses to build if they differ.
2. Move the `Unreleased` notes in `CHANGELOG.md` under the new version and date.
3. `npm run check && npm run test:e2e`, or merge and let CI run them.
4. Take the ZIP from the CI run of the release commit. Check its hash against the `.sha256` file.
5. If the UI changed, run `node scripts/store-assets.mjs` to regenerate the screenshots.
6. Upload to the Chrome Web Store and Edge Add-ons dashboards, and paste the text above.
7. After approval, tag the commit (`git tag v<version> && git push --tags`) and create a GitHub release with the ZIP attached.

## Sources

- Chrome Web Store, "Complete your listing information": <https://developer.chrome.com/docs/webstore/cws-dashboard-listing>. Summary of 132 characters or fewer; at least one 1280×800 screenshot, up to 5; small promo tile 440×280.
- Chrome Web Store, "Supplying images": <https://developer.chrome.com/docs/webstore/images>. 128×128 icon; marquee tile 1400×560.
- Chrome Web Store, "Fill out the privacy fields": <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>. Single purpose, per-permission justification, remote-code declaration.
- Permission warning strings: Chromium `chrome/app/generated_resources.grd` and `chrome/common/extensions/permissions/chrome_permission_message_rules.cc`. "Read and change all your data on all websites" suppresses the separate "Block content on any page" warning for `declarativeNetRequest`.
