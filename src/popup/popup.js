/*
 * popup.js
 * UI controller. Talks to the service worker via runtime messages and renders
 * state. No inline scripts (CSP), no innerHTML: all DOM via textContent.
 */
import { findAllowlistEntry, pageHost, sanitizeHost } from "../lib/hosts.js";
import { countBlocked } from "../lib/policy.js";
import { getStaticRuleCount, send, version } from "../lib/client.js";

const $ = (id) => document.getElementById(id);
const els = {
  site: $("site"),
  globalToggle: $("globalToggle"),
  siteToggle: $("siteToggle"),
  siteSub: $("siteSub"),
  blockedCount: $("blockedCount"),
  ruleCount: $("ruleCount"),
  status: $("status"),
  stateWord: $("stateWord"),
  ver: $("ver"),
  reloadNotice: $("reloadNotice"),
  reloadBtn: $("reloadBtn"),
  openOptions: $("openOptions")
};

let currentHost = null; // display host of the active tab (null = internal page)
let currentTabId = null;
let lastState = null;

function setStatus(text) {
  els.status.textContent = text;
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (_) {
    return null;
  }
}

async function loadBlockedCount() {
  // getMatchedRules is available because opening the popup grants activeTab
  // for this tab; no declarativeNetRequestFeedback permission is needed.
  if (currentTabId == null || !currentHost) {
    els.blockedCount.textContent = "—";
    return;
  }
  try {
    const details = await chrome.declarativeNetRequest.getMatchedRules({ tabId: currentTabId });
    setCount(countBlocked(details));
  } catch (_) {
    // Quota exceeded or no access to this tab.
    els.blockedCount.textContent = "—";
  }
}

// Set the big number with a subtle HUD "pop" (Web Animations API, CSP-safe).
function setCount(value) {
  els.blockedCount.textContent = String(value);
  try {
    els.blockedCount.animate(
      [
        { transform: "translateY(4px)", opacity: 0.2 },
        { transform: "translateY(0)", opacity: 1 }
      ],
      { duration: 320, easing: "cubic-bezier(.2,.7,.3,1)" }
    );
  } catch (_) { /* animation unsupported; value is already set */ }
}

function render(state) {
  lastState = state;
  const enabled = !!state.enabled;
  els.globalToggle.checked = enabled;

  const allowlistable = sanitizeHost(currentHost) !== null;
  const entry = findAllowlistEntry(sanitizeHost(currentHost), state.allowlist);
  const allowed = entry !== null;

  if (!currentHost) {
    els.site.textContent = "this page can't be filtered";
    els.siteToggle.checked = false;
    els.siteToggle.disabled = true;
    els.siteSub.textContent = "Browser / internal page";
  } else if (!allowlistable) {
    els.site.textContent = currentHost;
    els.siteToggle.checked = false;
    els.siteToggle.disabled = true;
    els.siteSub.textContent = "IP / local address: can't allowlist";
  } else {
    els.site.textContent = currentHost;
    els.siteToggle.disabled = !enabled;
    els.siteToggle.checked = allowed;
    els.siteSub.textContent = !allowed
      ? "Pause blocking on this domain"
      : entry === sanitizeHost(currentHost) ? "Blocking paused here" : `Paused via ${entry}`;
  }

  // Drive the HUD's signal state: armed / paused-here / off.
  let mode, word, status;
  if (!enabled) {
    mode = "off"; word = "OFFLINE"; status = "shield down";
  } else if (allowed) {
    mode = "allow"; word = "ALLOWED"; status = "paused · this site";
  } else {
    mode = "on"; word = "PROTECTED"; status = "armed";
  }
  document.body.setAttribute("data-state", mode);
  els.stateWord.textContent = word;
  setStatus(status);
}

function showReloadNotice() {
  if (currentTabId != null && currentHost) els.reloadNotice.hidden = false;
}

async function init() {
  els.ver.textContent = "v" + version();

  const tab = await getActiveTab();
  if (tab) {
    currentTabId = tab.id;
    currentHost = pageHost(tab.url || "");
  }

  const resp = await send({ action: "getState" });
  if (!resp.ok) {
    setStatus("error: " + resp.error);
    return;
  }
  render(resp.data);

  const count = await getStaticRuleCount();
  els.ruleCount.textContent = count == null ? "—" : String(count);

  loadBlockedCount();
}

els.globalToggle.addEventListener("change", async () => {
  const resp = await send({ action: "setEnabled", value: els.globalToggle.checked });
  if (resp.ok) {
    render(resp.data);
    showReloadNotice();
  } else {
    setStatus("error: " + resp.error);
    if (lastState) render(lastState);
  }
});

els.siteToggle.addEventListener("change", async () => {
  const host = sanitizeHost(currentHost);
  if (!host || !lastState) return;
  // Turning it off removes whichever entry covers this page: on
  // news.example.com that may be "example.com", not the page's own host.
  const target = els.siteToggle.checked ? host : findAllowlistEntry(host, lastState.allowlist) || host;
  const resp = await send({ action: "setAllowed", host: target, value: els.siteToggle.checked });
  if (resp.ok) {
    render(resp.data);
    showReloadNotice();
  } else {
    setStatus("error: " + resp.error);
    render(lastState);
  }
});

els.reloadBtn.addEventListener("click", async () => {
  try {
    await chrome.tabs.reload(currentTabId);
  } catch (_) { /* tab closed */ }
  window.close();
});

els.openOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

init();
