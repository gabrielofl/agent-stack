import { state } from "./state.js";

export const ui = {
  el: (id) => document.getElementById(id),

  init() {
    this.logEl = this.el("log");
    this.screenEl = this.el("screen");

    this.dotHealth = this.el("dotHealth");
    this.dotWs = this.el("dotWs");
    this.dotFrame = this.el("dotFrame");
    this.dotErr = this.el("dotErr");
    this.dotAdmin = this.el("dotAdmin");

    this.healthText = this.el("healthText");
    this.wsText = this.el("wsText");
    this.frameText = this.el("frameText");
    this.fpsText = this.el("fpsText");
    this.errText = this.el("errText");

    this.fqdnEl = this.el("fqdn");
    this.backendHost = this.el("backendHost");
    this.pageUrl = this.el("pageUrl");
    this.vpText = this.el("vpText");
    this.clickText = this.el("clickText");
    this.sessionBadge = this.el("sessionBadge");

    this.metricsBadge = this.el("metricsBadge");
    this.originText = this.el("originText");
    this.httpText = this.el("httpText");
    this.wsUrlText = this.el("wsUrlText");
    this.sessionIdText = this.el("sessionIdText");

    this.adminPanel = this.el("adminPanel");
    this.adminBadge = this.el("adminBadge");
    this.adminBtn = this.el("adminBtn");
    this.adminBtnText = this.el("adminBtnText");

    this.modalBackdrop = this.el("modalBackdrop");
    this.adminPass = this.el("adminPass");
    this.modalHint = this.el("modalHint");
    this.modalCancel = this.el("modalCancel");
    this.modalLogin = this.el("modalLogin");
  },

  setDot(dot, stateName) {
    dot.classList.remove("good","warn","bad");
    dot.classList.add(stateName);
  },

  log(line, level="info") {
    if (!this.logEl) return;
    const ts = new Date().toISOString().replace("T"," ").replace("Z","");
    const prefix = level === "error" ? "✖" : level === "warn" ? "⚠" : "•";
    this.logEl.textContent += `${prefix} [${ts}] ${line}\n`;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  },

  setError(msg) {
    state.lastError = msg || "";
    if (!msg) {
      this.setDot(this.dotErr, "good");
      this.errText.textContent = "none";
    } else {
      this.setDot(this.dotErr, "bad");
      this.errText.textContent = msg.length > 28 ? msg.slice(0,28) + "…" : msg;
    }
  },

  setAdminMode(on) {
    state.isAdmin = !!on;
    this.adminPanel.hidden = !state.isAdmin;
    this.adminBadge.hidden = !state.isAdmin;
    this.adminBtnText.textContent = state.isAdmin ? "Logout" : "Admin";
    this.setDot(this.dotAdmin, state.isAdmin ? "good" : "warn");
  },

  updateMetrics() {
    if (!this.metricsBadge) return;
    this.metricsBadge.textContent = `frames: ${state.frames} • bytes: ${formatBytes(state.bytes)}`;
  }
};

function formatBytes(n){
  const u = ["B","KB","MB","GB"]; let i=0; let x=n;
  while (x>=1024 && i<u.length-1){ x/=1024; i++; }
  return `${x.toFixed(i?1:0)}${u[i]}`;
}
