import { state } from "./state.js";
import { ui } from "./ui.js";
import { CONFIG } from "./config.js";

export const wsClient = {
  wsUrl: "",

  connect() {
    if (!state.session?.wsPath) {
      ui.log("No wsPath. Create a session first.", "warn");
      return;
    }
    this.wsUrl = `wss://${state.backendFqdn}${state.session.wsPath}`;
    ui.wsUrlText.textContent = state.isAdmin ? this.wsUrl : "";
    ui.log(`WS connecting: ${this.wsUrl}`);

    try { if (state.ws) state.ws.close(); } catch {}
    state.ws = new WebSocket(this.wsUrl);

    ui.setDot(ui.dotWs, "warn");
    ui.wsText.textContent = "connecting…";

    state.ws.onopen = () => {
      state.wsReconnectAttempt = 0;
      ui.setDot(ui.dotWs, "good");
      ui.wsText.textContent = "open";
      ui.log("WS open");
    };

    state.ws.onclose = () => {
      ui.setDot(ui.dotWs, "bad");
      ui.wsText.textContent = "closed";
      ui.log("WS closed", "warn");
      this.scheduleReconnect();
    };

    state.ws.onerror = () => {
      ui.setDot(ui.dotWs, "bad");
      ui.wsText.textContent = "error";
      ui.setError("ws error");
      ui.log("WS error (see DevTools → Network → WS)", "error");
    };

    state.ws.onmessage = (ev) => this.onMessage(ev);
  },

  scheduleReconnect() {
    if (!state.session?.wsPath) return;
    state.wsReconnectAttempt++;
    const delay = Math.min(10000, Math.round(800 * Math.pow(2, state.wsReconnectAttempt - 1)));
    ui.log(`Reconnecting in ${delay}ms… (attempt ${state.wsReconnectAttempt})`, "warn");

    if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = setTimeout(() => this.connect(), delay);
  },

  onMessage(ev) {
    state.bytes += ev.data?.length || 0;

    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { ui.log("WS message: non-JSON payload", "warn"); return; }

    if (msg.type === "frame") {
      state.frames++;
      state.lastFrameAt = Date.now();
      state.lastFrameUrl = msg.url || state.lastFrameUrl;

      if (msg.viewport) state.viewport = msg.viewport;
      if (msg.img) ui.screenEl.src = msg.img;

      // last frame / fps
      ui.setDot(ui.dotFrame, "good");
      ui.frameText.textContent = new Date(state.lastFrameAt).toLocaleTimeString();

      // fps window
      state.fpsWindow.push(state.lastFrameAt);
      const cutoff = state.lastFrameAt - CONFIG.FPS_WINDOW_MS;
      state.fpsWindow = state.fpsWindow.filter(t => t >= cutoff);
      ui.fpsText.textContent = (state.fpsWindow.length / (CONFIG.FPS_WINDOW_MS/1000)).toFixed(1);

      ui.pageUrl.textContent = (msg.url || "—").replace(/^https?:\/\//, "");
      ui.vpText.textContent = `${state.viewport.width}×${state.viewport.height} @dpr${state.viewport.deviceScaleFactor ?? 1}`;

      ui.setError("");
      ui.updateMetrics();

      if (state.isAdmin) {
        ui.sessionIdText.textContent = state.session?.sessionId || "";
      }
    } else {
      if (state.isAdmin) ui.log(`WS: ${JSON.stringify(msg)}`);
    }
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
