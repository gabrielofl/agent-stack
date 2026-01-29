// main.js
import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { ui } from "./ui.js";
import { api } from "./api.js";
import { wsClient } from "./ws.js";
import { auth } from "./auth.js";

ui.init();

// Backend fqdn
state.backendFqdn = api.normalizeFqdn(
  localStorage.getItem("backendFqdn") || CONFIG.DEFAULT_BACKEND_FQDN
);

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
      : Date.now() - state.lastFrameAt < CONFIG.FRAME_STALE_MS;

  const ok = healthOk && wsOk && frameOk && !state.lastError;
  ui.setOverallOk(ok);
  ui.updateStatusMenu();
}

// -------------------- Health polling --------------------
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
    ui.pushUserFeed(`Health check failed: ${String(e.message || e)}`, "warn");
    ui.adminLog?.(`Health check failed: ${String(e.message || e)}`, "warn");
  } finally {
    recomputeOverall();
  }
}
setInterval(checkHealth, CONFIG.HEALTH_INTERVAL_MS);
checkHealth();

// -------------------- Frame watchdog --------------------
setInterval(() => {
  if (!state.ws || state.ws.readyState !== 1) return;
  if (!state.lastFrameAt) return;

  const delta = Date.now() - state.lastFrameAt;
  if (delta > CONFIG.FRAME_STALE_MS) {
    ui.setError("no frames");
    recomputeOverall();
  }
}, CONFIG.FRAME_WATCHDOG_MS);

// -------------------- Buttons --------------------
ui.el("btnStart").onclick = async () => {
  const startUrl = (ui.el("startUrl").value || "https://example.com").trim();
  ui.pushUserFeed(`You: start session → ${startUrl}`);

  try {
    state.session = await api.createSession(startUrl);

    ui.setSessionActive(false);
    state.frames = 0;
    state.bytes = 0;
    state.lastFrameAt = 0;
    state.lastFrameUrl = "";
    state.pendingStepId = "";
    state.pendingAction = null;
    state.lastQuestion = "";
    state.lastProposedAction = null;
    state.lastExecutedAction = null;
    state.lastElements = [];

    if (ui.sessionIdText) ui.sessionIdText.textContent = state.session.sessionId || "";

    wsClient.connect(recomputeOverall);

    // AUTO-START AGENT (admin only)
    if (state.isAdmin && state.adminToken) {
      const goal = `Analyze this page and move toward the AD Intelligence goal (MVP).`;
      ui.pushUserFeed(`System: auto-starting agent (admin)…`);
      await api.startAgent(state.session.sessionId, goal, "default");
      ui.pushUserFeed(`System: agent started.`);
    } else {
      ui.pushUserFeed(`System: login to enable auto-start agent.`, "warn");
    }
  } catch (e) {
    ui.pushUserFeed(`System: start session failed — ${String(e.message || e)}`, "error");
    ui.setError("sessions failed");
    recomputeOverall();
  }
};

ui.el("btnReconnect").onclick = () => {
  ui.pushUserFeed("You: reconnect websocket");
  wsClient.connect(recomputeOverall);
};

ui.el("btnStop").onclick = () => {
  ui.pushUserFeed("You: stop");
  try { if (state.ws) state.ws.close(); } catch {}
  state.ws = null;
  state.session = null;
  state.lastWs = "closed";
  ui.setSessionActive(false);

  state.pendingStepId = "";
  state.pendingAction = null;
  state.lastQuestion = "";
  if (ui.btnApprove) ui.btnApprove.disabled = true;
  if (ui.btnAsk) ui.btnAsk.disabled = true;

  recomputeOverall();
};

// Approve pending agent action (admin only)
ui.el("btnApprove").onclick = () => {
  if (!state.isAdmin) return ui.pushUserFeed("System: admin required to approve.", "warn");
  if (!state.pendingStepId) return ui.pushUserFeed("System: no pending step to approve.", "warn");

  wsClient.send({
    type: "agent_approve",
    adminToken: state.adminToken,
    stepId: state.pendingStepId,
  });
  ui.pushUserFeed(`You: approve agent step ${state.pendingStepId}`);
};

// Send correction to agent (admin only) — requires api.correction() in api.js
ui.el("btnAsk").onclick = async () => {
  if (!state.isAdmin) return ui.pushUserFeed("System: admin required.", "warn");
  if (!state.session?.sessionId) return ui.pushUserFeed("System: no active session.", "warn");

  const text = prompt("Send guidance to agent:", state.lastQuestion || "");
  if (!text) return;

  try {
    ui.pushUserFeed(`You → Agent: ${text}`);
    await api.correction(state.session.sessionId, text, "override");
    ui.pushUserFeed("System: correction sent.");
  } catch (e) {
    ui.pushUserFeed(`System: correction failed — ${String(e?.message || e)}`, "error");
  }
};

// Manual user actions
ui.el("btnType").onclick = () => {
  const text = (ui.el("typeText").value || "");
  if (!text) return;
  ui.pushUserFeed(`You: type "${text.slice(0, 80)}"`);
  wsClient.send({ type: "user_type", text });
};

ui.el("btnGoto").onclick = () => {
  const url = (ui.el("gotoUrl").value || "").trim();
  if (!url) return;
  ui.pushUserFeed(`You: goto ${url}`);
  wsClient.send({ type: "goto", url });
};

// -------------------- Viewer interactions --------------------
ui.screenEl.addEventListener("click", (e) => {
  if (!state.ws || state.ws.readyState !== 1) return;
  const rect = ui.screenEl.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * state.viewport.width);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * state.viewport.height);
  ui.clickText.textContent = `${x},${y}`;
  ui.pushUserFeed(`You: click @ ${x},${y}`);
  wsClient.send({ type: "user_click", x, y, button: "left" });
});

// Scroll wheel -> user_scroll
ui.screenEl.addEventListener("wheel", (e) => {
  if (!state.ws || state.ws.readyState !== 1) return;
  e.preventDefault();

  const dy = Math.max(-2000, Math.min(2000, Math.round(e.deltaY)));
  const dx = Math.max(-2000, Math.min(2000, Math.round(e.deltaX || 0)));

  ui.pushUserFeed(`You: scroll dx=${dx} dy=${dy}`);
  wsClient.send({ type: "user_scroll", dx, dy });
}, { passive: false });

// Key presses -> user_press_key
document.addEventListener("keydown", (e) => {
  if (!state.ws || state.ws.readyState !== 1) return;

  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return;

  const parts = [];
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.key);

  const key = parts.join("+");
  ui.pushUserFeed(`You: press_key ${key}`);
  wsClient.send({ type: "user_press_key", key });
});

// Hover (throttled) -> user_hover (don’t spam chat)
let lastHoverAt = 0;
ui.screenEl.addEventListener("mousemove", (e) => {
  if (!state.ws || state.ws.readyState !== 1) return;
  const now = Date.now();
  if (now - lastHoverAt < 120) return;
  lastHoverAt = now;

  const rect = ui.screenEl.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * state.viewport.width);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * state.viewport.height);

  wsClient.send({ type: "user_hover", x, y });
});

// -------------------- Status dropdown --------------------
ui.statusBtn.onclick = () => {
  ui.statusMenu.hidden = !ui.statusMenu.hidden;
  ui.updateStatusMenu();
};

document.addEventListener("click", (e) => {
  if (!ui.statusMenu.hidden && !ui.statusBtn.contains(e.target) && !ui.statusMenu.contains(e.target)) {
    ui.statusMenu.hidden = true;
  }
});

// -------------------- Admin button / modal --------------------
ui.adminBtn.onclick = () => {
  if (state.isAdmin) return auth.logout();
  auth.openModal();
};

ui.modalCancel.onclick = () => auth.closeModal();
ui.modalLogin.onclick = () => auth.loginWithPassword(ui.adminPass.value);

ui.adminPass.addEventListener("keydown", (e) => {
  if (e.key === "Enter") auth.loginWithPassword(ui.adminPass.value);
});

// -------------------- Boot --------------------
ui.pushUserFeed(`System: viewer loaded. origin=${location.origin}`);
ui.pushUserFeed(`System: backend=${state.backendFqdn}`);
