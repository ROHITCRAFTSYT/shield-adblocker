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
| Content script → worker | **Limited** | Worker rejects messages that carry a `sender.tab` (i.e. came from a tab/content script), so a compromised content script cannot drive privileged actions. |
| Popup → worker | **Yes (own page)** | Still fully input-validated. |
| Network | **No** | The extension makes **no** outbound requests of its own. |

## Hardening checklist

### Permissions (least privilege)
- `declarativeNetRequest` / `declarativeNetRequestFeedback` — blocking + per-tab
  match counts.
- `storage` — persist the toggle and allowlist locally.
- `scripting` — reserved for cosmetic injection plumbing.
- `activeTab` — read only the active tab's URL when the popup is opened.
- `host_permissions: <all_urls>` — required for cosmetic CSS on any site. This is
  the broadest grant and is documented here deliberately; the extension never
  uses it to read page content or make requests.

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

### Message handler validation (`background.js`)
1. `sender.id === chrome.runtime.id` — only our own pages.
2. `!sender.tab` — reject content-script / tab origins for privileged actions.
3. Message must be an object with an action in an explicit allowlist
   (`getState`, `setEnabled`, `setAllowed`).
4. Values are type/shape checked: `enabled` must be boolean; hosts must match a
   strict hostname regex; the allowlist is sanitised and length-capped.

### Input sanitisation
- Hostnames are validated against a strict regex, lower-cased, `www.` stripped,
  de-duplicated, and capped (defensive against state bloat).
- Invalid input is dropped, never partially applied.

### Fail-safe behavior
- If selectors fail to load, the cosmetic layer does nothing (fails closed, no
  errors thrown into the page).
- If the extension context is invalidated (e.g. during reload), content-script
  storage calls are wrapped and swallowed rather than throwing.

## Known residual risks

- **Broad host permission.** `<all_urls>` is inherent to a cosmetic ad blocker.
  We mitigate by never reading or transmitting page content.
- **Detection.** Anti-adblock walls may still infer blocking. This is a
  functionality limitation, not a security hole.

## Reporting a vulnerability

Open a GitHub issue marked **security**, or contact the maintainer privately.
Please include reproduction steps and the affected file/line.
