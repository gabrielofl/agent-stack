// src/server.js (ESM)
import http from "http";
import { createApp } from "./app.js";
import { attachViewerWs } from "./ws/viewerWs.js";

export function createServer() {
  const app = createApp();
  const server = http.createServer(app);

  // WS viewer stream on /ws
  attachViewerWs(server);

  return server;
}
