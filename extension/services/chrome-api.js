// src/services/chrome-api.js

export async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("No active tab found.");
  return tabs[0];
}

export async function sendRuntimeMessage(payload) {
  return chrome.runtime.sendMessage(payload);
}

export async function sendPanelCommand(command) {
  return chrome.runtime.sendMessage({ type: "PANEL_COMMAND", command });
}

export async function getSync(keys) {
  return chrome.storage.sync.get(keys);
}

export async function setSync(obj) {
  return chrome.storage.sync.set(obj);
}

export async function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

export async function setLocal(obj) {
  return chrome.storage.local.set(obj);
}

export async function removeLocal(keys) {
  return chrome.storage.local.remove(keys);
}