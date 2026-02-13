// main.js
import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { ui } from "./ui.js";
import { api } from "./api.js";
import { wsClient } from "./ws.js";
import { auth } from "./auth.js";

ui.init();

// -------------------- Backend fqdn (MUST be set before any polling) --------------------
state.backendFqdn = api.normalizeFqdn(
  localStorage.getItem("backendFqdn") || CONFIG.DEFAULT_BACKEND_FQDN
);

function setPill(el, state, title) {
  if (!el) return;
  el.classList.remove("pill-unk", "pill-ok", "pill-warn", "pill-bad");
  el.classList.add(
    state === "ok" ? "pill-ok" :
    state === "warn" ? "pill-warn" :
    state === "bad" ? "pill-bad" : "pill-unk"
  );
  if (title) el.title = title;
}

const pillBackend = document.getElementById("pillBackend");
const pillAgent   = document.getElementById("pillAgent");
const pillLlm     = document.getElementById("pillLlm");

async function pollPills() {
  // Backend pill stays (fine)
  try {
    const t0 = performance.now();
    const { ok, status } = await api.health();
    const ms = Math.round(performance.now() - t0);
    setPill(pillBackend, ok ? "ok" : "bad", `Backend /health → ${status} (${ms}ms)`);
  } catch (e) {
    setPill(pillBackend, "bad", `Backend down: ${String(e?.message || e)}`);
  }

  // ✅ Only poll worker pills when a session exists AND viewer WS is open.
  // This prevents the UI from keeping the worker alive after /stop or disconnect.
  const hasSession = !!state.session?.sessionId;
  const wsOpen = !!state.ws && state.ws.readyState === 1;

  if (!hasSession || !wsOpen) {
    setPill(pillAgent, "unk", "Agent: stopped");
    setPill(pillLlm, "unk", "LLM: stopped");
    return;
  }

  // Agent (worker container)
  try {
    const t0 = performance.now();
    const r = await api.workerHealth();
    const ms = Math.round(performance.now() - t0);
    setPill(pillAgent, r.ok ? "ok" : "bad", `Agent /health → ${r.status} (${ms}ms)`);
  } catch (e) {
    setPill(pillAgent, "bad", `Agent unreachable: ${String(e?.message || e)}`);
  }

  // LLM (optional)
  if (typeof api.workerLlmHealth === "function") {
    try {
      const t0 = performance.now();
      const r = await api.workerLlmHealth();
      const ms = Math.round(performance.now() - t0);

      const level = r.json?.level;
      if (r.ok && (level === "ready" || r.json?.ok === true)) {
        setPill(pillLlm, "ok", `LLM ready (${ms}ms)`);
      } else if (r.ok) {
        setPill(pillLlm, "warn", `LLM degraded (${ms}ms)`);
      } else {
        setPill(pillLlm, "bad", `LLM down: HTTP ${r.status}`);
      }
    } catch (e) {
      setPill(pillLlm, "bad", `LLM probe failed: ${String(e?.message || e)}`);
    }
  } else {
    setPill(pillLlm, "unk", "LLM: not polled");
  }
}

// every 10s
setInterval(pollPills, 10_000);
pollPills();

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
      authorization: `Bearer ${state.adminToken}`,
    },
    body: JSON.stringify(body || {}),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 200)}`);

  try {
    return text ? JSON.parse(text) : { ok: true };
  } catch {
    return { ok: true, raw: text };
  }
}

function setLlmPillFromStatus(llmStatus) {
  if (!pillLlm || !llmStatus) return;
  const level = llmStatus.level || (llmStatus.ok ? "ready" : "down");
  if (level === "ready") setPill(pillLlm, "ok", llmStatus.summary || "LLM ready");
  else if (level === "degraded") setPill(pillLlm, "warn", llmStatus.summary || "LLM degraded");
  else setPill(pillLlm, "bad", llmStatus.summary || "LLM down");
}

// Start agent stream in IDLE mode
async function startAgentIdle(sessionId) {
  await api.startAgent(sessionId, "default");
  ui.systemLog("Requested worker start; waiting for LLM status push…");
  return;
}

// Send instruction
async function sendAgentInstruction(sessionId, text) {
  if (typeof api.instruction === "function") {
    return api.instruction(sessionId, text, "default");
  }
  return postAdminJson("/worker/instruction", { sessionId, text, model: "default" });
}

// -------------------- Chat command surface --------------------
function parseArgs(s) {
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

async function stopAgentOnBackend(sessionId) {
  return postAdminJson("/worker/stop", { sessionId });
}

async function handleStop() {
  echoUser("/stop");

  const sid = state.session?.sessionId;

  // ✅ tell backend to stop agent + disconnect worker stream + disable backend polling
  if (sid && state.isAdmin && state.adminToken) {
    try {
      await stopAgentOnBackend(sid);
      ui.systemLog("Backend: worker stopped; polling disabled.");
    } catch (e) {
      ui.systemLog(`Backend stop failed: ${String(e?.message || e)}`, "warn");
    }
  }

  // ✅ close viewer WS
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
}

function handleGoto(url) {
  const u = (url || "").trim();
  if (!u) return;
  echoUser(`/goto ${u}`);
  wsClient.send({ type: "goto", url: u });
}

function handleType(text) {
  const t = (text || "");
  if (!t) return;
  echoUser(t);
  wsClient.send({ type: "user_type", text: t });
}

function handleClick(x, y) {
  const xi = Number(x), yi = Number(y);
  if (!Number.isFinite(xi) || !Number.isFinite(yi)) return;
  echoUser(`/click ${xi} ${yi}`);
  wsClient.send({ type: "user_click", x: xi, y: yi, button: "left" });
}

function handleScroll(dx, dy) {
  const dxi = Number(dx), dyi = Number(dy);
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

async function handleInstruction(text) {
  const t = String(text || "").trim();
  if (!t) return;

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

  if (line.startsWith("/")) {
    const parts = parseArgs(line);
    const cmd = (parts[0] || "").toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "/start": return handleStart(args[0]);
      case "/reconnect": return handleReconnect();
      case "/stop": return handleStop();
      case "/goto": return handleGoto(args[0]);

      case "/type": return handleType(args.join(" "));
      case "/click": return handleClick(args[0], args[1]);
      case "/scroll": return handleScroll(args[0], args[1]);
      case "/key": return handleKey(args.join(" "));

      default:
        return handleInstruction(line);
    }
  }

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

// -------------------- Agent controls --------------------
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
