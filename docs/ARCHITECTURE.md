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

## 2. Service worker — `src/background.js`

Stateless across restarts (MV3 workers are ephemeral), so it rebuilds runtime
state from `chrome.storage.local` on every wake-up. Responsibilities:

- **Global toggle**: `updateEnabledRulesets` enables/disables the static
  blocklist based on the persisted `enabled` flag.
- **Allowlist → allow rules**: each allowlisted host becomes a high-priority
  **session** rule with `action: "allow"` and `condition.initiatorDomains`,
  so every request from that top-level site is permitted. Session rules are
  cleared on browser restart and rebuilt from storage via `onStartup`.
- **Messaging**: handles `getState`, `setEnabled`, `setAllowed` from the popup,
  with strict sender + input validation (see [SECURITY.md](SECURITY.md)).

Reserved id ranges keep the two rule kinds from colliding: static rules use
`1..N`; session allow rules start at `1000000`.

## 3. Cosmetic filtering — `src/content/`

`selectors.js` defines **static** selector constants (generic + per-domain) and
exposes them on a single non-enumerable property (`window.__sab_sel__`) to avoid
an obvious page-readable global.

`cosmetic.js`:

1. Reads `enabled` + `allowlist` from `chrome.storage.local`.
2. If active for this host, builds a CSS string from the matching selectors and
   injects a `<style>` element (`textContent`, never `innerHTML`).
3. Hidden elements are **collapsed** (`display: none`) rather than removed.
4. A lightweight `MutationObserver` only re-attaches the style if a SPA wipes
   `<head>` — the CSS rule itself already covers dynamically inserted ads.
5. Subscribes to `chrome.storage.onChanged` so popup changes apply live.

The content script runs at `document_start` in `all_frames`, in the **isolated
world**, so the page's own scripts cannot read or tamper with its variables.

## Data flow

```
popup.js  ──sendMessage──▶ background.js ──▶ chrome.storage.local
                                │                   │
                                ▼                   ▼ onChanged
                  declarativeNetRequest      content/cosmetic.js
                  (enable rulesets,           (apply/clear CSS)
                   session allow rules)
```

## State shape

```js
// chrome.storage.local
{
  enabled: true,            // global on/off
  allowlist: ["example.com"] // sanitised registrable hosts
}
```
