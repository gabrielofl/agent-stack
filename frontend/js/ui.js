// ui.js
import { state } from "./state.js";

export const ui = {
  el: (id) => document.getElementById(id),

  init() {
    // Viewer
    this.screenEl = this.el("screen");
    this.pageUrl = this.el("pageUrl");
    this.clickText = this.el("clickText");
    this.sessionDot = this.el("sessionDot");

    // Top actions
    this.statusBtn = this.el("statusBtn");
    this.statusMenu = this.el("statusMenu");
    this.dotStatus = this.el("dotStatus");

    this.adminBtn = this.el("adminBtn");
    this.adminBtnText = this.el("adminBtnText");
    this.dotAdmin = this.el("dotAdmin");

    // Status dropdown lines
    this.httpLine = this.el("httpLine");
    this.wsLine = this.el("wsLine");
    this.frameLine = this.el("frameLine");
    this.fpsLine = this.el("fpsLine");
    this.errLine = this.el("errLine");

    // Modal
    this.modalBackdrop = this.el("modalBackdrop");
    this.adminPass = this.el("adminPass");
    this.modalHint = this.el("modalHint");
    this.modalCancel = this.el("modalCancel");
    this.modalLogin = this.el("modalLogin");

    // Admin panel (optional, only shown when admin)
    this.adminPanel = this.el("adminPanel");
    this.logEl = this.el("log");
    this.metricsBadge = this.el("metricsBadge");
    this.originText = this.el("originText");
    this.httpText = this.el("httpText");
    this.wsUrlText = this.el("wsUrlText");
    this.sessionIdText = this.el("sessionIdText"); // you can remove later if you want
  },

  setDot(dot, stateName) {
    if (!dot) return;
    dot.classList.remove("good", "warn", "bad");
    dot.classList.add(stateName);
  },

  setSessionActive(on) {
    if (!this.sessionDot) return;
    this.sessionDot.classList.toggle("on", !!on);
    this.sessionDot.classList.toggle("off", !on);
  },

  // Admin mode toggles the debug panel only
  setAdminMode(on) {
    state.isAdmin = !!on;
    if (this.adminPanel) this.adminPanel.hidden = !state.isAdmin;

    if (this.adminBtnText) this.adminBtnText.textContent = state.isAdmin ? "Logout" : "Login";
    this.setDot(this.dotAdmin, state.isAdmin ? "good" : "warn");
  },

  updateStatusMenu() {
    if (this.httpLine) this.httpLine.textContent = state.lastHttp || "—";
    if (this.wsLine) this.wsLine.textContent = state.lastWs || "—";
    if (this.frameLine) this.frameLine.textContent = state.lastFrameAt
      ? new Date(state.lastFrameAt).toLocaleTimeString()
      : "—";
    if (this.fpsLine) this.fpsLine.textContent = (state.fps ?? 0).toFixed ? (state.fps ?? 0).toFixed(1) : String(state.fps ?? 0);
    if (this.errLine) this.errLine.textContent = state.lastError ? state.lastError : "none";

    // Admin debug-only line (optional)
    if (state.isAdmin && this.httpText) this.httpText.textContent = state.lastHttp || "";
  },

  setOverallOk(ok) {
    this.setDot(this.dotStatus, ok ? "good" : "bad");
  },

  setError(msg) {
    state.lastError = msg || "";
    this.updateStatusMenu();
  },

  log(line, level = "info") {
    if (!this.logEl) return;
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const prefix = level === "error" ? "✖" : level === "warn" ? "⚠" : "•";
    this.logEl.textContent += `${prefix} [${ts}] ${line}\n`;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  },

  updateMetrics() {
    if (!this.metricsBadge) return;
    this.metricsBadge.textContent = `frames: ${state.frames} • bytes: ${formatBytes(state.bytes)}`;
  }
};

function formatBytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 1 : 0)}${u[i]}`;
}
