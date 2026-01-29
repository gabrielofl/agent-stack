// ws.js
import { state } from "./state.js";
import { ui } from "./ui.js";
import { CONFIG } from "./config.js";

function fmtAction(a) {
  if (!a) return "";
  if (a.type === "click") return `click @ ${a.x},${a.y}`;
  if (a.type === "type") return `type "${(a.text || "").slice(0, 80)}"`;
  if (a.type === "goto") return `goto ${a.url}`;
  if (a.type === "wait") return `wait ${a.ms}ms`;
  if (a.type === "ask_user") return `ask_user: ${a.question || ""}`;
  return `${a.type}`;
}

export const wsClient = {
  wsUrl: "",

  connect(onStatusChanged) {
    if (!state.session?.wsPath) {
      ui.log("No wsPath. Create a session first.", "warn");
      return;
    }

    this.wsUrl = `wss://${state.backendFqdn}${state.session.wsPath}`;

    if (state.isAdmin && ui.wsUrlText) ui.wsUrlText.textContent = this.wsUrl;

    try { if (state.ws) state.ws.close(); } catch {}
    state.ws = new WebSocket(this.wsUrl);

    state.lastWs = "connecting…";
    ui.updateStatusMenu();
    onStatusChanged?.();

    state.ws.onopen = () => {
      state.wsReconnectAttempt = 0;
      state.lastWs = "open";
      ui.log("WS open");
      ui.updateStatusMenu();
      onStatusChanged?.();
    };

    state.ws.onclose = () => {
      state.lastWs = "closed";
      ui.log("WS closed", "warn");
      ui.updateStatusMenu();
      onStatusChanged?.();
      this.scheduleReconnect(onStatusChanged);
    };

    state.ws.onerror = () => {
      state.lastWs = "error";
      ui.setError("ws error");
      ui.log("WS error (DevTools → Network → WS)", "error");
      ui.updateStatusMenu();
      onStatusChanged?.();
    };

    state.ws.onmessage = (ev) => this.onMessage(ev, onStatusChanged);
  },

  scheduleReconnect(onStatusChanged) {
    if (!state.session?.wsPath) return;
    state.wsReconnectAttempt++;
    const delay = Math.min(10000, Math.round(800 * Math.pow(2, state.wsReconnectAttempt - 1)));
    ui.log(`Reconnecting in ${delay}ms… (attempt ${state.wsReconnectAttempt})`, "warn");

    if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = setTimeout(() => this.connect(onStatusChanged), delay);
  },

  onMessage(ev, onStatusChanged) {
    state.bytes += ev.data?.length || 0;

    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { ui.log("WS message: non-JSON payload", "warn"); return; }

    // --------------------------
    // ✅ 1) Agent / worker events
    // --------------------------
    if (msg.type === "agent_event") {
      // backend forwards worker "agent_status"/"agent_error" as agent_event
      if (msg.error) ui.log(`[worker] ${msg.error}`, "error");
      else if (msg.status) ui.log(`[worker] ${msg.status}`, "info");
      else ui.log(`[worker] ${JSON.stringify(msg).slice(0, 400)}`, "info");
      return;
    }

    if (msg.type === "agent_proposed_action") {
      state.lastProposedAction = msg.action || null;
      state.lastProposedAt = Date.now();
      ui.log(`[agent] propose ${fmtAction(msg.action)}${msg.explanation ? " — " + msg.explanation : ""}`);

      // If you implement overlays, redraw here
      if (ui.renderOverlays) ui.renderOverlays();
      return;
    }

    // This requires a tiny backend change (broadcast agent_executed_action after executing)
    if (msg.type === "agent_executed_action") {
      state.lastExecutedAction = msg.action || null;
      state.lastExecutedAt = Date.now();
      ui.log(`[agent] executed ${fmtAction(msg.action)}`);

      if (ui.renderOverlays) ui.renderOverlays();
      return;
    }

    // Optional: if you broadcast clickable elements to frontend
    if (msg.type === "agent_elements") {
      state.lastElements = msg.elements || [];
      if (ui.renderOverlays) ui.renderOverlays();
      return;
    }

    // Optional: if worker returns ask_user and backend forwards it
    if (msg.type === "agent_question") {
      ui.log(`[agent] question: ${msg.question || "—"}`, "warn");
      return;
    }

    // Don't spam full JSON dumps anymore; keep admin-only fallback:
    if (msg.type !== "frame") {
      if (state.isAdmin) ui.log(`WS: ${JSON.stringify(msg).slice(0, 400)}`);
      return;
    }

    // --------------------------
    // ✅ 2) Frame handling (unchanged)
    // --------------------------
    state.frames++;
    state.lastFrameAt = Date.now();
    state.lastFrameUrl = msg.url || state.lastFrameUrl;

    if (msg.viewport) state.viewport = msg.viewport;
    if (msg.img) ui.screenEl.src = msg.img;

    if (ui.pageUrl) ui.pageUrl.textContent = (msg.url || "—").replace(/^https?:\/\//, "");

    // FPS calc
    state.fpsWindow.push(state.lastFrameAt);
    const cutoff = state.lastFrameAt - CONFIG.FPS_WINDOW_MS;
    state.fpsWindow = state.fpsWindow.filter(t => t >= cutoff);
    state.fps = (state.fpsWindow.length / (CONFIG.FPS_WINDOW_MS / 1000));

    ui.setError("");
    ui.updateMetrics();
    ui.updateStatusMenu();

    ui.setSessionActive(true);

    // If overlays exist, redraw after frame updates too (keeps alignment)
    if (ui.renderOverlays) ui.renderOverlays();

    onStatusChanged?.();
  },

  send(obj) {
    if (!state.ws || state.ws.readyState !== 1) {
      ui.log("WS not open. Start session or reconnect.", "warn");
      return false;
    }
    state.ws.send(JSON.stringify(obj));
    return true;
  }
};
