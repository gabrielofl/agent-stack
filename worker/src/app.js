// src/app.js
import express from "express";
import { healthRouter } from "./routes/health.routes.js";
import { agentRouter } from "./routes/agent.routes.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.use(healthRouter);
  app.use(agentRouter);

  return app;
}
