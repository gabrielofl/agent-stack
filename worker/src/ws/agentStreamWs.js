// src/ws/agentStreamWs.js
import { WebSocketServer } from "ws";
import { addStream, removeStream } from "../services/streamHub.js";

// ---- tunables (env overridable) ----
const PING_INTERVAL_MS = Number(process.env.AGENT_STREAM_PING_INTERVAL_MS || 15000);
const PONG_GRACE_MS = Number(process.env.AGENT_STREAM_PONG_GRACE_MS || 10000);

// If a socket’s send buffer grows beyond this, it’s a strong sign the client is gone / slow.
// 512KB default is conservative.
const MAX_BACKPRESSURE_BYTES = Number(process.env.AGENT_STREAM_MAX_BACKPRESSURE_BYTES || 512 * 1024);

// session id guard to prevent accidental huge keys / weird input
function isValidSessionId(s) {
  // allow letters, numbers, _, -, : and length bounds
  // (your ids look like sessionId strings; adjust if yours include other chars)
  return typeof s === "string" && /^[a-zA-Z0-9_\-:]{3,120}$/.test(s);
}

export function attachAgentStreamWs(server) {
  const wss = new WebSocketServer({
    server,
    path: "/agent-stream",
    // If you sit behind a proxy and need to accept larger headers, tune server/proxy instead.
    // maxPayload is for incoming messages; we don't expect any, but keep sane.
    maxPayload: 64 * 1024,
  });

  // Sweep dead clients (in case close events don't fire)
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws) continue;

      // backpressure: close if the client can't keep up
      if (ws.bufferedAmount > MAX_BACKPRESSURE_BYTES) {
        try {
          ws.terminate();
        } catch {}
        continue;
      }

      // keepalive: if we didn't get pong since last ping, terminate
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        continue;
      }

      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        try {
          ws.terminate();
        } catch {}
      }
    }
  }, PING_INTERVAL_MS);

  wss.on("close", () => {
    try {
      clearInterval(sweep);
    } catch {}
  });

  wss.on("connection", (ws, req) => {
    // Track liveness
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    // Parse sessionId safely even if req.url is just "/agent-stream?...".
    let sessionId = "";
    try {
      const url = new URL(req.url || "", "http://localhost");
      sessionId = url.searchParams.get("sessionId") || "";
    } catch {
      sessionId = "";
    }

    if (!isValidSessionId(sessionId)) {
      try {
        ws.close(1008, "invalid sessionId"); // policy violation / bad input
      } catch {}
      return;
    }

    addStream(sessionId, ws);

    // If client sends anything, ignore (stream is server->client)
    ws.on("message", () => {});

    ws.on("close", () => {
      removeStream(sessionId, ws);
    });

    ws.on("error", () => {
      removeStream(sessionId, ws);
      try {
        ws.terminate();
      } catch {}
    });

    // Extra safety: if no pong arrives within grace period after a ping burst, kill it.
    // (Useful in some proxy / ACA weirdness)
    const graceTimer = setInterval(() => {
      if (ws.readyState !== 1) {
        clearInterval(graceTimer);
        return;
      }
      // If the sweep marked it false and it stayed false for too long, terminate.
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        clearInterval(graceTimer);
      }
    }, PONG_GRACE_MS);

    ws.on("close", () => {
      try {
        clearInterval(graceTimer);
      } catch {}
    });
    ws.on("error", () => {
      try {
        clearInterval(graceTimer);
      } catch {}
    });
  });

  return wss;
}
