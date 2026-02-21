// src/index.js
import { PORT, HOST } from "./config/env.js";
import { initLlmStatusBroadcaster } from "./services/llmStatus.js";
import { attachAgentStreamWs } from "./ws/agentStreamWs.js";
import express from "express";
import crypto from "crypto";
import { healthRouter } from "./routes/health.routes.js";
import { llmHealthRouter } from "./routes/llmHealth.routes.js";
import { agentRouter } from "./routes/agent.routes.js";

initLlmStatusBroadcaster();

function createApp() {
  const app = express();

  // Correlation id
  app.use((req, res, next) => {
    req._rid = crypto.randomUUID?.() || String(Date.now());
    res.setHeader("x-request-id", req._rid);
    next();
  });

  // Body
  app.use(express.json({ limit: "2mb" }));

  // Log every request + response timing
  app.use((req, res, next) => {
    const start = Date.now();
    const rid = req._rid;
    console.log(`[REQ] rid=${rid} ${req.method} ${req.url} ua=${req.headers["user-agent"] || ""}`);

    res.on("finish", () => {
      const ms = Date.now() - start;
      console.log(`[RES] rid=${rid} ${req.method} ${req.url} -> ${res.statusCode} (${ms}ms)`);
    });

    next();
  });

  // Routes
  app.use(healthRouter);
  app.use(llmHealthRouter);
  app.use(agentRouter);

  // Express error handler (very important)
  app.use((err, req, res, next) => {
    console.error(`[ERR] rid=${req?._rid} ${req?.method} ${req?.url}`, err?.stack || err);
    res.status(500).json({ ok: false, error: "internal_error", rid: req?._rid });
  });

  // Crash visibility
  process.on("unhandledRejection", (e) => console.error("[FATAL] unhandledRejection", e));
  process.on("uncaughtException", (e) => console.error("[FATAL] uncaughtException", e));

  return app;
}

function createServer({ port, host }) {
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`worker-agent listening on ${host}:${port}`);
  });

  attachAgentStreamWs(server);
  return server;
}

createServer({ port: PORT, host: HOST });
