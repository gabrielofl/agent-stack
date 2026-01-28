import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { ui } from "./ui.js";
import { api } from "./api.js";
import { wsClient } from "./ws.js";
import { auth } from "./auth.js";

ui.init();

// init state
state.backendFqdn = api.normalizeFqdn(localStorage.getItem("backendFqdn") || CONFIG.DEFAULT_BACKEND_FQDN);
ui.fqdnEl.value = state.backendFqdn;
ui.backendHost.textContent = state.backendFqdn;

ui.originText.textContent = location.origin;
ui.setAdminMode(false);

// auth bootstrap
auth.init();

// Health polling
async function checkHealth() {
  try {
    const t0 = performance.now();
    const { ok, status } = await api.health();
    const ms = Math.round(performance.now() - t0);
    state.lastHttp = `HTTP ${status} (${ms}ms)`;

    ui.healthText.textContent = ok ? `ok (${ms}ms)` : `bad (${status})`;
    ui.httpText.textContent = state.isAdmin ? state.lastHttp : "";

    ui.setDot(ui.dotHealth, ok ? "good" : "bad");
    if (!ok) ui.setError(`health ${status}`);
  } catch (e) {
    ui.setDot(ui.dotHealth, "bad");
    ui.healthText.textContent = "down";
    ui.httpText.textContent = state.isAdmin ? "health fetch failed" : "";
    ui.setError("health fetch failed");
    ui.log(`Health check failed: ${String(e.message || e)}`, "warn");
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
    ui.setDot(ui.dotFrame, "bad");
    ui.frameText.textContent = `${Math.round(delta/1000)}s ago`;
    if (state.isAdmin) ui.log(`No frames for ${Math.round(delta/1000)}s (WS open).`, "warn");
    ui.setError("no frames");
  }
}, CONFIG.FRAME_WATCHDOG_MS);

// Buttons
ui.el("btnStart").onclick = async () => {
  state.backendFqdn = api.normalizeFqdn(ui.fqdnEl.value);
  ui.fqdnEl.value = state.backendFqdn;
  localStorage.setItem("backendFqdn", state.backendFqdn);
  ui.backendHost.textContent = state.backendFqdn;

  const startUrl = (ui.el("startUrl").value || "https://example.com").trim();
  ui.log(`Creating session… url=${startUrl}`);

  try {
    state.session = await api.createSession(startUrl);
    state.viewport = state.session.viewport || state.viewport;
    ui.sessionBadge.textContent = state.session.sessionId ? `session ${state.session.sessionId}` : "session created";
    wsClient.connect();
  } catch (e) {
    ui.log(`Start session failed: ${String(e.message || e)}`, "error");
    ui.setError("sessions failed");
  }
};

ui.el("btnReconnect").onclick = () => wsClient.connect();
ui.el("btnStop").onclick = () => {
  try { if (state.ws) state.ws.close(); } catch {}
  state.ws = null;
  state.session = null;
  ui.sessionBadge.textContent = "no session";
  ui.wsText.textContent = "idle";
  ui.setDot(ui.dotWs, "warn");
};

ui.el("btnType").onclick = () => {
  const text = (ui.el("typeText").value || "");
  if (text) wsClient.send({ type: "user_type", text });
};

ui.el("btnGoto").onclick = () => {
  const url = (ui.el("gotoUrl").value || "").trim();
  if (url) wsClient.send({ type: "goto", url });
};

// click mapping
ui.screenEl.addEventListener("click", (e) => {
  if (!state.ws || state.ws.readyState !== 1) return;
  const rect = ui.screenEl.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * state.viewport.width);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * state.viewport.height);
  ui.clickText.textContent = `${x},${y}`;
  wsClient.send({ type: "user_click", x, y, button: "left" });
});

// Admin button / modal
ui.adminBtn.onclick = () => {
  if (state.isAdmin) return auth.logout();
  auth.openModal();
};
ui.modalCancel.onclick = () => auth.closeModal();
ui.modalLogin.onclick = () => auth.loginWithPassword(ui.adminPass.value);
ui.adminPass.addEventListener("keydown", (e) => { if (e.key === "Enter") auth.loginWithPassword(ui.adminPass.value); });

// Admin-only buttons
ui.el("btnClear").onclick = () => { ui.logEl.textContent = ""; ui.setError(""); };
ui.el("btnCopy").onclick = async () => {
  const payload = [
    `origin=${location.origin}`,
    `backend=${state.backendFqdn}`,
    `session=${state.session?.sessionId || "none"}`,
    `http=${state.lastHttp || "unknown"}`,
    `wsReadyState=${state.ws ? state.ws.readyState : "none"}`,
    `frames=${state.frames}`,
    `lastFrameAt=${state.lastFrameAt ? new Date(state.lastFrameAt).toISOString() : "none"}`,
    `lastUrl=${state.lastFrameUrl || "none"}`,
    "",
    "---- log ----",
    ui.logEl.textContent
  ].join("\n");
  try { await navigator.clipboard.writeText(payload); ui.log("Copied debug bundle."); }
  catch { ui.log("Clipboard blocked.", "warn"); }
};

// Hide admin-only UI if not admin
ui.setAdminMode(!!state.adminToken);
ui.log(`Viewer loaded. origin=${location.origin}`);
ui.log(`backend=${state.backendFqdn}`);
