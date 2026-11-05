# Installing Shield AdBlocker (unpacked)

Until it is published to a store, Shield AdBlocker installs as an unpacked
extension. There is no build step: the repository root *is* the extension.
To install the exact store build instead, run `npm run package` and unzip
`dist/shield-adblocker-<version>.zip` into a folder, then load that folder.

**Requires Chrome 140 or newer**, or a browser built on Chromium 140 or newer.
Older versions refuse to load it. Chromium 140 is the first version that lets
an extension lock its saved settings away from content scripts
(`storage.local.setAccessLevel`); see [SECURITY.md](SECURITY.md).

## Chrome / Brave / Opera

1. Go to `chrome://extensions`.
2. Toggle **Developer mode** on (top-right corner).
3. Click **Load unpacked**.
4. Select the repository root (the folder that contains `manifest.json`).
5. The 🛡️ **Shield AdBlocker** card appears. Click the puzzle-piece icon in the
   toolbar and pin it.

## Microsoft Edge

1. Go to `edge://extensions`.
2. Turn on **Developer mode** (left sidebar).
3. Click **Load unpacked** and select the repo root.

## Verifying it works

1. Visit an ad-heavy news site.
2. Open **DevTools → Network**, reload, and filter by `doubleclick` or
   `googlesyndication` — those requests should show as **blocked**.
3. Click the toolbar icon. The **blocked · this page** counter should be
   non-zero.
4. Turn on **Allow this site** and press **Reload** in the popup. The ad
   requests return. Turn it off and reload again to resume blocking.
5. Open **settings →** in the popup to manage the allowlist.

## Updating

Pull the latest changes, then return to the extensions page and click the
**reload** (↻) icon on the Shield AdBlocker card.

## Troubleshooting

- **"Manifest version 2 is deprecated" or load errors** — make sure you selected
  the folder containing `manifest.json`, not a parent or subfolder.
- **Counter shows "—"**: some pages (browser internal pages, the new-tab page,
  the Chrome Web Store) can't be filtered. This is expected. Chrome also limits
  how often the count can be read, about 20 times per 10 minutes, so it may
  briefly show "—" after many popup opens.
- **"Allow this site" is greyed out**: the page is an IP address or
  `localhost`. Those can't be allowlisted.
- **A site breaks** — use **Allow this site** to pause blocking there, and
  consider opening an issue with the domain.
