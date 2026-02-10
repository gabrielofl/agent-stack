// src/routes/health.routes.js
import { Router } from "express";

export const healthRouter = Router();
healthRouter.get("/health", (req, res) => res.json({ ok: true }));

healthRouter.get("/debug/env", (req, res) => {
  const pick = (k) => process.env[k];

  res.json({
    ok: true,
    node: process.version,
    env: {
      HOST: pick("HOST"),
      PORT: pick("PORT"),
      MODEL_PATH: pick("MODEL_PATH"),
      MODEL_URL: pick("MODEL_URL") ? "(set)" : "(empty)",
      CTX_SIZE: pick("CTX_SIZE"),
      LLAMA_PORT: pick("LLAMA_PORT"),
    },
  });
});

healthRouter.get("/debug/llm/status", (req, res) => {
  res.json({ ok: true, status: getLlmStatus() });
});

healthRouter.get("/debug/llm/log", (req, res) => {
  const lines = Math.max(1, Math.min(2000, Number(req.query.lines || 200)));
  const tail = readBootLogTail(lines);
  res.type("text/plain").send(tail || "");
});
