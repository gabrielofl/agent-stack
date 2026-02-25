// src/index.js (ESM)
import http from "http";
import express from "express";
import cors from "cors";

import { HOST, PORT, ADMIN_TOKEN, AGENT_ENABLED } from "./config/env.js";
import { corsOriginDelegate } from "./config/cors.js";

import { attachViewerWs } from "./ws/viewerWs.js";
import { startLlmStatusPolling } from "./services/llmStatusCache.js";

import { adminRouter } from "./routes/admin.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { sessionsRouter } from "./routes/sessions.routes.js";
import { workerRouter } from "./routes/worker.routes.js";

export function createApp() {
  const app = express();

  const corsOptions = {
    origin: corsOriginDelegate,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
    maxAge: 86400,
  };

  app.use(cors(corsOptions));
  app.options(/.*/, cors({ origin: corsOriginDelegate }));
  app.use(express.json({ limit: "2mb" }));

  app.use(healthRouter);
	if (AGENT_ENABLED) {
		app.use(adminRouter);
		app.use(sessionsRouter);
		app.use(workerRouter);
    console.log("[agent] enabled");
  } else {
    console.log("[agent] disabled (AGENT_ENABLED=0)");
  }

  return app;
}

export function createServer() {
  const app = createApp();
  const server = http.createServer(app);

  if (AGENT_ENABLED) {
    attachViewerWs(server);
    startLlmStatusPolling();
    console.log("[agent] enabled");
  } else {
    console.log("[agent] disabled (AGENT_ENABLED=0)");
  }

  return server;
}

const server = createServer();

server.listen(PORT, HOST, () => {
  console.log(`Backend listening on ${HOST}:${PORT}`);
  console.log(`Admin token (server): ${ADMIN_TOKEN}`);
});