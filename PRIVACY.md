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
| `declarativeNetRequest` | Block ad/tracker requests with bundled rules; apply your allowlist | No |
| `storage` | Save your on/off switch and allowlist locally | No |
| `activeTab` | When you open the popup: read the current tab's address and its blocked-request count | No |
| Content script on all `http`/`https` pages | Insert the CSS that hides leftover ad slots | No |

The extension has no host permissions and makes no network requests. Its
pages read the bundled rule file from inside the extension package, which is
a local read, not a network fetch.

No data is ever sold, shared, or transmitted. This is a local, offline tool.
