// src/routes/agent.routes.js (ESM)
import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { sessions } from "../services/sessionStore.js";
import { fetchFn } from "../services/fetch.js";
import { WORKER_HTTP } from "../config/env.js";
import { ensureWorkerStream } from "../services/workerStream.js";
import { executeAgentAction } from "../services/pageHelpers.js";

export const agentRouter = Router();

// ---- Agent control ----
agentRouter.post("/agent/start", requireAdmin, async (req, res) => {
  const { sessionId, goal, model } = req.body || {};
  if (!sessionId || !sessions.has(sessionId)) return res.status(400).json({ error: "bad sessionId" });
  if (!goal) return res.status(400).json({ error: "missing goal" });

  const sess = sessions.get(sessionId);

  // ensure worker WS is up (best-effort; start still proceeds via HTTP)
  try {
    await ensureWorkerStream(sessionId);
  } catch {
    // worker may still be reachable by HTTP; don’t hard-fail here
  }

  // mark running
  sess.agent = {
    running: true,
    goal,
    model: model || "default",
    lastObsAt: 0,
    pendingApprovals: new Map(),
  };

  const r = await fetchFn(`${WORKER_HTTP}/agent/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, goal, model: model || "default" }),
  });

  const text = await r.text();
  if (!r.ok) return res.status(500).json({ error: "worker start failed", detail: text.slice(0, 200) });

  res.json({ ok: true });
});

agentRouter.post("/agent/correction", requireAdmin, async (req, res) => {
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
agentRouter.post("/agent/observe", requireAdmin, async (req, res) => {
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
agentRouter.post("/agent/approve", requireAdmin, async (req, res) => {
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
agentRouter.post("/agent/stop", requireAdmin, async (req, res) => {
  const { sessionId } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: "bad sessionId" });
  if (sess.agent) sess.agent.running = false;
  res.json({ ok: true });
});
