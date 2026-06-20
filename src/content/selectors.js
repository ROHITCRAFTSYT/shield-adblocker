/*
 * selectors.js
 * Curated, STATIC cosmetic-filtering selectors. These are constants only —
 * they are never derived from page content, so there is no injection surface.
 *
 * Exposed on a single non-enumerable property of a private namespace to avoid
 * leaving an obvious, page-readable global that anti-adblock scripts could probe.
 */
(function () {
  "use strict";

  // Generic ad containers seen across the web. Kept intentionally conservative
  // to minimize false positives (hiding real content).
  const GENERIC = [
    "ins.adsbygoogle",
    "iframe[src*='doubleclick.net']",
    "iframe[src*='googlesyndication.com']",
    "iframe[id^='google_ads_iframe']",
    "div[id^='google_ads_iframe']",
    "div[id^='div-gpt-ad']",
    "div[id^='ad-']",
    "div[id$='-ad']",
    "div[class^='ad-']",
    "div[class*=' ad-']",
    "div[class*='ad-slot']",
    "div[class*='ad-container']",
    "div[class*='ad-wrapper']",
    "div[class*='advert']",
    "div[class*='sponsored']",
    "div[class*='-sponsor']",
    "[data-ad-slot]",
    "[data-ad-client]",
    "[data-adunit]",
    "[aria-label='Advertisement']",
    "[aria-label='advertisement']",
    "div[id*='taboola']",
    "div[id*='outbrain']",
    "div[class*='trc_related_container']",
    "div[class*='OUTBRAIN']",
    ".adsbygoogle",
    ".ad-banner",
    ".ad-leaderboard",
    ".banner-ad",
    ".sponsored-content"
  ];

  // Per-domain selectors. Keyed by registrable domain (matched by suffix).
  // Only well-known, stable markers — avoids breaking site layout.
  const PER_DOMAIN = {
    "youtube.com": [
      "ytd-promoted-sparkles-web-renderer",
      "ytd-display-ad-renderer",
      "ytd-ad-slot-renderer",
      "#player-ads",
      "#masthead-ad",
      "ytd-in-feed-ad-layout-renderer"
    ],
    "linkedin.com": [
      ".ad-banner-container",
      "[data-is-sponsored='true']",
      ".feed-shared-update-v2--sponsored"
    ],
    "twitter.com": ["[data-testid='placementTracking']"],
    "x.com": ["[data-testid='placementTracking']"],
    "reddit.com": ["shreddit-comments-page-ad", "[data-testid='ad-post']", ".promotedlink"],
    "facebook.com": ["[data-pagelet^='FeedUnit'] [aria-label='Sponsored']"]
  };

  // Private namespace: non-enumerable, hard to discover via for..in / Object.keys.
  Object.defineProperty(window, "__sab_sel__", {
    value: Object.freeze({ GENERIC, PER_DOMAIN }),
    enumerable: false,
    configurable: false,
    writable: false
  });
})();
