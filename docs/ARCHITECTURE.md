# Architecture

Shield AdBlocker is a Manifest V3 extension with three cooperating parts: a
static network blocklist, a service worker that manages state, and a content
script that performs cosmetic filtering.

## 1. Network blocking — `declarativeNetRequest`

`rules/network-rules.json` is a **static ruleset** declared in the manifest under
`declarative_net_request.rule_resources`. Each rule blocks a known ad/tracker
domain:

```json
{ "id": 1, "priority": 1, "action": { "type": "block" },
  "condition": { "urlFilter": "||doubleclick.net^", "domainType": "thirdParty" } }
```

- `||domain^` matches the domain and its subdomains.
- `domainType: "thirdParty"` means a request is only blocked when it is
  third-party relative to the page — this avoids breaking a site that *is* the
  domain in question and reduces false positives.
- Blocking happens in the browser's network stack, **before** any page script
  runs. The page cannot read the ruleset or distinguish a blocked request from a
  normal network failure.

### Why MV3 / declarativeNetRequest instead of MV2 / webRequest?

The original tutorial used MV2 `webRequest`, which Chrome is removing.
`declarativeNetRequest` is the supported replacement: the browser enforces rules
declaratively, so the extension never sees request contents — better for both
privacy and stealth, and it keeps working under MV3.

## 2. Service worker: `src/background.js`

An ES-module service worker (`"type": "module"`). MV3 workers are ephemeral,
so it rebuilds runtime state from `chrome.storage.local` on every wake-up.
Before anything else on each start, it restricts `storage.local` to trusted
contexts (`setAccessLevel`, Chrome 140+), so only the worker and the
extension's own pages can read or write the settings.
The decision logic lives in `src/lib/policy.js` and `src/lib/hosts.js`: pure
functions, unit-tested under Node, and shared with the popup and options page.

- **Global toggle**: `updateEnabledRulesets` enables or disables the static
  blocklist based on the persisted `enabled` flag.
- **Allowlist → one allow rule**: the whole allowlist becomes a single
  session rule:

  ```json
  { "id": 1000000, "priority": 100,
    "action": { "type": "allowAllRequests" },
    "condition": { "requestDomains": ["example.com", "..."], "resourceTypes": ["main_frame"] } }
  ```

  When the tab navigates to an allowlisted site (or a subdomain of one),
  every request in that tab's frame tree is allowed, including requests from
  third-party ad iframes. An `allow` rule keyed on `initiatorDomains`, as in
  1.0.0, misses those iframes, because their requests are initiated by the
  iframe and not by the page. Priority 100 outranks the block rules
  (priority 1). Because the rule is evaluated when the page is requested,
  changes apply on the next load. Session rules are cleared on browser
  restart and rebuilt in `onStartup`.
- **Serialised reconcile**: start-up, `onInstalled` and `storage.onChanged`
  can fire together. Reconciles run one after another, and each re-reads
  storage, so a slow pass can never overwrite a newer state.
- **Messaging**: `getState`, `setEnabled`, `setAllowed`, `setAllowlist` from
  the extension's own pages only. Content scripts get exactly one read-only
  message, `getCosmeticState`, answered with `{ enabled, allowlisted }` for
  the sender's top-level site (see [SECURITY.md](SECURITY.md)).
- **Live cosmetic updates**: on a settings change the worker sends every
  open tab an empty `cosmeticStateChanged` ping (`tabs.query({})` gives ids
  without the `tabs` permission), and each frame asks again.

Static rules use ids `1..N`; the allowlist rule uses `1000000`.

## 3. Cosmetic filtering — `src/content/`

`selectors.js` defines **static** selector constants (generic + per-domain) and
exposes them on a single non-enumerable property (`window.__sab_sel__`) to avoid
an obvious page-readable global.

`cosmetic.js`:

1. At `document_start`, before the page has parsed anything, builds one CSS
   rule **per selector** and injects a `<style>` element (`textContent`,
   never `innerHTML`). This is optimistic, so ads never flash. With one rule
   per selector, a selector the browser can't parse drops only itself. In a
   combined selector list it would invalidate every selector.
2. Sends `{ action: "getCosmeticState" }` to the worker, which decides by the
   **top-level** site (the tab's URL for iframes), the same way the network
   allowlist does. If the answer is `enabled: false` or `allowlisted: true`,
   the style is removed. On an allowlisted page the ad slots therefore show
   up about 25–60 ms after navigation starts (measured headless).
   Prerendered pages ask when they are activated.
3. Hidden elements are **collapsed** (`display: none`) rather than removed.
4. A lightweight `MutationObserver` only re-attaches the style if a SPA wipes
   `<head>` or replaces `<html>`. The CSS rule itself already covers
   dynamically inserted ads.
5. Asks again when the worker's `cosmeticStateChanged` ping arrives, so
   popup and settings changes apply to open tabs live, and when a page is
   restored from the back/forward cache.

It never touches `chrome.storage`; it cannot, because the worker restricts
`storage.local` to trusted contexts.

The content script runs at `document_start` in `all_frames`, in the **isolated
world**, so the page's own scripts cannot read or tamper with its variables.

## Data flow

```
popup.js / options.js ──commands──▶ background.js ◀──▶ chrome.storage.local
                                     │         ▲ │      (trusted contexts only)
                                     ▼         │ │
                       declarativeNetRequest   │ │  ▲ getCosmeticState → { enabled, allowlisted }
                       (rulesets, allow rule)  │ │  ▼ "cosmeticStateChanged" ping on a change
                                               │ ▼
                                        content/cosmetic.js
                                        (CSS on at start; off if told)
```

## State shape

```js
// chrome.storage.local (trusted contexts only: worker, popup, options page)
{
  enabled: true,            // global on/off
  allowlist: ["example.com"] // sanitised registrable hosts
}
```

## 4. Tooling

| Script | Role |
| --- | --- |
| `scripts/build-rules.mjs` | `ad-domains.txt` → `network-rules.json`; flags redundant entries |
| `scripts/validate-rules.mjs` | CI gate: DNR schema and limits, project policy, sync, manifest rulesets |
| `scripts/lib/dnr.mjs` | Offline model of DNR: validator, plus a `urlFilter` matcher with Chrome's action precedence. It follows Chromium's `indexed_rule.cc` and the DNR API definition. |
| `scripts/package.mjs` | Store ZIP: manifest/permission/CSP gates, reachability-based file list, deterministic archive + SHA-256 |
| `scripts/lib/zip.mjs` | Dependency-free deterministic ZIP writer/reader |
| `e2e/extension.e2e.mjs` | Loads the packaged ZIP into Chromium and checks blocking, hiding (no flash, iframes), allowlist, master switch, live updates, permissions, and that the content-script world cannot read or change settings |
| `scripts/store-assets.mjs` | Regenerates the store screenshots and promo tile from the real UI |
