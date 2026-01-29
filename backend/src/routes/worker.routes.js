// src/routes/worker.routes.js (ESM)
import { Router } from "express";
import { fetchFn } from "../services/fetch.js";
import { WORKER_HTTP } from "../config/env.js";

export const workerRouter = Router();

workerRouter.get("/worker/health", async (req, res) => {
  try {
    const r = await fetchFn(`${WORKER_HTTP}/health`, { method: "GET" });
    const text = await r.text();
    res.status(r.status).send(text || JSON.stringify({ ok: r.ok }));
  } catch (e) {
    res
      .status(502)
      .json({ ok: false, error: "worker_unreachable", detail: String(e?.message || e) });
  }
});
