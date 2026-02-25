// src/panel/panel.dom.js

export function getPanelEls() {
  return {
    // Status + preview
    statusTitleEl: document.getElementById("statusTitle"),
    statusEl: document.getElementById("status"),
    previewListEl: document.getElementById("previewList"),

    // Main buttons
    pickBtn: document.getElementById("pickBtn"),
    shotBtn: document.getElementById("shotBtn"),
    scrapeBtn: document.getElementById("scrapeBtn"),

    // Header buttons
    closeBtn: document.getElementById("closeBtn"),
    minBtn: document.getElementById("minBtn"),
    clearBtn: document.getElementById("clearBtn"),

    // Advanced settings
    advancedDetails: document.getElementById("advancedDetails"),
    selectorEl: document.getElementById("selector"),
    nextSelectorEl: document.getElementById("nextSelector"),
    maxPagesEl: document.getElementById("maxPages"),
    pageWaitMsEl: document.getElementById("pageWaitMs"),
    minWidthEl: document.getElementById("minWidth"),
    minHeightEl: document.getElementById("minHeight"),
    minKbEl: document.getElementById("minKb"),
    typesEl: document.getElementById("types"),
    parentFolderIdEl: document.getElementById("parentFolderId"),

    // Auth UI (add these IDs to panel.html)
    authContainerEl: document.getElementById("authContainer"),
    authLoggedOutEl: document.getElementById("authLoggedOut"),
    authLoggedInEl: document.getElementById("authLoggedIn"),
    authEmailEl: document.getElementById("authEmail"),
    authPasswordEl: document.getElementById("authPassword"),
    authNameEl: document.getElementById("authName"),
    loginBtnEl: document.getElementById("loginBtn"),
    registerBtnEl: document.getElementById("registerBtn"),
    logoutBtnEl: document.getElementById("logoutBtn"),
    authUserLabelEl: document.getElementById("authUserLabel"),
	authStatusEl: document.getElementById("authStatus"),
	
	authScreenEl: document.getElementById("authScreen"),
	appScreenEl: document.getElementById("appScreen"),
	continueBtnEl: document.getElementById("continueBtn"),
	appLogoutBtnEl: document.getElementById("appLogoutBtn"),
	authNameFieldEl: document.getElementById("authNameField"),
  };
}