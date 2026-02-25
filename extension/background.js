// background.js (service worker, MV3)
import { EXT_CONFIG } from "./config.js";
import { performSiteLogin } from "./loginHelper.js";

/* --------------------------
   AUTH
-------------------------- */
async function getAuthToken(interactive = true) {
  const result = await chrome.identity.getAuthToken({ interactive });
  if (typeof result === "string") return result;
  if (result?.token) return result.token;
  throw new Error("Failed to get OAuth token.");
}

/* --------------------------
   UTIL
-------------------------- */
function sanitizeName(name) {
  return (name || "image")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function extFromMime(contentType) {
  if (!contentType) return "bin";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("svg")) return "svg";
  return "bin";
}

async function sha256HexFromBlob(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function allowedMime(blobType, allowedTypes) {
  if (!allowedTypes || !allowedTypes.length) return true;
  return allowedTypes.includes(blobType);
}

function shouldFilterByDimensions(meta, minWidth, minHeight) {
  const w = Number(meta.width || 0);
  const h = Number(meta.height || 0);
  if (w && w < minWidth) return true;
  if (h && h < minHeight) return true;
  return false;
}

function todayFolderName(prefix) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${prefix || "Site Images"} ${yyyy}-${mm}-${dd}`;
}

function buildMultipartBody(metadata, blob, boundary) {
  const metaPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n`;

  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`;

  const endPart = `\r\n--${boundary}--`;

  return new Blob([metaPart, fileHeader, blob, endPart], {
    type: `multipart/related; boundary=${boundary}`
  });
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = String(dataUrl).split(",");
  const mime = meta.match(/data:(.*?);base64/)?.[1] || "image/png";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

/* --------------------------
   DRIVE API HELPERS
-------------------------- */
async function driveFetchJson(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API error (${res.status}): ${text}`);
  }

  return res.json();
}

async function findOrCreateDriveFolder({ token, name, parentFolderId }) {
  const parentClause = parentFolderId ? `'${parentFolderId}' in parents` : `'root' in parents`;

  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
    `name='${name.replace(/'/g, "\\'")}'`,
    parentClause
  ].join(" and ");

  const searchUrl =
    `https://www.googleapis.com/drive/v3/files?fields=files(id,name)&q=${encodeURIComponent(q)}&pageSize=10`;

  const search = await driveFetchJson(token, searchUrl);
  if (search.files && search.files.length) return search.files[0];

  const body = {
    name,
    mimeType: "application/vnd.google-apps.folder"
  };
  if (parentFolderId) body.parents = [parentFolderId];

  return driveFetchJson(token, "https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function uploadToDrive({ token, blob, fileName, folderId }) {
  const boundary = "boundary_" + Math.random().toString(36).slice(2);

  const metadata = { name: fileName };
  if (folderId) metadata.parents = [folderId];

  const body = buildMultipartBody(metadata, blob, boundary);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }

  return res.json();
}

/* --------------------------
   BACKEND TRANSFORM
-------------------------- */
async function transformWithBackend({ blob, fileName }) {
  const backendCfg = EXT_CONFIG?.backend;
  if (!backendCfg?.enabled) return null;

  const baseUrl = String(backendCfg.baseUrl || "").replace(/\/$/, "");
  const endpoint = backendCfg.transformEndpoint || "/api/transform-image";
  if (!baseUrl) throw new Error("Backend enabled but baseUrl is missing in config");

  const url = `${baseUrl}${endpoint}`;
  const form = new FormData();
  form.append("image", blob, fileName);

  const headers = {};
  if (backendCfg.authToken) headers["Authorization"] = `Bearer ${backendCfg.authToken}`;

  const res = await fetch(url, { method: "POST", headers, body: form });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Backend transform failed (${res.status}): ${txt}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.startsWith("image/")) {
    const outBlob = await res.blob();
    return { mode: "blob", blob: outBlob, mime: outBlob.type || contentType };
  }

  const json = await res.json();

  if (json.imageBase64) {
    return { mode: "base64", base64: json.imageBase64, mime: json.mime || "image/png" };
  }
  if (json.imageUrl) {
    return { mode: "url", url: json.imageUrl };
  }

  throw new Error("Backend response missing transformed image");
}

/* --------------------------
   SCRAPE / PAGINATION
-------------------------- */
async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function collectAcrossPages(tabId, { selector, nextSelector, maxPages, pageWaitMs }) {
  const all = [];
  const visited = new Set();
  let pagesVisited = 0;

  for (let pageNum = 1; pageNum <= Math.max(1, maxPages); pageNum++) {
    const res = await sendToTab(tabId, { type: "GET_IMAGES_ON_PAGE", selector });
    if (!res?.ok) throw new Error(res?.error || "Failed collecting images");

    const pageUrl = res.pageUrl || `page-${pageNum}`;
    if (visited.has(pageUrl)) break;
    visited.add(pageUrl);

    pagesVisited++;
    for (const img of res.images || []) all.push(img);

    if (!nextSelector || pageNum >= maxPages) break;

    const nextRes = await sendToTab(tabId, {
      type: "CLICK_NEXT_PAGE",
      nextSelector,
      waitMs: pageWaitMs
    });

    if (!nextRes?.ok) break;
    if (nextRes.ok === false) break;
    if (nextRes.reason) break;
  }

  const seen = new Set();
  const unique = all.filter((i) => {
    if (!i?.url || seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });

  return { images: unique, pagesVisited };
}

/* --------------------------
   DUPLICATES (hash store)
-------------------------- */
function getHashStoreKey(origin) {
  const scope = EXT_CONFIG?.duplicates?.scope || "origin";
  if (scope === "global") return "img_hashes::global";
  return `img_hashes::${origin}`;
}

async function loadHashSet(origin) {
  const key = getHashStoreKey(origin);
  const obj = await chrome.storage.local.get([key]);
  const arr = Array.isArray(obj[key]) ? obj[key] : [];
  return { key, set: new Set(arr) };
}

async function saveHashSet(key, set) {
  const max = Number(EXT_CONFIG?.duplicates?.maxHashesStored || 5000);
  const arr = Array.from(set).slice(-max);
  await chrome.storage.local.set({ [key]: arr });
}

/* --------------------------
   IMAGE FETCH
-------------------------- */
async function fetchImageBlob(url) {
  const res = await fetch(url, { method: "GET", credentials: "include" });
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  return res.blob();
}

function makeFileName(imgMeta, blobType, index) {
  const ext = extFromMime(blobType);
  const pageTitle = sanitizeName(imgMeta.pageTitle || "page");
  let base = "";

  try {
    const u = new URL(imgMeta.url);
    base = sanitizeName((u.pathname.split("/").pop() || "").replace(/\.[a-zA-Z0-9]+$/, ""));
  } catch {
    base = "";
  }

  if (!base) base = sanitizeName(imgMeta.alt || `image_${index}`);
  return `${pageTitle}__${base}.${ext}`;
}

/* --------------------------
   SINGLE UPLOAD HELPERS (pick/screenshot)
-------------------------- */
async function getOrCreateTodayFolder({ token, parentFolderId }) {
  const folderPrefix = EXT_CONFIG.google?.folderPrefix || "Site Images";
  return findOrCreateDriveFolder({
    token,
    name: todayFolderName(folderPrefix),
    parentFolderId: parentFolderId || undefined
  });
}

async function uploadOneAndPreview({ token, blob, fileName, folderId, sourceUrl }) {
  const originalDataUrl = await blobToDataUrl(blob);

  const driveUpload = await uploadToDrive({
    token,
    blob,
    fileName,
    folderId
  });

  let transformed = null;
  try {
    const out = await transformWithBackend({ blob, fileName });
    if (out) {
      if (out.mode === "blob") transformed = { dataUrl: await blobToDataUrl(out.blob) };
      else if (out.mode === "base64") transformed = { dataUrl: `data:${out.mime};base64,${out.base64}` };
      else if (out.mode === "url") transformed = { url: out.url };
    }
  } catch {
    transformed = null;
  }

  return {
    sourceUrl: sourceUrl || "",
    fileName,
    originalDataUrl,
    transformed,
    driveFileId: driveUpload?.id || null
  };
}

/* --------------------------
   MAIN SCRAPE
-------------------------- */
async function scrapeUploadV2({ tabId, options }) {
  const token = await getAuthToken(true);

  const selector = options?.selector ?? EXT_CONFIG.site?.imageSelector ?? "img";
  const nextSelector = options?.nextSelector ?? EXT_CONFIG.site?.nextSelector ?? "";
  const maxPages = Number(options?.maxPages ?? EXT_CONFIG.site?.maxPages ?? 1);
  const pageWaitMs = Number(options?.pageWaitMs ?? EXT_CONFIG.site?.pageWaitMs ?? 2500);

  const minWidth = Number(options?.minWidth ?? EXT_CONFIG.filters?.minWidth ?? 64);
  const minHeight = Number(options?.minHeight ?? EXT_CONFIG.filters?.minHeight ?? 64);
  const minBytes = Number(options?.minBytes ?? EXT_CONFIG.filters?.minBytes ?? 10 * 1024);
  const allowedTypes = options?.allowedTypes ?? EXT_CONFIG.filters?.allowedTypes ?? ["image/jpeg", "image/png", "image/webp"];
  const parentFolderId = String(options?.parentFolderId ?? EXT_CONFIG.google?.parentFolderId ?? "").trim();

  await performSiteLogin(tabId, EXT_CONFIG.login);

  const { images, pagesVisited } = await collectAcrossPages(tabId, {
    selector,
    nextSelector,
    maxPages,
    pageWaitMs
  });

  const tab = await chrome.tabs.get(tabId);
  const origin = (() => {
    try { return new URL(tab.url || "").origin; } catch { return "unknown-origin"; }
  })();

  const { key: hashKey, set: knownHashes } = await loadHashSet(origin);

  const folder = await getOrCreateTodayFolder({ token, parentFolderId });

  let uploaded = 0;
  let skippedDuplicates = 0;
  let skippedFiltered = 0;
  const failures = [];
  const previews = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    try {
      if (shouldFilterByDimensions(img, minWidth, minHeight)) {
        skippedFiltered++;
        continue;
      }

      const blob = await fetchImageBlob(img.url);

      if (blob.size < minBytes) {
        skippedFiltered++;
        continue;
      }

      if (!allowedMime(blob.type, allowedTypes)) {
        skippedFiltered++;
        continue;
      }

      const hash = await sha256HexFromBlob(blob);
      if (knownHashes.has(hash)) {
        skippedDuplicates++;
        continue;
      }

      const fileName = makeFileName(img, blob.type, i + 1);

      const previewObj = await uploadOneAndPreview({
        token,
        blob,
        fileName,
        folderId: folder.id,
        sourceUrl: img.url
      });

      uploaded++;
      knownHashes.add(hash);
      previews.push(previewObj);
    } catch (e) {
      failures.push({ url: img.url, error: e.message || String(e) });
    }
  }

  await saveHashSet(hashKey, knownHashes);

  return {
    pagesVisited,
    discovered: images.length,
    uploaded,
    skippedDuplicates,
    skippedFiltered,
    failures,
    driveFolderId: folder.id,
    driveFolderName: folder.name,
    previews
  };
}

/* --------------------------
   PANEL TOGGLE
-------------------------- */
async function togglePanelForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const url = tab.url || "";

  // A lot more cases than just chrome://
  const restricted =
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("brave://") ||
    url.startsWith("opera://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("view-source:") ||
    url.startsWith("file://") || // unless you enabled file access for the extension
    url.includes("chromewebstore.google.com") ||
    url.includes("chrome.google.com/webstore");

  if (restricted) {
    console.warn("Cannot run on this page:", url);
    try {
      await chrome.action.setTitle({
        tabId: tab.id,
        title: "Open a normal webpage tab to use this extension"
      });
    } catch {}
    return;
  }

  // Helper: check if content script is alive
  const ping = async () => {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
      return res?.ok === true;
    } catch {
      return false;
    }
  };

  // 1) If it's already there, just toggle
  if (await ping()) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOATING_PANEL" });
    } catch (e) {
      console.warn("toggle sendMessage failed even though ping worked:", e);
    }
    return;
  }

  // 2) Try inject
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (e) {
    console.error("executeScript failed:", e, "url:", url);
    return;
  }

  // 3) Confirm it injected
  if (!(await ping())) {
    console.error("content.js still not reachable after injection. url:", url);
    return;
  }

  // 4) Toggle
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOATING_PANEL" });
  } catch (e) {
    console.warn("toggle after injection failed:", e);
  }
}

chrome.action.onClicked.addListener(() => {
  // critical: don’t await here so no unhandled promise bubbles up
  togglePanelForActiveTab();
});

/* --------------------------
   MESSAGE HANDLER
-------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Panel asked to close itself (toggle iframe off)
  if (msg?.type === "REQUEST_TOGGLE_PANEL") {
    (async () => {
      await togglePanelForActiveTab();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Panel -> Content Script relay
  if (msg?.type === "PANEL_COMMAND") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab");
        await chrome.tabs.sendMessage(tab.id, { type: "PANEL_COMMAND", command: msg.command });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  // Content script requests a screenshot of visible area
  if (msg?.type === "CAPTURE_VISIBLE") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) throw new Error("No active tab");

        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        sendResponse({ ok: true, tabId: tab.id, dataUrl });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  // Picked image from content script -> upload + preview -> send to panel
  if (msg?.type === "PICKED_IMAGE") {
    (async () => {
      try {
        const token = await getAuthToken(true);
        const parentFolderId = String(EXT_CONFIG.google?.parentFolderId || "").trim();

        const folder = await getOrCreateTodayFolder({ token, parentFolderId });

        const src = msg?.info?.src;
        if (!src) throw new Error("Picked image had no src");

        const blob = await fetchImageBlob(src);
        const fileName = `${sanitizeName("picked")}_${Date.now()}.${extFromMime(blob.type)}`;

        const result = await uploadOneAndPreview({
          token,
          blob,
          fileName,
          folderId: folder.id,
          sourceUrl: src
        });

        chrome.runtime.sendMessage({ type: "PICK_UPLOAD_RESULT", ok: true, result });
      } catch (e) {
        chrome.runtime.sendMessage({ type: "PICK_UPLOAD_RESULT", ok: false, error: e.message || String(e) });
      }
    })();

    sendResponse?.({ ok: true });
    return true;
  }

  // Screenshot crop from content script -> upload + preview -> send to panel
  if (msg?.type === "SCREENSHOT_CROPPED") {
    (async () => {
      try {
        const token = await getAuthToken(true);
        const parentFolderId = String(EXT_CONFIG.google?.parentFolderId || "").trim();
        const folder = await getOrCreateTodayFolder({ token, parentFolderId });

        const dataUrl = msg?.dataUrl;
        if (!dataUrl) throw new Error("Missing cropped dataUrl");

        const blob = dataUrlToBlob(dataUrl);
        const fileName = `screenshot_${Date.now()}.png`;

        const result = await uploadOneAndPreview({
          token,
          blob,
          fileName,
          folderId: folder.id,
          sourceUrl: msg?.pageUrl || "screenshot"
        });

        chrome.runtime.sendMessage({ type: "SCREENSHOT_UPLOAD_RESULT", ok: true, result });
      } catch (e) {
        chrome.runtime.sendMessage({ type: "SCREENSHOT_UPLOAD_RESULT", ok: false, error: e.message || String(e) });
      }
    })();

    sendResponse?.({ ok: true });
    return true;
  }

  // Your original scrape command
  if (msg?.type === "SCRAPE_UPLOAD_V2") {
    (async () => {
      try {
        const result = await scrapeUploadV2({
          tabId: msg.tabId,
          options: msg.options || {}
        });
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true; // async response
  }
});