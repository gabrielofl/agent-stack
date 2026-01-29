// src/ws/agentStreamWs.js
import { WebSocketServer } from "ws";
import { addStream, removeStream } from "../services/streamHub.js";

export function attachAgentStreamWs(server) {
  const wss = new WebSocketServer({ server, path: "/agent-stream" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId") || "";

    if (!sessionId) {
      ws.close();
      return;
    }

    addStream(sessionId, ws);

    ws.on("close", () => {
      removeStream(sessionId, ws);
    });
  });

  return wss;
}

