// ws.js
import { state } from "./state.js";
import { ui } from "./ui.js";
import { CONFIG } from "./config.js";

function fmtAction(a) {
  if (!a) return "";
  switch (a.type) {
    case "click": return `click @ ${a.x},${a.y}`;
    case "hover": return a.selector ? `hover "${a.selector}"` : `hover @ ${a.x},${a.y}`;
    case "type": return `type "${(a.text || "").slice(0, 60)}"`;
    case "type_in_selector": return `type_in_selector "${a.selector}" "${(a.text || "").slice(0, 40)}"`;
    case "select": {
      const v = a.value != null ? `value="${a.value}"`
        : a.label != null ? `label="${a.label}"`
        : `index=${a.index}`;
      return `select "${a.selector}" ${v}`;
    }
    case "press_key": return `press_key ${a.key}`;
    case "scroll": return `scroll dx=${a.dx ?? 0} dy=${a.dy ?? 0}`;
    case "goto": return `goto ${a.url}`;
    case "wait": return `wait ${a.ms}ms`;
    case "screenshot_region": return `screenshot_region @ ${a.x},${a.y} ${a.w}x${a.h}`;
    case "ask_user": return `ask_user: ${a.question || ""}`;
    default: return `${a.type}`;
  }
}

function wsScheme() {
  // match the page scheme
  return location.protocol === "https:" ? "wss" : "ws";
}

export const wsClient = {
  wsUrl: "",

  connect(onStatusChanged) {
    if (!state.session?.wsPath) {
      ui.pushUserFeed("System: no wsPath — start a session first.", "warn");
      return;
    }

    this.wsUrl = `${wsScheme()}://${state.backendFqdn}${state.session.wsPath}`;

    if (state.isAdmin && ui.wsUrlText) ui.wsUrlText.textContent = this.wsUrl;

    try { if (state.ws) state.ws.close(); } catch {}
    state.ws = new WebSocket(this.wsUrl);

    state.lastWs = "connecting…";
    ui.updateStatusMenu();
    onStatusChanged?.();

    state.ws.onopen = () => {
	state.wsReconnectAttempt = 0;
	state.lastWs = "open";
	ui.systemLog("WS open");
	ui.updateStatusMenu();
	onStatusChanged?.();
	};

	state.ws.onclose = () => {
	state.lastWs = "closed";
	ui.systemLog("WS closed", "warn");
	ui.updateStatusMenu();
	onStatusChanged?.();
	this.scheduleReconnect(onStatusChanged);
	};

	state.ws.onerror = () => {
	state.lastWs = "error";
	ui.setError("ws error");
	ui.systemLog("WS error (check DevTools → Network → WS)", "error");
	ui.updateStatusMenu();
	onStatusChanged?.();
	};


    state.ws.onmessage = (ev) => this.onMessage(ev, onStatusChanged);
  },

  scheduleReconnect(onStatusChanged) {
    if (!state.session?.wsPath) return;
    state.wsReconnectAttempt = (state.wsReconnectAttempt || 0) + 1;

    const delay = Math.min(10000, Math.round(800 * Math.pow(2, state.wsReconnectAttempt - 1)));
    ui.adminLog(`Reconnecting in ${delay}ms… (attempt ${state.wsReconnectAttempt})`, "warn");

    if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = setTimeout(() => this.connect(onStatusChanged), delay);
  },

  onMessage(ev, onStatusChanged) {
    state.bytes += ev.data?.length || 0;

    let msg;
    try { msg = JSON.parse(ev.data); }
    catch {
      ui.adminLog("WS message: non-JSON payload", "warn");
      return;
    }

	  // -------- Agent / worker events --------
	     // -------- LLM status push (from backend) --------
    if (msg.type === "llm_status") {
      if (!state.isAdmin) return;

      const lvl = msg.level || msg.payload?.llmStatus?.level || "unknown";
      const p = msg.payload || {};
      const llm = p.llmStatus || null;
      const bootStatus = p.bootStatus || null;
      const bootLog = p.bootLog || "";
      const ms = p.ms ?? "?";

      ui.adminLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, "info");
      ui.adminLog(`[LLM STATUS PUSH] level=${lvl} ms=${ms} session=${msg.sessionId || "?"}`, lvl === "ready" ? "info" : "warn");

      if (p.workerStart) {
        ui.adminLog(`[WORKER START] ${JSON.stringify(p.workerStart).slice(0, 4000)}`, "info");
      }

      if (bootStatus) {
        ui.adminLog(`[LLM BOOT STATUS] ${JSON.stringify(bootStatus).slice(0, 8000)}`, lvl === "ready" ? "info" : "warn");
      }

      if (llm) {
        ui.adminLog(`[LLM PROBE /health/llm] ${JSON.stringify(llm).slice(0, 8000)}`, llm.ok ? "info" : "warn");
      } else {
        ui.adminLog(`[LLM PROBE /health/llm] missing llmStatus`, "warn");
      }

      if (bootLog) {
        ui.adminLog(`[LLM BOOT LOG]\n${String(bootLog).slice(0, 12000)}`, "warn");
      }

      return;
    }

    if (msg.type === "agent_event") {
      const line = msg.error ? `[worker] ${msg.error}` :
                   msg.status ? `[worker] ${msg.status}` :
                   `[worker] ${JSON.stringify(msg).slice(0, 400)}`;
      ui.pushAgentFeed(line, msg.error ? "error" : "info");
      return;
    }

    if (msg.type === "agent_proposed_action") {
      state.lastProposedAction = msg.action || null;
      state.lastProposedAt = Date.now();

      ui.setAgentSummary({
        stateText: "proposed",
        stepText: msg.stepId || "—",
        lastText: fmtAction(msg.action),
      });

      ui.pushAgentFeed(
        `PROPOSE ${msg.stepId}: ${fmtAction(msg.action)}${msg.explanation ? " — " + msg.explanation : ""}`,
        "info"
      );

      if (ui.renderOverlays) ui.renderOverlays();
      return;
    }

    if (msg.type === "agent_action_needs_approval") {
      state.pendingStepId = msg.stepId || "";
      state.pendingAction = state.lastProposedAction || null;

      ui.setAgentSummary({
        stateText: "needs approval",
        stepText: msg.stepId || "—",
        lastText: state.pendingAction ? fmtAction(state.pendingAction) : "—",
      });

      ui.pushAgentFeed(`NEEDS APPROVAL: ${msg.stepId}`, "warn");
      if (ui.btnApprove) ui.btnApprove.disabled = !state.isAdmin || !state.pendingStepId;
      return;
    }

    if (msg.type === "agent_executed_action") {
      state.lastExecutedAction = msg.action || null;
      state.lastExecutedAt = Date.now();

      if (state.pendingStepId && msg.stepId === state.pendingStepId) {
        state.pendingStepId = "";
        state.pendingAction = null;
        if (ui.btnApprove) ui.btnApprove.disabled = true;
      }

      ui.setAgentSummary({
        stateText: "executed",
        stepText: msg.stepId || "—",
        lastText: fmtAction(msg.action),
      });

      ui.pushAgentFeed(`EXEC ${msg.stepId}: ${fmtAction(msg.action)}`, "info");
      if (ui.renderOverlays) ui.renderOverlays();
      return;
    }

    if (msg.type === "agent_action_failed") {
      ui.setAgentSummary({
        stateText: "action failed",
        stepText: msg.stepId || "—",
        lastText: fmtAction(msg.action),
      });
      ui.pushAgentFeed(`FAILED ${msg.stepId}: ${fmtAction(msg.action)} — ${msg.error}`, "error");
      return;
    }

    if (msg.type === "agent_question") {
      state.lastQuestion = msg.question || "";
      ui.setAgentSummary({
        stateText: "question",
        stepText: msg.stepId || "—",
        lastText: msg.question || "—",
      });
      ui.pushAgentFeed(`QUESTION: ${msg.question || "—"}`, "warn");
      if (ui.btnAsk) ui.btnAsk.disabled = !state.isAdmin;
      return;
    }

    if (msg.type === "agent_elements") {
      state.lastElements = msg.elements || [];
      if (ui.renderOverlays) ui.renderOverlays();
      return;
    }

    if (msg.type === "agent_screenshot_region") {
      state.lastScreenshot = msg.img;
      ui.pushAgentFeed(`SCREENSHOT ${msg.stepId}: ${msg.w}x${msg.h}`, "info");
      if (ui.renderOverlays) ui.renderOverlays();
      return;
    }

    // -------- Frame handling --------
    if (msg.type === "frame") {
      state.frames++;
      state.lastFrameAt = Date.now();
      state.lastFrameUrl = msg.url || state.lastFrameUrl;

      if (msg.viewport) state.viewport = msg.viewport;
      if (msg.img) ui.screenEl.src = msg.img;

      if (ui.pageUrl) ui.pageUrl.textContent = (msg.url || "—").replace(/^https?:\/\//, "");

      // FPS calc
      state.fpsWindow.push(state.lastFrameAt);
      const cutoff = state.lastFrameAt - CONFIG.FPS_WINDOW_MS;
      state.fpsWindow = state.fpsWindow.filter((t) => t >= cutoff);
      state.fps = state.fpsWindow.length / (CONFIG.FPS_WINDOW_MS / 1000);

      ui.setError("");
      ui.updateMetrics();
      ui.updateStatusMenu();
      ui.setSessionActive(true);

      if (ui.renderOverlays) ui.renderOverlays();

      onStatusChanged?.();
      return;
    }

    // -------- Unknown message type --------
    if (state.isAdmin) ui.adminLog(`WS: ${JSON.stringify(msg).slice(0, 400)}`);
  },

  send(obj) {
    if (!state.ws || state.ws.readyState !== 1) {
      ui.pushUserFeed("System: WS not open — start session or reconnect.", "warn");
      return false;
    }
    state.ws.send(JSON.stringify(obj));
    return true;
  }
};
