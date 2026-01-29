// main.js
import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { ui } from "./ui.js";
import { api } from "./api.js";
import { wsClient } from "./ws.js";
import { auth } from "./auth.js";

ui.init();

// Backend fqdn (still used, but no longer shown)
state.backendFqdn = api.normalizeFqdn(localStorage.getItem("backendFqdn") || CONFIG.DEFAULT_BACKEND_FQDN);

// Optional admin debug
if (ui.originText) ui.originText.textContent = location.origin;

// Default UI state
ui.setAdminMode(false);
ui.setSessionActive(false);

// Auth bootstrap
auth.init();

function recomputeOverall() {
  const healthOk = state.lastHealthOk === true;
  const wsOk = state.ws && state.ws.readyState === 1;
  const frameOk =
    !state.session || !state.lastFrameAt
      ? true
      : (Date.now() - state.lastFrameAt) < CONFIG.FRAME_STALE_MS;

  const ok = healthOk && wsOk && frameOk && !state.lastError;
  ui.setOverallOk(ok);
  ui.updateStatusMenu();
}

// Health polling
async function checkHealth() {
  try {
    const t0 = performance.now();
    const { ok, status } = await api.health();
    const ms = Math.round(performance.now() - t0);

    state.lastHealthOk = ok;
    state.lastHttp = `HTTP ${status} (${ms}ms)`;

    if (!ok) ui.setError(`health ${status}`);
    else ui.setError("");

  } catch (e) {
    state.lastHealthOk = false;
    state.lastHttp = "HTTP down";
    ui.setError("health fetch failed");
    ui.log(`Health check failed: ${String(e.message || e)}`, "warn");
  } finally {
    recomputeOverall();
  }
}
setInterval(checkHealth, CONFIG.HEALTH_INTERVAL_MS);
checkHealth();

// Frame watchdog
setInterval(() => {
  if (!state.ws || state.ws.readyState !== 1) return;
  if (!state.lastFrameAt) return;

  const delta = Date.now() - state.lastFrameAt;
  if (delta > CONFIG.FRAME_STALE_MS) {
    ui.setError("no frames");
    recomputeOverall();
  }
}, CONFIG.FRAME_WATCHDOG_MS);

// Buttons
ui.el("btnStart").onclick = async () => {
  const startUrl = (ui.el("startUrl").value || "https://example.com").trim();
  ui.log(`Creating session… url=${startUrl}`);

  try {
    state.session = await api.createSession(startUrl);
    ui.setSessionActive(false);
    wsClient.connect(recomputeOverall);

    // AUTO-START AGENT (only if admin logged in)
    if (state.isAdmin && state.adminToken) {
      const goal = `Analyze this page and move toward the AD Intelligence goal (MVP).`; // replace with your real default
      ui.log(`Auto-starting agent…`);
      await api.startAgent(state.session.sessionId, goal, "default");
      ui.log(`Agent started.`);
    } else {
      ui.log(`Not admin: agent will not auto-start. Login to enable.`, "warn");
    }

  } catch (e) {
    ui.log(`Start session failed: ${String(e.message || e)}`, "error");
    ui.setError("sessions failed");
    recomputeOverall();
  }
};


ui.el("btnReconnect").onclick = () => wsClient.connect(recomputeOverall);

ui.el("btnStop").onclick = () => {
  try { if (state.ws) state.ws.close(); } catch {}
  state.ws = null;
  state.session = null;
  state.lastWs = "closed";
  ui.setSessionActive(false);
  recomputeOverall();
};

ui.el("btnType").onclick = () => {
  const text = (ui.el("typeText").value || "");
  if (text) wsClient.send({ type: "user_type", text });
};

ui.el("btnGoto").onclick = () => {
  const url = (ui.el("gotoUrl").value || "").trim();
  if (url) wsClient.send({ type: "goto", url });
};

// Click mapping (still uses viewport from backend)
ui.screenEl.addEventListener("click", (e) => {
  if (!state.ws || state.ws.readyState !== 1) return;
  const rect = ui.screenEl.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * state.viewport.width);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * state.viewport.height);
  ui.clickText.textContent = `${x},${y}`;
  wsClient.send({ type: "user_click", x, y, button: "left" });
});

// Status dropdown
ui.statusBtn.onclick = () => {
  ui.statusMenu.hidden = !ui.statusMenu.hidden;
  ui.updateStatusMenu();
};

document.addEventListener("click", (e) => {
  if (!ui.statusMenu.hidden && !ui.statusBtn.contains(e.target) && !ui.statusMenu.contains(e.target)) {
    ui.statusMenu.hidden = true;
  }
});

// Admin button / modal
ui.adminBtn.onclick = () => {
  if (state.isAdmin) return auth.logout();
  auth.openModal();
};
ui.modalCancel.onclick = () => auth.closeModal();
ui.modalLogin.onclick = () => auth.loginWithPassword(ui.adminPass.value);
ui.adminPass.addEventListener("keydown", (e) => {
  if (e.key === "Enter") auth.loginWithPassword(ui.adminPass.value);
});

ui.log(`Viewer loaded. origin=${location.origin}`);
ui.log(`backend=${state.backendFqdn}`);
