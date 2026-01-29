// src/app.js (ESM)
import express from "express";
import cors from "cors";

import { corsOriginDelegate } from "./config/cors.js";

import { healthRouter } from "./routes/health.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { workerRouter } from "./routes/worker.routes.js";
import { sessionsRouter } from "./routes/sessions.routes.js";
import { agentRouter } from "./routes/agent.routes.js";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: corsOriginDelegate,
    })
  );

  app.use(express.json({ limit: "2mb" }));

  // Routes (same URLs as before)
  app.use(healthRouter);
  app.use(adminRouter);
  app.use(workerRouter);
  app.use(sessionsRouter);
  app.use(agentRouter);

  return app;
}
