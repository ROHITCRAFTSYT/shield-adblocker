# Changelog

All notable changes to Shield AdBlocker are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — Unreleased

### Added
- **Settings page** (`src/options/`): master switch, rule and allowlist
  counts, and an allowlist editor. You can add a site by domain or by pasting
  any page URL (unicode domains are converted to punycode), remove sites,
  clear all with a two-step confirm, filter long lists, and bulk import or
  export one site per line. It keyboard-navigates and announces status to
  screen readers.
- Popup: **settings →** link; a **Reload** prompt after allowlist or
  master-switch changes; the version comes from the manifest; the real rule
  count replaces the hard-coded "180+".
- `npm run package`: a deterministic store ZIP plus a SHA-256 file. It
  refuses to build on permission creep, host permissions, a weakened CSP,
  missing or remote files, inline scripts, stray unreferenced files, or a
  version mismatch.
- DNR validator and matcher (`scripts/lib/dnr.mjs`), modelled on Chromium's
  rule parser, with tests that pin real tracker URLs as blocked and ordinary
  URLs as allowed.
- End-to-end test (`npm run test:e2e`) that loads the packaged ZIP into
  Chromium.
- CI: lint, tests on Node 22 and 24, package + e2e, and the ZIP uploaded as
  an artifact. Actions are pinned to current SHAs (checkout v7.0.1,
  setup-node v7.1.0, upload-artifact v7.0.2).
- Store listing copy, privacy-tab answers, screenshots and a promo tile
  (`docs/store-listing.md`, `docs/store/`).

### Changed
- Permissions reduced to `declarativeNetRequest`, `storage`, `activeTab`.
  Removed `scripting` (unused), `declarativeNetRequestFeedback` (the
  blocked-count call works with `activeTab`), and
  `host_permissions: <all_urls>`. The content script now matches only
  `http`/`https` pages.
- The allowlist compiles to one `allowAllRequests` rule on the main frame,
  replacing one `allow` rule per site keyed on `initiatorDomains`.
- The service worker is an ES module. Its logic is in `src/lib/`, shared
  with the pages and unit-tested.
- Node 22+ for tooling. CI previously ran on Node 20, which is end-of-life.
- **Requires Chrome 140** (`minimum_chrome_version` was 102). Chromium 140
  is the first version where `storage.local.setAccessLevel` works; before
  that it only accepted `session`. `npm run package` refuses a lower value.
- The cosmetic content script no longer reads `chrome.storage`. It hides at
  `document_start`, asks the worker with a read-only `getCosmeticState`
  message, and un-hides if filtering is off or the site is allowlisted.
  Open tabs update live from a ping the worker sends on every settings
  change, and pages restored from the back/forward cache ask again.

### Fixed
- **Allowlisting missed requests made inside third-party iframes** on the
  allowlisted page.
- **Blocked counter counted allowed requests**: matches of the allowlist rule
  were counted as blocks.
- Turning off **Allow this site** on `news.example.com` did nothing when the
  entry was `example.com`. The popup now removes the entry that covers the
  page and says "Paused via example.com".
- **Race in rule syncing**: overlapping reconciles could leave the DNR rules
  out of step with the saved settings.
- **`bing.com/bat` never matched Microsoft UET**, which loads from
  `bat.bing.com`. Replaced with `bat.bing.com`.
- Removed `pagead2.googlesyndication.com` and `px.ads.linkedin.com`, which
  their parent entries already covered. The list is now 187 rules.
- Sites on IDN (punycode) TLDs such as `.рф` could not be allowlisted.
- **One invalid cosmetic selector disabled all cosmetic filtering**: the
  selectors shared one CSS rule. There is now one rule per selector.
- Iframes on an allowlisted site were still cosmetically filtered. The
  worker now decides by the top-level site (the tab's URL).
- **Ads could flash at page load**: the hiding CSS waited for an
  asynchronous storage read, and the page could render an ad before it
  arrived. The CSS now goes in synchronously at `document_start`.

### Security
- The message sender check is now an exact `chrome-extension://<id>/` prefix
  match on `sender.url`. The `!sender.tab` check would have rejected the
  options page.
- ESLint forbids `innerHTML`, `outerHTML`, `insertAdjacentHTML` and
  `document.write`.
- **Content scripts can no longer read or change the settings.** By
  Chromium's default, content scripts can read and write
  `chrome.storage.local`, so a compromised content script could switch
  blocking off or allowlist sites without going through the validated message
  handler. 1.0.0's SECURITY.md wrongly said it couldn't. The worker now
  restricts `storage.local` to trusted contexts on every start. Content
  scripts get one read-only message, answered from browser-set sender fields
  with `{ enabled, allowlisted }` for their own site; every other message
  from them is dropped. The e2e test checks this from the content script's
  own isolated world.

## [1.0.0] — 2026-06-20

First public release.

### Added
- **Manifest V3 extension** for Chromium browsers (Chrome, Edge, Brave, Opera).
- **Network-level blocking** via `declarativeNetRequest` — 189 well-known
  ad/tracker networks (Google Ads, DoubleClick, SSPs/exchanges, native-ad and
  content-recommendation networks, pop/push networks, analytics, identity and
  retargeting trackers, social pixels).
- **Cosmetic filtering** content script (isolated world) that collapses ad
  containers — generic selectors plus tuned rules for YouTube, Reddit, LinkedIn,
  X, and Facebook.
- **Per-site allowlist** implemented as high-priority session `allow` rules.
- **Global on/off** toggle.
- **Real per-tab "blocked on this page" counter** via the DNR feedback API.
- **Tactical shield-console popup UI** — monospaced HUD, phosphor-green signal
  color that shifts to amber (off) / blue (site-allowed), pulsing shield emblem,
  fully offline (no remote fonts/assets).
- **Generated blocklist pipeline** — `rules/ad-domains.txt` source compiled by
  `scripts/build-rules.mjs`, validated for sync by `scripts/validate-rules.mjs`.
- **CI**: GitHub Actions `lint` workflow (ESLint + blocklist validation).
- **Docs**: README with screenshot, INSTALL, ARCHITECTURE, SECURITY, PRIVACY,
  CONTRIBUTING.

### Security
- Least-privilege permissions; strict extension CSP.
- No remote code, no `eval`/`new Function`, no `innerHTML` of dynamic data, no
  outbound network requests of its own.
- Service-worker message handler validates sender identity and rejects
  tab/content-script origins; all inputs are type/shape checked and sanitised.
- Zero telemetry; settings stored locally only.

### Known limitations
- Coverage is a curated subset of EasyList, not the full list.
- "Blocks every ad" and "undetectable" are best-effort goals, not guarantees.
- Chromium only; Firefox is not targeted in this release.

[1.1.0]: https://github.com/ROHITCRAFTSYT/shield-adblocker/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ROHITCRAFTSYT/shield-adblocker/releases/tag/v1.0.0
