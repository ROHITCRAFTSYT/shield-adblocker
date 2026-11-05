/*
 * options.js — settings page controller.
 * All changes go through the service worker (validated there); this page
 * only renders state and validates input early for clear error messages.
 * No innerHTML: every node is built with createElement / textContent.
 */
import { MAX_ALLOWLIST, hostFromInput } from "../lib/hosts.js";
import { getStaticRuleCount, send, version } from "../lib/client.js";

const $ = (id) => document.getElementById(id);
const els = {
  ver: $("ver"),
  status: $("status"),
  globalToggle: $("globalToggle"),
  globalSub: $("globalSub"),
  ruleCount: $("ruleCount"),
  allowCount: $("allowCount"),
  addForm: $("addForm"),
  addInput: $("addInput"),
  addMsg: $("addMsg"),
  listTools: $("listTools"),
  filter: $("filter"),
  filterCount: $("filterCount"),
  list: $("allowList"),
  empty: $("emptyState"),
  rowActions: $("rowActions"),
  clearBtn: $("clearBtn"),
  bulkText: $("bulkText"),
  bulkSave: $("bulkSave"),
  bulkRevert: $("bulkRevert"),
  bulkMsg: $("bulkMsg")
};

let state = { enabled: true, allowlist: [] };
let bulkDirty = false;
let clearTimer = null;

function setMsg(el, text, kind = "") {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

/* ------------------------------- rendering -------------------------------- */

function renderList() {
  const q = els.filter.value.trim().toLowerCase();
  const sorted = state.allowlist.slice().sort((a, b) => a.localeCompare(b));
  const shown = q ? sorted.filter((h) => h.includes(q)) : sorted;

  const frag = document.createDocumentFragment();
  for (const host of shown) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "host";
    name.textContent = host;
    name.title = host;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "Remove";
    rm.setAttribute("aria-label", "Remove " + host);
    rm.dataset.host = host;
    li.append(name, rm);
    frag.append(li);
  }
  els.list.replaceChildren(frag);

  const total = state.allowlist.length;
  els.empty.hidden = total !== 0;
  els.rowActions.hidden = total === 0;
  els.listTools.hidden = total < 8;
  els.filterCount.textContent = q ? `${shown.length} of ${total}` : "";
  if (q && shown.length === 0) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "No matches.";
    els.list.replaceChildren(li);
  }
}

function render(next) {
  state = next;
  const on = !!state.enabled;
  els.globalToggle.checked = on;
  els.globalSub.textContent = on ? "Network + cosmetic filtering on every site" : "Off: nothing is being blocked";
  document.body.setAttribute("data-state", on ? "on" : "off");
  els.status.textContent = on ? "armed" : "shield down";
  els.allowCount.textContent = String(state.allowlist.length);
  renderList();
  if (!bulkDirty) els.bulkText.value = state.allowlist.join("\n");
}

async function refresh() {
  const resp = await send({ action: "getState" });
  if (resp.ok) render(resp.data);
  else els.status.textContent = "error: " + resp.error;
}

/* -------------------------------- actions --------------------------------- */

els.globalToggle.addEventListener("change", async () => {
  const resp = await send({ action: "setEnabled", value: els.globalToggle.checked });
  if (resp.ok) render(resp.data);
  else { els.status.textContent = "error: " + resp.error; render(state); }
});

els.addInput.addEventListener("input", () => {
  els.addInput.removeAttribute("aria-invalid");
  setMsg(els.addMsg, "");
});

els.addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = els.addInput.value;
  if (!raw.trim()) {
    els.addInput.focus();
    return;
  }
  const host = hostFromInput(raw);
  if (!host) {
    els.addInput.setAttribute("aria-invalid", "true");
    setMsg(els.addMsg, "That doesn't look like a website address. Try something like example.com (IP addresses and localhost aren't supported).", "err");
    return;
  }
  if (state.allowlist.includes(host)) {
    setMsg(els.addMsg, `${host} is already allowlisted.`);
    els.addInput.select();
    return;
  }
  if (state.allowlist.length >= MAX_ALLOWLIST) {
    setMsg(els.addMsg, `The allowlist is full (${MAX_ALLOWLIST} sites).`, "err");
    return;
  }
  const resp = await send({ action: "setAllowed", host, value: true });
  if (!resp.ok) {
    setMsg(els.addMsg, "Couldn't save: " + resp.error, "err");
    return;
  }
  render(resp.data);
  els.addInput.value = "";
  setMsg(els.addMsg, `Added ${host}. Reload its tabs to apply.`, "ok");
  els.addInput.focus();
});

els.list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.rm");
  if (!btn) return;
  const host = btn.dataset.host;
  const resp = await send({ action: "setAllowed", host, value: false });
  if (!resp.ok) {
    setMsg(els.addMsg, "Couldn't remove: " + resp.error, "err");
    return;
  }
  render(resp.data);
  setMsg(els.addMsg, `Removed ${host}. Blocking resumes there on the next page load.`, "ok");
  // Keep keyboard focus in the list instead of dropping it to <body>.
  const next = els.list.querySelector("button.rm") || els.addInput;
  next.focus();
});

els.filter.addEventListener("input", renderList);

function disarmClear() {
  clearTimeout(clearTimer);
  clearTimer = null;
  els.clearBtn.classList.remove("armed");
  els.clearBtn.textContent = "Clear all";
}

els.clearBtn.addEventListener("click", async () => {
  // Two-step confirm: no modal dialogs, no accidental wipes.
  if (!clearTimer) {
    els.clearBtn.classList.add("armed");
    els.clearBtn.textContent = `Confirm: remove all ${state.allowlist.length}`;
    clearTimer = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  const resp = await send({ action: "setAllowlist", value: [] });
  if (resp.ok) {
    render(resp.data);
    setMsg(els.addMsg, "Allowlist cleared.", "ok");
    els.addInput.focus();
  } else {
    setMsg(els.addMsg, "Couldn't clear: " + resp.error, "err");
  }
});
els.clearBtn.addEventListener("blur", () => { if (clearTimer) disarmClear(); });

els.bulkText.addEventListener("input", () => {
  bulkDirty = true;
  setMsg(els.bulkMsg, "");
});

els.bulkRevert.addEventListener("click", () => {
  bulkDirty = false;
  els.bulkText.value = state.allowlist.join("\n");
  setMsg(els.bulkMsg, "Reverted to the saved list.");
});

els.bulkSave.addEventListener("click", async () => {
  const lines = els.bulkText.value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const hosts = [];
  const rejected = [];
  for (const line of lines) {
    const h = hostFromInput(line);
    if (h) { if (!hosts.includes(h)) hosts.push(h); }
    else rejected.push(line);
  }
  if (rejected.length) {
    const preview = rejected.slice(0, 3).join(", ") + (rejected.length > 3 ? `, +${rejected.length - 3} more` : "");
    setMsg(els.bulkMsg, `Not saved. ${rejected.length} line${rejected.length === 1 ? " isn't a" : "s aren't"} valid site${rejected.length === 1 ? "" : "s"}: ${preview}`, "err");
    return;
  }
  if (hosts.length > MAX_ALLOWLIST) {
    setMsg(els.bulkMsg, `Not saved. The limit is ${MAX_ALLOWLIST} sites (you have ${hosts.length}).`, "err");
    return;
  }
  const resp = await send({ action: "setAllowlist", value: hosts });
  if (!resp.ok) {
    setMsg(els.bulkMsg, "Couldn't save: " + resp.error, "err");
    return;
  }
  bulkDirty = false;
  render(resp.data);
  setMsg(els.bulkMsg, `Saved ${resp.data.allowlist.length} site${resp.data.allowlist.length === 1 ? "" : "s"}.`, "ok");
});

// Stay in sync with changes made from the popup while this tab is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.enabled || changes.allowlist)) refresh();
});

/* --------------------------------- start ---------------------------------- */

(async function init() {
  els.ver.textContent = "v" + version();
  await refresh();
  const n = await getStaticRuleCount();
  els.ruleCount.textContent = n == null ? "—" : String(n);
})();
