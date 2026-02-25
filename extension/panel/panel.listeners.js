// src/panel/panel.listeners.js

export function attachRuntimeListeners({ ui }) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "PICK_UPLOAD_RESULT") {
      if (!msg.ok) {
        ui.setStatusTitle("Pick failed");
        ui.setStatus(msg.error || "Unknown error");
        return;
      }

      ui.setStatusTitle("Picked image uploaded");
      ui.setStatus(
        `Uploaded: ${msg.result?.fileName || "image"}\nDrive ID: ${msg.result?.driveFileId || "—"}`
      );
      ui.renderPreviews([msg.result]);
    }

    if (msg?.type === "SCREENSHOT_UPLOAD_RESULT") {
      if (!msg.ok) {
        ui.setStatusTitle("Screenshot failed");
        ui.setStatus(msg.error || "Unknown error");
        return;
      }

      ui.setStatusTitle("Screenshot uploaded");
      ui.setStatus(
        `Uploaded: ${msg.result?.fileName || "screenshot"}\nDrive ID: ${msg.result?.driveFileId || "—"}`
      );
      ui.renderPreviews([msg.result]);
    }
  });
}