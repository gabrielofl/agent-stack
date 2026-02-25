/* =========================================================
   content.js — single content script (FINAL)
   - Floating panel iframe toggle
   - Pick image on page
   - Screenshot selection crop
   - PING responder for background reachability checks
========================================================= */

// ---------- PING (background uses this to verify receiver exists)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true });
    return;
  }
});

// ---------- Panel iframe
let panelEl = null;

function ensurePanel() {
  if (panelEl && document.documentElement.contains(panelEl)) return panelEl;

  const iframe = document.createElement("iframe");
  iframe.src = chrome.runtime.getURL("panel.html");
  iframe.id = "wiguru-floating-panel";

  Object.assign(iframe.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    width: "420px",
    height: "640px",
    border: "0",
    borderRadius: "16px",
    zIndex: "2147483647", // very top
    boxShadow: "0 10px 30px rgba(0,0,0,.35)",
    background: "transparent",
    pointerEvents: "auto"
  });

  document.documentElement.appendChild(iframe);
  panelEl = iframe;
  return panelEl;
}

function togglePanel() {
  const iframe = ensurePanel();
  iframe.style.display = iframe.style.display === "none" ? "block" : "none";
}

// ---------- Global message handler
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TOGGLE_FLOATING_PANEL") togglePanel();

  if (msg?.type === "PANEL_COMMAND") {
    if (msg.command === "START_PICK") startPickMode();
    if (msg.command === "STOP_PICK") stopPickMode();
    if (msg.command === "START_SCREENSHOT") startScreenSelect();
  }
});

// =========================================================
// PICK MODE
// =========================================================
let pickMode = false;
let pickHandler = null;
let pickKeyHandler = null;

function startPickMode() {
  if (pickMode) return;
  pickMode = true;

  // Ensure panel exists but do not force it visible
  if (panelEl) panelEl.style.pointerEvents = "auto";

  document.documentElement.style.cursor = "crosshair";

  pickHandler = (e) => {
    const el = e.target;

    // If user clicks inside the panel iframe, ignore
    if (panelEl && (el === panelEl || panelEl.contains(el))) return;

    if (el && el.tagName === "IMG") {
      e.preventDefault();
      e.stopPropagation();

      const src = el.currentSrc || el.src;
      const info = {
        src,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
        pageUrl: location.href
      };

      chrome.runtime.sendMessage({ type: "PICKED_IMAGE", info });
      stopPickMode();
    }
  };

  // Capture phase so it works on sites with click handlers
  window.addEventListener("click", pickHandler, true);

  pickKeyHandler = (ev) => {
    if (ev.key === "Escape") stopPickMode();
  };
  window.addEventListener("keydown", pickKeyHandler, true);
}

function stopPickMode() {
  if (!pickMode) return;
  pickMode = false;

  document.documentElement.style.cursor = "";

  if (pickHandler) window.removeEventListener("click", pickHandler, true);
  if (pickKeyHandler) window.removeEventListener("keydown", pickKeyHandler, true);

  pickHandler = null;
  pickKeyHandler = null;
}

// =========================================================
// SCREENSHOT SELECTION
// =========================================================
let selecting = false;
let overlay = null;
let box = null;
let startX = 0;
let startY = 0;
let shotKeyHandler = null;

// z-index below panel so panel stays clickable
const OVERLAY_Z = 2147483646;

function makeOverlay() {
  removeOverlay();

  overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: String(OVERLAY_Z),
    cursor: "crosshair",
    background: "rgba(0,0,0,0.10)",
    pointerEvents: "auto"
  });

  box = document.createElement("div");
  Object.assign(box.style, {
    position: "absolute",
    border: "2px solid #fd008e",
    background: "rgba(253,0,142,0.12)",
    borderRadius: "10px"
  });

  overlay.appendChild(box);
  document.documentElement.appendChild(overlay);
}

function removeOverlay() {
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  overlay = null;
  box = null;

  if (shotKeyHandler) {
    window.removeEventListener("keydown", shotKeyHandler, true);
    shotKeyHandler = null;
  }
}

async function startScreenSelect() {
  if (selecting) return;
  selecting = true;
  makeOverlay();

  // ESC cancels selection
  shotKeyHandler = (ev) => {
    if (ev.key === "Escape") {
      selecting = false;
      removeOverlay();
    }
  };
  window.addEventListener("keydown", shotKeyHandler, true);

  const onDown = (e) => {
    startX = e.clientX;
    startY = e.clientY;
    Object.assign(box.style, {
      left: `${startX}px`,
      top: `${startY}px`,
      width: "0px",
      height: "0px"
    });
  };

  const onMove = (e) => {
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    Object.assign(box.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`
    });
  };

  const onUp = async (e) => {
    overlay.removeEventListener("mousedown", onDown);
    overlay.removeEventListener("mousemove", onMove);
    overlay.removeEventListener("mouseup", onUp);

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    selecting = false;
    removeOverlay();

    if (w < 5 || h < 5) return;

    const dpr = window.devicePixelRatio || 1;

    // Ask background for screenshot of visible tab
    const cap = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE" });
    if (!cap?.ok || !cap.dataUrl) return;

    // Crop locally
    const cropped = await cropDataUrl(
      cap.dataUrl,
      x * dpr,
      y * dpr,
      w * dpr,
      h * dpr
    );

    chrome.runtime.sendMessage({
      type: "SCREENSHOT_CROPPED",
      dataUrl: cropped,
      pageUrl: location.href
    });
  };

  overlay.addEventListener("mousedown", onDown);
  overlay.addEventListener("mousemove", onMove);
  overlay.addEventListener("mouseup", onUp);
}

function cropDataUrl(dataUrl, sx, sy, sw, sh) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.floor(sw));
      c.height = Math.max(1, Math.floor(sh));
      const ctx = c.getContext("2d");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}