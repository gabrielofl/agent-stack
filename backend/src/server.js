// src/server.js (ESM)
import http from "http";
import { createApp } from "./app.js";
import { attachViewerWs } from "./ws/viewerWs.js";
import { startLlmStatusPolling } from "./services/llmStatusCache.js";

export function createServer() {
  const app = createApp();
  const server = http.createServer(app);

  attachViewerWs(server);
  startLlmStatusPolling();

  return server;
}
