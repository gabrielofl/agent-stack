// src/ws/agentStreamWs.js
import { WebSocketServer } from "ws";
import { URL } from "url";
import { addStream, removeStream } from "../services/streamHub.js";

// ---- tunables (env overridable) ----
const PING_INTERVAL_MS = Number(process.env.AGENT_STREAM_PING_INTERVAL_MS || 15000);
const MAX_BACKPRESSURE_BYTES = Number(process.env.AGENT_STREAM_MAX_BACKPRESSURE_BYTES || 512 * 1024);

// session id guard to prevent accidental huge keys / weird input
function isValidSessionId(s) {
  return typeof s === "string" && /^[a-zA-Z0-9_\-:]{3,120}$/.test(s);
}

function isOpen(ws) {
  return ws?.readyState === 1;
}

export function attachAgentStreamWs(server) {
  const wss = new WebSocketServer({
    server,
    path: "/agent-stream",
    maxPayload: 64 * 1024,
  });

  // Sweep dead clients (in case close events don't fire)
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws) continue;

      // backpressure => terminate if client can't keep up
      if (ws.bufferedAmount > MAX_BACKPRESSURE_BYTES) {
        try { ws.terminate(); } catch {}
        continue;
      }

      // keepalive
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        continue;
      }

      ws.isAlive = false;
      try { ws.ping(); } catch {
        try { ws.terminate(); } catch {}
      }
    }
  }, PING_INTERVAL_MS);

  wss.on("close", () => {
    try { clearInterval(sweep); } catch {}
  });

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    // Parse sessionId safely even if req.url is "/agent-stream?...".
    let sessionId = "";
    try {
      const url = new URL(req.url || "", "http://localhost");
      sessionId = url.searchParams.get("sessionId") || "";
    } catch {
      sessionId = "";
    }

    if (!isValidSessionId(sessionId)) {
      try { ws.close(1008, "invalid sessionId"); } catch {}
      return;
    }

    addStream(sessionId, ws);

    // Stream is server->client; ignore incoming
    ws.on("message", () => {});

    ws.on("close", () => {
      removeStream(sessionId, ws);
    });

    ws.on("error", () => {
      removeStream(sessionId, ws);
      try { ws.terminate(); } catch {}
    });

    // Extra safety: if socket becomes half-dead, sweep will terminate it.
    // So we do NOT need a second "grace" interval per socket.
  });

  return wss;
}
