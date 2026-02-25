// src/panel/panel.actions.js
import {
  getActiveTab,
  sendPanelCommand,
  sendRuntimeMessage
} from "../services/chrome-api.js";

export async function requireAuth(state, ui) {
  if (!state.session?.token) {
    ui.setStatusTitle("Login required");
    ui.setStatus("Please log in to use upload/scrape features.");
    return false;
  }
  return true;
}

export function createPanelActions({ state, ui, els }) {
  async function handleClear() {
    ui.clearPreviews();
    ui.setStatusTitle("Cleared.");
    ui.setStatus("");
  }

  async function handleClose() {
    await sendPanelCommand("STOP_PICK");
    await sendRuntimeMessage({ type: "REQUEST_TOGGLE_PANEL" });
  }

  async function handleToggleMinimize() {
    state.minimized = !state.minimized;
    document.body.classList.toggle("is-min", state.minimized);
    await chrome.storage.sync.set({ panelMin: state.minimized });
  }

  async function handleScrape() {
    if (!(await requireAuth(state, ui))) return;

    try {
      els.scrapeBtn.disabled = true;
      els.pickBtn.disabled = true;
      els.shotBtn.disabled = true;

      ui.setStatusTitle("Running...");
      ui.setStatus("Collecting images from the page...");

      const tab = await getActiveTab();
      const payload = {
        type: "SCRAPE_UPLOAD_V2",
        tabId: tab.id,
        options: {
          ...ui.readOptionsFromUI(),
          authToken: state.session?.token // optional if your background/backend needs it
        }
      };

      const res = await sendRuntimeMessage(payload);
      if (!res?.ok) throw new Error(res?.error || "Unknown error");

      const r = res.result;

      ui.setStatusTitle("Done.");
      ui.setStatus(
        [
          `Pages visited: ${r.pagesVisited}`,
          `Images discovered: ${r.discovered}`,
          `Uploaded: ${r.uploaded}`,
          `Skipped (duplicates): ${r.skippedDuplicates}`,
          `Skipped (filters): ${r.skippedFiltered}`,
          `Failures: ${r.failures?.length || 0}`,
          `Drive folder: ${r.driveFolderName || "(unknown)"}`,
          r.driveFolderId ? `Folder ID: ${r.driveFolderId}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      );

      ui.renderPreviews(r.previews || []);
    } catch (e) {
      ui.setStatusTitle("Error");
      ui.setStatus(e?.message || String(e));
    } finally {
      els.scrapeBtn.disabled = false;
      els.pickBtn.disabled = false;
      els.shotBtn.disabled = false;
    }
  }

  async function handlePick() {
    if (!(await requireAuth(state, ui))) return;

    try {
      ui.setStatusTitle("Pick mode");
      ui.setStatus("Click an image on the page to upload + preview.\nPress Esc to cancel on some sites.");
      await sendPanelCommand("START_PICK");
    } catch (e) {
      ui.setStatusTitle("Error");
      ui.setStatus(e?.message || String(e));
    }
  }

  async function handleScreenshot() {
    if (!(await requireAuth(state, ui))) return;

    try {
      ui.setStatusTitle("Screenshot");
      ui.setStatus("Drag a rectangle on the page to capture.\nThen it will upload + preview.");
      await sendPanelCommand("START_SCREENSHOT");
    } catch (e) {
      ui.setStatusTitle("Error");
      ui.setStatus(e?.message || String(e));
    }
  }

  return {
    handleClear,
    handleClose,
    handleToggleMinimize,
    handleScrape,
    handlePick,
    handleScreenshot
  };
}