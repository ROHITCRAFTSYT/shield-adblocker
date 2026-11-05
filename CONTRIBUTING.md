# Contributing

Thanks for your interest in improving Shield AdBlocker!

## Development setup

The extension itself needs no build — load the repo as an unpacked extension
(see [docs/INSTALL.md](docs/INSTALL.md)) and reload it from `chrome://extensions`
after each change. Tooling (rule generation + lint) uses Node:

```bash
npm ci            # dev tools only (eslint, playwright); nothing is bundled
npm run check     # lint + unit tests + package (what CI runs, minus e2e)
npm run test:e2e  # load the packaged zip in Chromium (needs: npx playwright install chromium)
```

## Adding network blocking rules

The blocklist is **generated** — do not edit `rules/network-rules.json` by hand.

1. Add domains (one per line) to [`rules/ad-domains.txt`](rules/ad-domains.txt).
   Use a registrable domain, optionally with a path fragment
   (e.g. `facebook.com/tr`). Avoid first-party CDNs that would break sites.
2. Regenerate and validate:

   ```bash
   npm run build:rules   # rebuilds network-rules.json (third-party block rules)
   npm run lint          # validates JSON is in sync + lints JS
   ```

Each domain compiles to a `"||domain^"` rule with `"domainType": "thirdParty"`.
CI rejects a PR when:

- `network-rules.json` is out of sync with the source list;
- a rule breaks Chrome's DNR schema;
- an entry is already covered by a broader one (`x.a.com` next to `a.com`);
- the rule count in `README.md` or `docs/store-listing.md` is stale. Commit
  the files that `npm run build:rules` rewrites.

Check that your entry matches the endpoint the tracker really uses. Add that
URL to `MUST_BLOCK` in `test/dnr-match.test.mjs`. `bing.com/bat` shipped in
1.0.0 and never blocked anything: Microsoft's tag loads from `bat.bing.com`.

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
- Keep permissions minimal. A new permission needs a clear justification. It
  must also be added to `EXPECTED_PERMISSIONS` in `scripts/package.mjs` and
  justified in `docs/store-listing.md`, or the build fails.
- Test that common sites (news, video, social) still work and aren't visually
  broken before submitting.

## Pull requests

1. Fork and branch.
2. Make focused changes with a clear description.
3. Note which sites you tested.
