import { Router } from "express";
import { fetchFn } from "../services/fetch.js";
import { WORKER_HTTP } from "../config/env.js";

export const workerReadinessRouter = Router();

async function probe(url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetchFn(url, { method: "GET", ...opts });
    const text = await r.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    return {
      ok: r.ok,
      status: r.status,
      latencyMs: Date.now() - t0,
      json,
      detail: text ? text.slice(0, 200) : null,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - t0,
      json: null,
      detail: String(e?.message || e),
    };
  }
}

workerReadinessRouter.get("/worker/readiness", async (req, res) => {
  // Worker API health
  const workerHealth = await probe(`${WORKER_HTTP}/health`);

  // LLM health (we’ll add this route on the worker in section B)
  const llmHealth = await probe(`${WORKER_HTTP}/health/llm`, {
    headers: { "cache-control": "no-cache" },
  });

  res.json({
    ok: workerHealth.ok && llmHealth.ok,
    worker: workerHealth,
    llm: llmHealth,
    ts: Date.now(),
  });
});
