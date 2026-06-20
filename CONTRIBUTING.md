# Contributing

Thanks for your interest in improving Shield AdBlocker!

## Development setup

There is no build step. Load the repo as an unpacked extension
(see [docs/INSTALL.md](docs/INSTALL.md)) and reload it from `chrome://extensions`
after each change.

## Adding network blocking rules

Edit [`rules/network-rules.json`](rules/network-rules.json):

- Use a **unique integer `id`** (keep them sequential; static rules live in the
  `1..999999` range — do not use `1000000+`, which is reserved for runtime allow
  rules).
- Prefer `"urlFilter": "||domain.tld^"` with `"domainType": "thirdParty"` to
  avoid breaking first-party functionality.
- Keep `"priority": 1` for block rules.

## Adding cosmetic selectors

Edit [`src/content/selectors.js`](src/content/selectors.js):

- Add broad, low-false-positive selectors to `GENERIC`.
- Add site-specific selectors under `PER_DOMAIN`, keyed by registrable domain.
- Prefer stable, semantic markers (ad-slot ids, `data-ad-*`) over brittle
  layout classes.

## Guidelines

- **No remote code, no network calls, no `eval`, no `innerHTML` of dynamic
  data.** PRs that add any of these will be rejected. See
  [docs/SECURITY.md](docs/SECURITY.md).
- Keep permissions minimal — adding a permission needs a clear justification.
- Test that common sites (news, video, social) still work and aren't visually
  broken before submitting.

## Pull requests

1. Fork and branch.
2. Make focused changes with a clear description.
3. Note which sites you tested.
