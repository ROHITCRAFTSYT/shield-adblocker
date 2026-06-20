# Installing Shield AdBlocker (unpacked)

Shield AdBlocker is distributed as an unpacked extension. There is no build
step — the source *is* the extension.

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
3. Click the 🛡️ icon — the **blocked on this page** counter should be non-zero.
4. Toggle **Allow this site**, reload, and confirm ads/requests return; toggle it
   back off to resume blocking.

## Updating

Pull the latest changes, then return to the extensions page and click the
**reload** (↻) icon on the Shield AdBlocker card.

## Troubleshooting

- **"Manifest version 2 is deprecated" or load errors** — make sure you selected
  the folder containing `manifest.json`, not a parent or subfolder.
- **Counter shows "—"** — some pages (browser internal pages, the new-tab page,
  the Chrome Web Store) cannot be filtered; this is expected.
- **A site breaks** — use **Allow this site** to pause blocking there, and
  consider opening an issue with the domain.
