# Privacy Policy

**Shield AdBlocker collects nothing.**

- **No telemetry.** The extension sends no analytics, crash reports, or usage
  data anywhere.
- **No network requests of its own.** It never "phones home" and never downloads
  filter lists at runtime — all rules are bundled in the extension.
- **No browsing history.** It does not record, store, or transmit the pages you
  visit.
- **Local-only state.** The only data stored is your settings — the global
  on/off flag and your per-site allowlist — kept in `chrome.storage.local` on
  your own machine. Uninstalling the extension removes it.

## Permissions and why

| Permission | Purpose | Data leaves device? |
| --- | --- | --- |
| `declarativeNetRequest` (+ feedback) | Block ad/tracker requests; count blocks per tab | No |
| `storage` | Save your toggle + allowlist locally | No |
| `scripting` | Cosmetic CSS injection plumbing | No |
| `activeTab` | Read the active tab's URL when you open the popup | No |
| `host_permissions: <all_urls>` | Apply cosmetic CSS on any site | No |

No data is ever sold, shared, or transmitted. This is a local, offline tool.
