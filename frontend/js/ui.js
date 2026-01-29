// ui.js
import { state } from "./state.js";

export const ui = {
  el: (id) => document.getElementById(id),

  init() {
    // Viewer
    this.screenEl = this.el("screen");
    this.overlay = this.el("overlay");
    this.ctx = this.overlay?.getContext?.("2d");
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

    // Tabs
    this.tabUserBtn = this.el("tabUserBtn");
    this.tabAdminBtn = this.el("tabAdminBtn");
    this.tabUser = this.el("tab-user");
    this.tabAgent = this.el("tab-agent");
    this.tabAdmin = this.el("tab-admin");

    // Logs
    this.userLogEl = this.el("userLog");
	  this.adminLogEl = this.el("adminLog");
	  this.agentLogEl = this.el("agentLog") || this.el("agentFeed");

    // Admin/debug fields
    this.metricsBadge = this.el("metricsBadge");
    this.originText = this.el("originText");
    this.httpText = this.el("httpText");
    this.wsUrlText = this.el("wsUrlText");
    this.sessionIdText = this.el("sessionIdText");

// Agent summary + controls (support both old + new ids)
this.agentStateText = this.el("agentStateText") || this.el("agentState");
this.agentStepText  = this.el("agentStepText")  || this.el("agentStep");
this.agentLastText  = this.el("agentLastText")  || this.el("agentLast");
this.btnApprove = this.el("btnApprove");
this.btnAsk = this.el("btnAsk");


    // Admin buttons
    this.btnCopy = this.el("btnCopy");
    this.btnClear = this.el("btnClear");

    // Tab behavior
    const setTab = (name) => this.setActiveTab(name);
    this.tabUserBtn?.addEventListener("click", () => setTab("user"));
    this.tabAdminBtn?.addEventListener("click", () => setTab("admin"));

    // Default tab
    this.setActiveTab("user");

    // Admin copy/clear
    this.btnClear?.addEventListener("click", () => {
      if (this.adminLogEl) this.adminLogEl.textContent = "";
    });
    this.btnCopy?.addEventListener("click", async () => {
      const text = this.adminLogEl?.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        this.adminLog("Copied admin log.");
      } catch {
        this.adminLog("Copy failed (clipboard blocked).", "warn");
      }
    });
  },

  setActiveTab(name) {
    const show = (el, on) => { if (el) el.hidden = !on; };

    show(this.tabUser, name === "user");
    show(this.tabAdmin, name === "admin");

    // Button styles (basic “active” class)
    const mark = (btn, on) => {
      if (!btn) return;
      btn.classList.toggle("active", !!on);
    };
    mark(this.tabUserBtn, name === "user");
    mark(this.tabAdminBtn, name === "admin");
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

  // Admin mode: show the admin tab (not the whole panel)
  setAdminMode(on) {
    state.isAdmin = !!on;

    if (this.adminBtnText) this.adminBtnText.textContent = state.isAdmin ? "Logout" : "Login";
    this.setDot(this.dotAdmin, state.isAdmin ? "good" : "warn");

    if (this.tabAdminBtn) this.tabAdminBtn.hidden = !state.isAdmin;
    if (!state.isAdmin && this.tabAdmin && !this.tabAdmin.hidden) {
      // if admin tab was open, kick back to user tab
      this.setActiveTab("user");
    }

    // Enable agent buttons only when admin
    if (this.btnApprove) this.btnApprove.disabled = !state.isAdmin || !state.pendingStepId;
    if (this.btnAsk) this.btnAsk.disabled = !state.isAdmin;
  },

  updateStatusMenu() {
    if (this.httpLine) this.httpLine.textContent = state.lastHttp || "—";
    if (this.wsLine) this.wsLine.textContent = state.lastWs || "—";
    if (this.frameLine) this.frameLine.textContent = state.lastFrameAt
      ? new Date(state.lastFrameAt).toLocaleTimeString()
      : "—";
    if (this.fpsLine) this.fpsLine.textContent =
      (state.fps ?? 0).toFixed ? (state.fps ?? 0).toFixed(1) : String(state.fps ?? 0);
    if (this.errLine) this.errLine.textContent = state.lastError ? state.lastError : "none";

    // Admin-only line
    if (state.isAdmin && this.httpText) this.httpText.textContent = state.lastHttp || "";
  },

  setOverallOk(ok) {
    this.setDot(this.dotStatus, ok ? "good" : "bad");
  },

  setError(msg) {
    state.lastError = msg || "";
    this.updateStatusMenu();
  },

  // -------------------- Feeds --------------------
  pushUserFeed(line, level = "info") {
    this._pushTo(this.userLogEl, line, level);
  },

  pushAgentFeed(line, level = "info") {
    this._pushTo(this.agentLogEl, line, level);
  },

  adminLog(line, level = "info") {
    if (!state.isAdmin) return;
    this._pushTo(this.adminLogEl, line, level);
  },

  _pushTo(el, line, level) {
    if (!el) return;
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const prefix = level === "error" ? "✖" : level === "warn" ? "⚠" : "•";
    el.textContent += `${prefix} [${ts}] ${line}\n`;
    el.scrollTop = el.scrollHeight;
  },

  setAgentSummary({ stateText, stepText, lastText }) {
    if (this.agentStateText) this.agentStateText.textContent = stateText || "—";
    if (this.agentStepText) this.agentStepText.textContent = stepText || "—";
    if (this.agentLastText) this.agentLastText.textContent = lastText || "—";
  },

  updateMetrics() {
    if (!this.metricsBadge) return;
    this.metricsBadge.textContent = `frames: ${state.frames} • bytes: ${formatBytes(state.bytes)}`;
  },

  // -------------------- Overlays (unchanged from your version) --------------------
  renderOverlays() {
    if (!this.overlay || !this.ctx || !this.screenEl) return;
    const ctx = this.ctx;

    const rect = this.screenEl.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (this.overlay.width !== w) this.overlay.width = w;
    if (this.overlay.height !== h) this.overlay.height = h;

    ctx.clearRect(0, 0, w, h);

    const vx = state.viewport?.width || 1280;
    const vy = state.viewport?.height || 720;

    const toCanvas = (x, y) => ({ x: (x / vx) * w, y: (y / vy) * h });

    if (state.lastProposedAction?.type === "click") {
      const p = toCanvas(state.lastProposedAction.x, state.lastProposedAction.y);
      ctx.fillStyle = "rgba(255, 215, 0, 0.35)";
      ctx.strokeStyle = "rgba(255, 215, 0, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    if (state.lastExecutedAction?.type === "click") {
      const p = toCanvas(state.lastExecutedAction.x, state.lastExecutedAction.y);
      ctx.fillStyle = "rgba(0, 200, 0, 0.25)";
      ctx.strokeStyle = "rgba(0, 200, 0, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    const els = state.lastElements || [];
    ctx.strokeStyle = "rgba(0, 160, 255, 0.35)";
    ctx.lineWidth = 1;
    for (const e of els.slice(0, 20)) {
      const tl = toCanvas(e.x - e.w / 2, e.y - e.h / 2);
      const br = toCanvas(e.x + e.w / 2, e.y + e.h / 2);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    }
  },
};

function formatBytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 1 : 0)}${u[i]}`;
}
