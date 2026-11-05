# Security model

This document describes the threat model and the concrete hardening choices made
in Shield AdBlocker. The goal: an extension that cannot be turned into an attack
vector against the user or weaponised by a hostile web page.

## Assets we protect

- The user's browsing (the extension must not exfiltrate or log it).
- The extension's own state (enable flag, allowlist).
- The user's browser (no path to arbitrary code execution).

## Trust boundaries

| Boundary | Trusted? | Mitigation |
| --- | --- | --- |
| Web page DOM / scripts | **No** | Content script runs in isolated world; selectors are static; no page data is ever interpreted as code. |
| Other extensions | **No** | No `externally_connectable`; service worker rejects any message whose `sender.id` ≠ our runtime id. |
| Content script → worker | **No** | The worker only accepts messages whose `sender.url` is on the extension's own `chrome-extension://<id>/` origin. Content scripts share the extension id but report the web page's URL, so they are ignored. |
| Popup / options page → worker | **Yes (own pages)** | Still fully input-validated. |
| Network | **No** | The extension makes **no** outbound requests of its own. |

## Hardening checklist

### Permissions (least privilege)
- `declarativeNetRequest`: blocking, plus the allowlist rule. Block and
  allow-type rules need no host permissions.
- `storage`: persist the toggle and allowlist locally.
- `activeTab`: when the user opens the popup, read the active tab's URL and
  call `getMatchedRules` for that tab only. Chromium makes `getMatchedRules`
  available to an extension "with the declarativeNetRequestFeedback
  permission or having the activeTab permission granted for the tabId", so
  the broader feedback permission is not requested.
- Content script on `http://*/*` and `https://*/*`: injects cosmetic CSS. It
  produces Chrome's "Read and change all your data on all websites" warning,
  which is inherent to a cosmetic filter. There are **no** `host_permissions`.

Removed in 1.1.0: `scripting` (unused), `declarativeNetRequestFeedback`
(replaced by `activeTab`), and `host_permissions: <all_urls>` (never needed).
The packager (`scripts/package.mjs`) fails the build if the permission set
changes, if host permissions, `externally_connectable` or
`web_accessible_resources` appear, or if the CSP is loosened.

### No remote code / no dynamic code
- No `eval`, `new Function`, `setTimeout(string, …)`.
- No remote scripts; no runtime fetching of filter lists. Everything is bundled.
- Strict CSP for extension pages: `script-src 'self'; object-src 'self';
  base-uri 'self'; form-action 'self'`.

### No injection sinks
- The popup and content script build DOM via `textContent` / `createElement`
  only — **never** `innerHTML` with dynamic data.
- Cosmetic CSS is assembled from **static constant** selectors, never from
  page-controlled strings, so there is no CSS/DOM injection surface.

### Message handler validation (`src/background.js`, `src/lib/policy.js`)
1. `isTrustedSender`: `sender.id === chrome.runtime.id` **and** `sender.url`
   starts with `chrome-extension://<id>/`. This admits the popup and the
   options page, even when the options page is opened in a tab, and rejects
   content scripts and other extensions. The old `!sender.tab` check would
   have rejected the options page.
2. The message must be an object with an action in an explicit allowlist:
   `getState`, `setEnabled`, `setAllowed`, `setAllowlist`.
3. `planCommand` type-checks every value: `enabled` must be a boolean, hosts
   must match a strict hostname pattern, and lists are sanitised and capped.
   It is a pure function with unit tests for each rejection path.

### Input sanitisation
- Hostnames are validated against a strict regex: public-looking names only,
  including punycode TLDs. IP literals and `localhost` are rejected. Names are
  lower-cased, `www.` is stripped, entries are de-duplicated, and the list is
  capped at 5000. The worker re-sanitises everything it reads from storage,
  so a malformed stored value can't reach a DNR rule.
- Invalid input is dropped, never partially applied.

### Fail-safe behavior
- If selectors fail to load, the cosmetic layer does nothing (fails closed, no
  errors thrown into the page).
- If the extension context is invalidated (e.g. during reload), content-script
  storage calls are wrapped and swallowed rather than throwing.

## Known residual risks

- **All-sites content script.** Cosmetic filtering needs a content script on
  every site. It only injects a static stylesheet. It never reads page
  content, and it has no channel to the network.
- **Content scripts can write `chrome.storage.local`.** Chromium's default is
  that `local` storage "allow[s] access from both trusted and untrusted
  contexts". A content script whose isolated world is compromised (which
  needs a renderer exploit on a hostile page) could change the `enabled` flag
  or the allowlist directly, without going through the message handler.
  The worker re-sanitises whatever it reads, so this cannot inject a
  malformed rule. The worst outcome is that blocking is switched off or a
  site is allowlisted. The fix is to restrict `local` to trusted contexts
  with `storage.local.setAccessLevel` and serve content scripts a read-only
  view. That is tracked as a follow-up; it is not done yet.
- **Detection.** Anti-adblock walls may still infer blocking. This is a
  functionality limitation, not a security hole.

## Reporting a vulnerability

Open a GitHub issue marked **security**, or contact the maintainer privately.
Please include reproduction steps and the affected file/line.
