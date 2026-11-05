/*
 * Matching tests: urlFilter semantics, action precedence, and what the
 * shipped ruleset plus the allowlist rule actually do to real-world URLs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  compileUrlFilter,
  evaluateRequest,
  isBlocked,
  matchesCondition,
  registrableDomain
} from "../scripts/lib/dnr.mjs";
import { buildAllowRules, STATIC_RULESET_ID, SESSION_RULESET_ID } from "../src/lib/policy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = JSON.parse(readFileSync(resolve(ROOT, "rules/network-rules.json"), "utf8"));
const STATIC = { id: STATIC_RULESET_ID, rules: SHIPPED };

const m = (filter, url) => compileUrlFilter(filter).test(new URL(url).href);

/* ----------------------------- urlFilter syntax ---------------------------- */

test("'||' anchors at the host or any subdomain label", () => {
  assert.ok(m("||doubleclick.net^", "https://doubleclick.net/x"));
  assert.ok(m("||doubleclick.net^", "https://securepubads.g.doubleclick.net/tag/js/gpt.js"));
  assert.ok(!m("||doubleclick.net^", "https://notdoubleclick.net/x"), "label boundary is required");
  assert.ok(!m("||doubleclick.net^", "https://example.com/?u=doubleclick.net"), "only the host, not the query");
});

test("'^' matches a separator or end of URL, never a letter, digit, '_', '-', '.', '%'", () => {
  assert.ok(m("||ads.example^", "https://ads.example"), "end of URL");
  assert.ok(m("||ads.example^", "https://ads.example:8443/"), "':' is a separator");
  assert.ok(!m("||ads.example^", "https://ads.example.evil.test/"), "'.' is not a separator");
  assert.ok(!m("||ads.example^", "https://ads.example-cdn.test/"), "'-' is not a separator");
  assert.ok(m("||facebook.com/tr^", "https://www.facebook.com/tr?id=1"), "'?' is a separator");
  assert.ok(m("||facebook.com/tr^", "https://www.facebook.com/tr/"), "'/' is a separator");
  assert.ok(!m("||facebook.com/tr^", "https://www.facebook.com/trending"), "path entries stop at a separator");
});

test("'|' anchors, '*' wildcard, and case-insensitivity by default", () => {
  assert.ok(m("|https://ads.", "https://ads.example/"));
  assert.ok(!m("|https://ads.", "https://x.test/?r=https://ads."));
  assert.ok(m(".js|", "https://cdn.test/a.js"));
  assert.ok(!m(".js|", "https://cdn.test/a.js?v=1"));
  assert.ok(m("/ads/*/banner", "https://cdn.test/ads/123/banner.png"));
  assert.ok(m("||ADS.example^", "https://ads.example/"), "DNR default is case-insensitive");
  assert.ok(!compileUrlFilter("/Banner", true).test("https://cdn.test/banner"), "unless isUrlFilterCaseSensitive");
});

test("registrableDomain approximates eTLD+1, including common multi-label suffixes", () => {
  assert.equal(registrableDomain("a.b.example.com"), "example.com");
  assert.equal(registrableDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("example.com"), "example.com");
});

/* ---------------------------- condition semantics -------------------------- */

test("third-party rules never fire on the site itself (first party)", () => {
  const cond = { urlFilter: "||doubleclick.net^", domainType: "thirdParty" };
  const url = "https://ad.doubleclick.net/x.js";
  assert.ok(matchesCondition(cond, { url, type: "script", initiator: "https://news.example.com" }));
  assert.ok(!matchesCondition(cond, { url, type: "script", initiator: "https://www.doubleclick.net" }));
});

test("rules without resourceTypes do not match top-level navigations", () => {
  const cond = { urlFilter: "||doubleclick.net^" };
  assert.ok(!matchesCondition(cond, { url: "https://doubleclick.net/", type: "main_frame" }));
  assert.ok(matchesCondition(cond, { url: "https://doubleclick.net/", type: "sub_frame", initiator: "https://a.test" }));
});

test("requestDomains match the domain and its subdomains, dot-guarded", () => {
  const cond = { requestDomains: ["example.com"], resourceTypes: ["main_frame"] };
  assert.ok(matchesCondition(cond, { url: "https://example.com/", type: "main_frame" }));
  assert.ok(matchesCondition(cond, { url: "https://news.example.com/", type: "main_frame" }));
  assert.ok(!matchesCondition(cond, { url: "https://evil-example.com/", type: "main_frame" }));
});

test("precedence: higher priority wins; on ties allow > allowAllRequests > block", () => {
  const rs = (rules) => [{ id: "t", rules }];
  const req = { url: "https://ads.example/x.js", type: "script", initiator: "https://site.test" };
  const block = (id, priority) => ({ id, priority, action: { type: "block" }, condition: { urlFilter: "||ads.example^" } });
  const allow = (id, priority) => ({ id, priority, action: { type: "allow" }, condition: { urlFilter: "||ads.example^" } });
  assert.equal(evaluateRequest(rs([block(1, 1), allow(2, 1)]), req).action, "allow");
  assert.equal(evaluateRequest(rs([block(1, 2), allow(2, 1)]), req).action, "block");
  assert.equal(evaluateRequest(rs([]), req).action, "none");
});

/* ------------------------- shipped ruleset fixtures ------------------------ */

const PAGE = "https://news.example.com";
const third = (url, type = "script") => ({ url, type, initiator: PAGE, frames: [{ url: PAGE + "/", type: "main_frame" }] });

// Real endpoints of the networks the list targets. If an entry stops matching
// its tracker (as "bing.com/bat" did: Microsoft UET loads from bat.bing.com),
// this table fails.
const MUST_BLOCK = [
  "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
  "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
  "https://www.googletagmanager.com/gtag/js?id=G-XXXX",
  "https://www.google-analytics.com/g/collect?v=2",
  "https://c.amazon-adsystem.com/aax2/apstag.js",
  "https://bat.bing.com/bat.js",
  "https://www.clarity.ms/tag/abc",
  "https://mc.yandex.ru/metrika/tag.js",
  "https://ib.adnxs.com/ut/v3/prebid",
  "https://static.criteo.net/js/ld/publishertag.js",
  "https://cdn.taboola.com/libtrc/site/loader.js",
  "https://widgets.outbrain.com/outbrain.js",
  "https://static.hotjar.com/c/hotjar-1.js",
  "https://connect.facebook.net/en_US/fbevents.js",
  "https://www.facebook.com/tr?id=1&ev=PageView",
  "https://px.ads.linkedin.com/collect?pid=1",
  "https://t.co/i/adsct?txn_id=1",
  "https://analytics.tiktok.com/i18n/pixel/events.js",
  "https://sb.scorecardresearch.com/beacon.js"
];

const MUST_NOT_BLOCK = [
  "https://www.google.com/recaptcha/api.js",
  "https://fonts.googleapis.com/css2?family=Inter",
  "https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js",
  "https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js",
  "https://www.youtube.com/embed/dQw4w9WgXcQ",
  "https://www.facebook.com/trending",
  "https://www.bing.com/search?q=x",
  "https://notdoubleclick.net/x.js",
  "https://doubleclick.net.evil.test/x.js",
  "https://github.com/ROHITCRAFTSYT/shield-adblocker"
];

for (const url of MUST_BLOCK) {
  test(`blocks third-party ${new URL(url).hostname}${new URL(url).pathname}`, () => {
    assert.equal(evaluateRequest([STATIC], third(url)).action, "block", url);
  });
}

for (const url of MUST_NOT_BLOCK) {
  test(`does not block ${url}`, () => {
    assert.equal(isBlocked([STATIC], third(url)), false, url);
  });
}

test("top-level navigation to an ad domain is never blocked (no main_frame rules)", () => {
  assert.equal(isBlocked([STATIC], { url: "https://www.doubleclick.net/", type: "main_frame" }), false);
});

test("first-party requests are not blocked (a tracker's own site keeps working)", () => {
  const req = { url: "https://www.hotjar.com/static/app.js", type: "script", initiator: "https://www.hotjar.com" };
  assert.equal(isBlocked([STATIC], req), false);
});

/* ------------------------------- allowlisting ------------------------------ */

test("allowlisted site: every request in its tab is allowed, third-party iframes included", () => {
  const session = { id: SESSION_RULESET_ID, rules: buildAllowRules({ enabled: true, allowlist: ["example.com"] }) };
  const rulesets = [STATIC, session];
  const ad = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";

  // Script on the allowlisted page itself.
  const onPage = { url: ad, type: "script", initiator: "https://news.example.com",
    frames: [{ url: "https://news.example.com/", type: "main_frame" }] };
  assert.equal(evaluateRequest(rulesets, onPage).action, "allowAllRequests");

  // Request made from inside a third-party ad iframe on that page: the
  // initiator is the iframe, so an initiatorDomains-based allow rule would
  // miss it. allowAllRequests on the main frame covers the whole tree.
  const inIframe = { url: ad, type: "script", initiator: "https://tpc.googlesyndication.com",
    frames: [{ url: "https://news.example.com/", type: "main_frame" },
      { url: "https://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html", type: "sub_frame" }] };
  assert.equal(evaluateRequest(rulesets, inIframe).action, "allowAllRequests");

  // The same ad on a site that is not allowlisted is still blocked.
  const elsewhere = { url: ad, type: "script", initiator: "https://other.test",
    frames: [{ url: "https://other.test/", type: "main_frame" }] };
  assert.equal(evaluateRequest(rulesets, elsewhere).action, "block");

  // Lookalike domains do not inherit the allowlisting.
  const lookalike = { url: ad, type: "script", initiator: "https://evil-example.com",
    frames: [{ url: "https://evil-example.com/", type: "main_frame" }] };
  assert.equal(evaluateRequest(rulesets, lookalike).action, "block");
});

test("allow rules vanish when protection is off or the allowlist is empty", () => {
  assert.deepEqual(buildAllowRules({ enabled: false, allowlist: ["example.com"] }), []);
  assert.deepEqual(buildAllowRules({ enabled: true, allowlist: [] }), []);
});
