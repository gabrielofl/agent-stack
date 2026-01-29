// main.js
import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { ui } from "./ui.js";
import { api } from "./api.js";
import { wsClient } from "./ws.js";
import { auth } from "./auth.js";

ui.init();

// -------------------- Backend fqdn --------------------
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

// -------------------- Overall status --------------------
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

// -------------------- Small helpers --------------------
function echoUser(text) {
  ui.pushUserFeed(`You: ${text}`);
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

async function postAdminJson(path, body) {
  if (!state.isAdmin || !state.adminToken) {
    throw new Error("admin required (login first)");
  }

  const url = joinUrl(state.backendFqdn, path);
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // your backend requireAdmin typically uses Bearer token
      authorization: `Bearer ${state.adminToken}`,
    },
    body: JSON.stringify(body || {}),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 200)}`);

  // tolerate empty responses
  try {
    return text ? JSON.parse(text) : { ok: true };
  } catch {
    return { ok: true, raw: text };
  }
}

function logLlmStatusToAdminConsole(s) {
  if (!s) {
    ui.systemLog("[LLM] No llmStatus returned from /agent/start", "warn");
    return;
  }

  const healthOk = s.health?.ok ?? s.ok;
  const chatOk = s.chat?.ok ?? s.ok;

  const healthMs = s.health?.latencyMs ?? "?";
  const chatMs = s.chat?.latencyMs ?? "?";
  const base = s.llamaBaseUrl ?? "";

  if (healthOk && chatOk) {
    ui.systemLog(`✅ LLM READY | health=${healthMs}ms chat=${chatMs}ms | ${base}`, "ok");
    // Optional: also show it in the user feed
    // ui.pushUserFeed(`System: ✅ LLM ready (${chatMs}ms)`, "ok");
    return;
  }

  if (healthOk && !chatOk) {
    const err = s.chat?.error ?? s.error ?? "unknown";
    ui.systemLog(`⚠️ LLM UP but not responsive | ${err} | ${base}`, "warn");
    return;
  }

  const err = s.health?.error ?? s.error ?? "unknown";
  ui.systemLog(`❌ LLM DOWN | ${err} | ${base}`, "error");
}


// Start agent stream in IDLE mode (backend: POST /agent/start; worker will “wait for instructions”)
// Start agent stream in IDLE mode (backend: POST /agent/start)
async function startAgentIdle(sessionId) {
	// Use the official API method you already have
	const out = await api.startAgent(sessionId, "default");

// ✅ log once to admin console
logLlmStatusToAdminConsole(out?.llmStatus);
  return;
}

// Send instruction (backend: POST /agent/instruction; worker begins running)
async function sendAgentInstruction(sessionId, text) {
  if (typeof api.instruction === "function") {
    return api.instruction(sessionId, text, "default");
  }
  return postAdminJson("/agent/instruction", { sessionId, text, model: "default" });
}

// -------------------- Chat command surface --------------------
function parseArgs(s) {
  // keeps quoted groups: /type "hello world"
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function resetRuntimeStateAfterSessionStart() {
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
}

async function handleStart(url) {
  const startUrl = (url || "https://example.com").trim();
  echoUser(`/start ${startUrl}`);

  try {
    state.session = await api.createSession(startUrl);

    await resetRuntimeStateAfterSessionStart();

    if (ui.sessionIdText) ui.sessionIdText.textContent = state.session.sessionId || "";

    wsClient.connect(recomputeOverall);

    // ✅ Desired behavior: start agent stream in IDLE, waiting for chat instructions
    if (state.isAdmin && state.adminToken) {
      ui.systemLog("Starting agent stream (idle)…");
      await startAgentIdle(state.session.sessionId);
      ui.systemLog("Agent is idle and waiting for chat instructions.");
      ui.pushUserFeed("System: Agent ready. Type a request in chat to start it.");
    } else {
      ui.systemLog("Agent not started (admin not logged in).", "warn");
      ui.pushUserFeed("System: Login as admin to send agent instructions.", "warn");
    }
  } catch (e) {
    ui.systemLog(`Start session failed — ${String(e?.message || e)}`, "error");
    ui.setError("sessions failed");
    recomputeOverall();
  }
}

function handleReconnect() {
  echoUser("/reconnect");
  wsClient.connect(recomputeOverall);
}

function handleStop() {
  echoUser("/stop");
  try {
    if (state.ws) state.ws.close();
  } catch {}
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
}

function handleGoto(url) {
  const u = (url || "").trim();
  if (!u) return;
  echoUser(`/goto ${u}`);
  wsClient.send({ type: "goto", url: u });
}

// Manual typing into page (kept via /type)
function handleType(text) {
  const t = (text || "");
  if (!t) return;
  echoUser(t);
  wsClient.send({ type: "user_type", text: t });
}

// Optional extra commands (manual control)
function handleClick(x, y) {
  const xi = Number(x),
    yi = Number(y);
  if (!Number.isFinite(xi) || !Number.isFinite(yi)) return;
  echoUser(`/click ${xi} ${yi}`);
  wsClient.send({ type: "user_click", x: xi, y: yi, button: "left" });
}

function handleScroll(dx, dy) {
  const dxi = Number(dx),
    dyi = Number(dy);
  if (!Number.isFinite(dxi) || !Number.isFinite(dyi)) return;
  echoUser(`/scroll ${dxi} ${dyi}`);
  wsClient.send({ type: "user_scroll", dx: dxi, dy: dyi });
}

function handleKey(key) {
  const k = (key || "").trim();
  if (!k) return;
  echoUser(`/key ${k}`);
  wsClient.send({ type: "user_press_key", key: k });
}

// ✅ This is the key change:
// after a session exists, plain chat text => agent instruction (NOT user_type)
async function handleInstruction(text) {
  const t = String(text || "").trim();
  if (!t) return;

  // requirement: show everything the user typed in chat
  echoUser(t);

  if (!state.session?.sessionId) {
    ui.pushUserFeed("System: start a session first with /start …", "warn");
    return;
  }

  if (!state.isAdmin || !state.adminToken) {
    ui.pushUserFeed("System: admin login required to send agent instructions.", "warn");
    return;
  }

  try {
    ui.systemLog(`Sending instruction → worker: ${t}`);
    await sendAgentInstruction(state.session.sessionId, t);
    ui.pushUserFeed("System: instruction sent to agent.");
  } catch (e) {
    ui.pushUserFeed(`System: instruction failed — ${String(e?.message || e)}`, "error");
  }
}

async function dispatchChatCommand(raw) {
  const line = (raw || "").trim();
  if (!line) return;

  // commands start with "/"
  if (line.startsWith("/")) {
    const parts = parseArgs(line);
    const cmd = (parts[0] || "").toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "/start":
        return handleStart(args[0]);
      case "/reconnect":
        return handleReconnect();
      case "/stop":
        return handleStop();
      case "/goto":
        return handleGoto(args[0]);

      // manual page control stays explicit
      case "/type":
        return handleType(args.join(" "));
      case "/click":
        return handleClick(args[0], args[1]);
      case "/scroll":
        return handleScroll(args[0], args[1]);
      case "/key":
        return handleKey(args.join(" "));

      default:
        // unknown slash command: treat it as an instruction (still matches your “everything in chat” feel)
        return handleInstruction(line);
    }
  }

  // ✅ plain text => instruction (once session exists)
  return handleInstruction(line);
}

// Wire chat box + send button
(function wireChatComposer() {
  const input = ui.el("chatInput");
  const send = ui.el("chatSend");
  if (!input || !send) return;

  async function submit() {
    const text = input.value;
    input.value = "";
    await dispatchChatCommand(text);
  }

  send.onclick = submit;

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
})();

// -------------------- Health polling (system -> admin log) --------------------
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
    ui.systemLog(`Health check failed: ${String(e?.message || e)}`, "warn");
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

// -------------------- Legacy buttons -> route through chat dispatcher --------------------
// (kept so your hidden legacyControls don't break)
ui.el("btnStart").onclick = async () => {
  const startUrl = (ui.el("startUrl").value || "https://example.com").trim();
  await dispatchChatCommand(`/start ${startUrl}`);
};

ui.el("btnReconnect").onclick = async () => {
  await dispatchChatCommand("/reconnect");
};

ui.el("btnStop").onclick = async () => {
  await dispatchChatCommand("/stop");
};

ui.el("btnType").onclick = async () => {
  const text = ui.el("typeText").value || "";
  if (!text) return;
  await dispatchChatCommand(`/type ${text}`);
};

ui.el("btnGoto").onclick = async () => {
  const url = (ui.el("gotoUrl").value || "").trim();
  if (!url) return;
  await dispatchChatCommand(`/goto ${url}`);
};

// -------------------- Agent controls (admin actions; keep user-visible confirmations) --------------------
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

// -------------------- Viewer interactions (user actions -> user chat) --------------------
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
ui.screenEl.addEventListener(
  "wheel",
  (e) => {
    if (!state.ws || state.ws.readyState !== 1) return;
    e.preventDefault();

    const dy = Math.max(-2000, Math.min(2000, Math.round(e.deltaY)));
    const dx = Math.max(-2000, Math.min(2000, Math.round(e.deltaX || 0)));

    ui.pushUserFeed(`You: scroll dx=${dx} dy=${dy}`);
    wsClient.send({ type: "user_scroll", dx, dy });
  },
  { passive: false }
);

// Key presses -> user_press_key (ignore when typing in input/textarea)
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

// Hover (throttled) -> user_hover (no chat spam)
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
  if (
    !ui.statusMenu.hidden &&
    !ui.statusBtn.contains(e.target) &&
    !ui.statusMenu.contains(e.target)
  ) {
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
ui.systemLog(`Viewer loaded. origin=${location.origin}`);
ui.systemLog(`Backend=${state.backendFqdn}`);
ui.pushUserFeed(`Tip: type /start https://example.com to begin.`);
ui.pushUserFeed(`Tip: after /start, plain chat text becomes an agent instruction. Use /type to type into the page.`);
