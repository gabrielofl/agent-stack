// src/routes/agent.routes.js (ESM)
import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { sessions } from "../services/sessionStore.js";
import { fetchFn } from "../services/fetch.js";
import { WORKER_HTTP } from "../config/env.js";
import { ensureWorkerStream } from "../services/workerStream.js";
import { executeAgentAction } from "../services/pageHelpers.js";

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

workerRouter.get("/worker/llm", async (req, res) => {
  try {
    const r = await fetchFn(`${WORKER_HTTP}/health/llm`, { method: "GET" });
    const text = await r.text();
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ ok: false, error: "llm_unreachable", detail: String(e?.message || e) });
  }
});

// ---- Agent control ----
// src/routes/agent.routes.js
// backend: src/routes/agent.routes.js (ESM)
workerRouter.post("/worker/start", requireAdmin, async (req, res) => {
  const { sessionId, model } = req.body || {};
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: "bad sessionId" });
  }

  const sess = sessions.get(sessionId);

  // ensure worker WS is up (ok if this fails)
  try { await ensureWorkerStream(sessionId); } catch {}

  // 1) create/ensure worker agent session (IDLE)
  const r = await fetchFn(`${WORKER_HTTP}/agent/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, model: model || "default" }),
  });

  const out = await r.text();
  if (!r.ok) {
    return res.status(500).json({ error: "worker start failed", detail: out.slice(0, 200) });
  }

  // 2) probe LLM health ONCE (after worker start)
  let llmStatus;
  try {
    const rr = await fetchFn(`${WORKER_HTTP}/health/llm?debug=1`, { method: "GET" });
    const json = await rr.json().catch(async () => ({ raw: await rr.text() }));
    llmStatus = { ok: rr.ok, status: rr.status, ...json };
  } catch (e) {
    llmStatus = { ok: false, status: 0, error: "llm_probe_failed", detail: String(e?.message || e) };
  }

  // 3) mark backend agent as idle
  sess.agent = {
    running: false,
    goal: "",
    model: model || "default",
    lastObsAt: 0,
    pendingApprovals: new Map(),
  };

  // ✅ RETURN IT so frontend can log it once
  return res.json({
    ok: true,
    status: "idle",
    llmStatus, // ✅
  });
});


// backend: src/routes/agent.routes.js (ESM)

workerRouter.post("/worker/instruction", requireAdmin, async (req, res) => {
  const { sessionId, text, model } = req.body || {};
  if (!sessionId || !sessions.has(sessionId)) return res.status(400).json({ error: "bad sessionId" });
  if (!text) return res.status(400).json({ error: "missing text" });

  const sess = sessions.get(sessionId);

  try { await ensureWorkerStream(sessionId); } catch {}

  sess.agent = sess.agent || { pendingApprovals: new Map() };
  sess.agent.running = true;
  sess.agent.goal = String(text).trim();
  sess.agent.model = model || sess.agent.model || "default";
  sess.agent.lastObsAt = 0;
  if (!sess.agent.pendingApprovals) sess.agent.pendingApprovals = new Map();

  // ✅ call worker instruction endpoint
  const r = await fetchFn(`${WORKER_HTTP}/agent/instruction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text: sess.agent.goal }),
  });

  const out = await r.text();
  if (!r.ok) return res.status(500).json({ error: "worker instruction failed", detail: out.slice(0, 200) });

  res.json({ ok: true, status: "running" });
});

workerRouter.post("/worker/correction", requireAdmin, async (req, res) => {
  const { sessionId, text, mode } = req.body || {};
  if (!sessionId || !sessions.has(sessionId)) return res.status(400).json({ error: "bad sessionId" });
  if (!text) return res.status(400).json({ error: "missing text" });

  const r = await fetchFn(`${WORKER_HTTP}/agent/correction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text, mode: mode || "override" }),
  });

  const out = await r.text();
  if (!r.ok) return res.status(500).json({ error: "worker correction failed", detail: out.slice(0, 200) });

  res.json({ ok: true });
});

// INTERNAL: proxy observe manually (admin only)
workerRouter.post("/worker/observe", requireAdmin, async (req, res) => {
  const { sessionId, obs } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

  const r = await fetchFn(`${WORKER_HTTP}/agent/observe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...(obs || {}) }),
  });

  const out = await r.text();
  if (!r.ok) return res.status(500).json({ error: "worker observe failed", detail: out.slice(0, 200) });

  res.json({ ok: true });
});

// Optional: approve a pending action that required approval
workerRouter.post("/worker/approve", requireAdmin, async (req, res) => {
  const { sessionId, stepId } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: "bad sessionId" });
  if (!stepId) return res.status(400).json({ error: "missing stepId" });

  const action = sess.agent?.pendingApprovals?.get(stepId);
  if (!action) return res.status(404).json({ error: "no_pending_action" });

  sess.agent.pendingApprovals.delete(stepId);

  try {
    await executeAgentAction(sess, action);
    await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, stepId, ok: true, ts: Date.now() }),
    });
    res.json({ ok: true });
  } catch (e) {
    await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        stepId,
        ok: false,
        error: String(e?.message || e),
        ts: Date.now(),
      }),
    });
    res.status(500).json({ error: "action_failed", detail: String(e?.message || e) });
  }
});

// Optional: stop agent locally (doesn't assume worker has /stop; just stops observations)
workerRouter.post("/worker/stop", requireAdmin, async (req, res) => {
  const { sessionId } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: "bad sessionId" });
  if (sess.agent) sess.agent.running = false;
  res.json({ ok: true });
});
