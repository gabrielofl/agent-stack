// ws.js
import { state } from "./state.js";
import { ui } from "./ui.js";
import { CONFIG } from "./config.js";

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

    if (msg.type !== "frame") {
      if (state.isAdmin) ui.log(`WS: ${JSON.stringify(msg)}`);
      return;
    }

    state.frames++;
    state.lastFrameAt = Date.now();
    state.lastFrameUrl = msg.url || state.lastFrameUrl;

    if (msg.viewport) state.viewport = msg.viewport;
    if (msg.img) ui.screenEl.src = msg.img;

    // URL bar (only)
    if (ui.pageUrl) ui.pageUrl.textContent = (msg.url || "—").replace(/^https?:\/\//, "");

    // FPS calc
    state.fpsWindow.push(state.lastFrameAt);
    const cutoff = state.lastFrameAt - CONFIG.FPS_WINDOW_MS;
    state.fpsWindow = state.fpsWindow.filter(t => t >= cutoff);
    state.fps = (state.fpsWindow.length / (CONFIG.FPS_WINDOW_MS / 1000));

    ui.setError("");
    ui.updateMetrics();
    ui.updateStatusMenu();

    // Mark session active once we receive frames
    ui.setSessionActive(true);

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
