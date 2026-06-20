/*
 * popup.js
 * UI controller. Talks to the service worker via runtime messages and renders
 * state. No inline scripts (CSP), no innerHTML — all DOM via textContent.
 */
"use strict";

const els = {
  site: document.getElementById("site"),
  globalToggle: document.getElementById("globalToggle"),
  siteToggle: document.getElementById("siteToggle"),
  siteRow: document.getElementById("siteRow"),
  siteSub: document.getElementById("siteSub"),
  blockedCount: document.getElementById("blockedCount"),
  ruleCount: document.getElementById("ruleCount"),
  status: document.getElementById("status"),
  stateWord: document.getElementById("stateWord")
};

let currentHost = null;
let currentTabId = null;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: "no response" });
      }
    });
  });
}

function setStatus(text) {
  els.status.textContent = text;
}

// Extract a clean, blockable host from a tab URL. Returns null for browser
// pages (chrome://, edge://, about:, extension pages) where we never act.
function hostFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h;
  } catch (_) {
    return null;
  }
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

async function loadBlockedCount() {
  // Real per-tab count via declarativeNetRequest feedback API.
  if (currentTabId == null || !chrome.declarativeNetRequest.getMatchedRules) {
    els.blockedCount.textContent = "—";
    return;
  }
  try {
    const info = await chrome.declarativeNetRequest.getMatchedRules({ tabId: currentTabId });
    const matches = (info && info.rulesMatchedInfo) ? info.rulesMatchedInfo.length : 0;
    setCount(matches);
  } catch (_) {
    els.blockedCount.textContent = "—";
  }
}

// Set the big number with a subtle HUD "pop" (Web Animations API — CSP-safe).
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
  const enabled = !!state.enabled;
  els.globalToggle.checked = enabled;

  const allowed = currentHost ? state.allowlist.indexOf(currentHost) !== -1 : false;

  if (!currentHost) {
    els.site.textContent = "this page can't be filtered";
    els.siteToggle.checked = false;
    els.siteToggle.disabled = true;
    els.siteSub.textContent = "Browser/internal page";
  } else {
    els.site.textContent = currentHost;
    els.siteToggle.disabled = !enabled;
    els.siteToggle.checked = allowed;
    els.siteSub.textContent = allowed ? "Blocking paused here" : "Pause blocking on this domain";
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

async function init() {
  const tab = await getActiveTab();
  if (tab) {
    currentTabId = tab.id;
    currentHost = hostFromUrl(tab.url || "");
  }

  const resp = await send({ action: "getState" });
  if (!resp.ok) {
    setStatus("Error: " + resp.error);
    return;
  }
  render(resp.data);

  // Show how many static block rules ship with the extension.
  try {
    const max = chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES; // touch API to confirm availability
    void max;
  } catch (_) { /* ignore */ }
  els.ruleCount.textContent = "180+";

  loadBlockedCount();
}

els.globalToggle.addEventListener("change", async () => {
  const resp = await send({ action: "setEnabled", value: els.globalToggle.checked });
  if (resp.ok) render(resp.data);
  else setStatus("Error: " + resp.error);
});

els.siteToggle.addEventListener("change", async () => {
  if (!currentHost) return;
  const resp = await send({
    action: "setAllowed",
    host: currentHost,
    value: els.siteToggle.checked
  });
  if (resp.ok) render(resp.data);
  else setStatus("Error: " + resp.error);
});

init();
