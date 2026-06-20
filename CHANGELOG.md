# Changelog

All notable changes to Shield AdBlocker are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/ROHITCRAFTSYT/shield-adblocker/releases/tag/v1.0.0
