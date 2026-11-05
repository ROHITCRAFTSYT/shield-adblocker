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
| Content script → worker | **Read-only** | Commands are only accepted from senders whose `sender.url` is on the extension's own `chrome-extension://<id>/` origin. Content scripts share the extension id but report the web page's URL, so they can send exactly one message, `{ action: "getCosmeticState" }`, and get back `{ enabled, allowlisted }` for their own tab's top-level site. Everything else they send is dropped without a reply. |
| Content script → `chrome.storage` | **No** | `storage.local` is restricted to trusted contexts (extension pages and the service worker). Content scripts can neither read nor write it, and do not receive its `onChanged` events. |
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

### Settings storage locked to trusted contexts
Chromium's default is that `local` storage "allow[s] access from both trusted
and untrusted contexts", meaning content scripts too. On every start, the
service worker calls
`chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`.
After that, a content script's `storage.local.get`/`set` fails with "Access to
storage is not allowed from this context", and `storage.onChanged` events for
`local` are only dispatched to privileged extension contexts.

- **Enforced by the browser, not the renderer.** Chromium checks each
  storage call against the caller's context type
  (`SettingsFunction::IsAccessToStorageAllowed` in
  `extensions/browser/api/storage/storage_api.cc`). The browser rejects a
  renderer that claims a privileged context type its process can't host
  (`ProcessMap::CanProcessHostContextType`). A web page's process is never a
  privileged extension process, so a renderer exploit there cannot claim one.
- **Persistent.** The level is stored in the profile's extension prefs
  (`storage_utils::SetAccessLevelForArea`), so after the first run it applies
  from browser start-up, before any page loads. Re-applying it on every
  worker start is cheap and covers a lost pref.
- **Chrome 140 or newer.** `setAccessLevel` exists since Chrome 102, but until
  Chromium 139 it rejected every area except `session` ("This StorageArea is
  not available for setting access level"). `local` is accepted from Chromium
  140. The manifest therefore sets `minimum_chrome_version` to `140`, and
  `scripts/package.mjs` refuses to build with anything lower. Lowering it would
  silently reopen the hole on older browsers.
- **Tested** in `e2e/extension.e2e.mjs`. Code run in the content script's
  isolated world tries to write and read `storage.local`, send every command,
  and listen to `storage.onChanged`, then the test checks that nothing
  changed. On the 1.1.0 code before this fix, the same test writes
  `enabled: false` and an allowlist entry, and network blocking turns off.
  The test cannot forge browser IPC the way a renderer exploit would, so the
  claim about compromised *renderers* rests on the browser-side check above,
  read in Chromium's source.

### Content scripts get a read-only view
The cosmetic content script needs two facts: is filtering on, and is this
page's site allowlisted. Instead of reading storage, it asks the worker:

- The query carries no data. The worker works out the site from fields the
  browser sets on `sender`: `sender.url` for the top frame, and the tab's URL
  for iframes, so an ad iframe follows the page it is on. An iframe with no
  tab URL is never treated as allowlisted. Content scripts
  never report their own top-level origin. If they did, a compromised renderer
  could ask about arbitrary hosts and read the allowlist one entry at a time.
- The answer is `{ enabled, allowlisted }`, never the allowlist.
- Live updates: when settings change, the worker sends every open tab a
  ping with no state (`chrome.tabs.query({})` returns tab ids without the
  `tabs` permission). Each frame then asks again. A forged ping could only
  cause an extra query.
- No ad flash: the hiding CSS is inserted synchronously at `document_start`
  and removed only if the answer says filtering is off or the site is
  allowlisted. If no valid answer arrives, filtering stays on.

Alternative considered: mirror `{ enabled, allowlist }` into `storage.session`
opened to untrusted contexts. That needs no worker wake-up, but every content
script could read the whole allowlist again, and a compromised one could
write the mirror and switch cosmetic filtering off in every tab. It would
also make "nothing a content script can write" depend on the worker never
trusting that area. Messaging keeps the content script's view to two booleans
about its own site and leaves it nothing writable.

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
4. Content scripts (`isContentScriptSender`: our id, a sender URL that is not
   one of our pages) are routed separately by `routeMessage`. The only
   accepted message is exactly `{ action: "getCosmeticState" }`; one extra key
   is enough to drop it. The answer comes from `cosmeticStateFor`, which
   reads state and never writes. A content script can never reach
   `planCommand`.

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
- If the extension context is invalidated (e.g. during reload), the content
  script's messaging calls are wrapped and swallowed rather than throwing.
- If the worker does not answer, or answers with anything but two booleans,
  the content script keeps filtering on.
- If `setAccessLevel` fails (it should not on Chrome 140+), the worker logs
  an error and carries on. Content scripts no longer use storage, so
  nothing breaks, but the lock is not in place.

## Known residual risks

- **All-sites content script.** Cosmetic filtering needs a content script on
  every site. It only injects a static stylesheet. It never reads page
  content, and it has no channel to the network.
- **A content script learns two facts about its own site.** A compromised
  renderer can still send the read-only query, and learns whether blocking
  is on and whether the site it is on is allowlisted. It cannot learn other
  entries or change anything.
- **Detection.** Anti-adblock walls may still infer blocking. Also, because
  the hiding CSS goes in before the worker answers, an allowlisted site (or
  any site while the master switch is off) can see the extension's `<style>`
  element appear at `document_start` and be removed shortly after (about
  25 ms with the worker running and 60 ms when it has to start, measured
  headless). Before 1.1.0 an allowlisted site saw no style at all. This is
  the cost of having no ad flash on every other site. It reveals that the
  extension is installed, not anything about the user's settings beyond
  "this site is allowlisted".

## Reporting a vulnerability

Open a GitHub issue marked **security**, or contact the maintainer privately.
Please include reproduction steps and the affected file/line.
