// src/routes/worker.routes.js (ESM)
import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { sessions } from "../services/sessionStore.js";
import { fetchFn } from "../services/fetch.js";
import { WORKER_HTTP } from "../config/env.js";
import { ensureWorkerStream } from "../services/workerStream.js";
import { executeAgentAction } from "../services/pageHelpers.js";
import { broadcastToSession } from "../services/frontendBroadcast.js";

export const workerRouter = Router();

workerRouter.post("/worker/start", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const { sessionId, model } = req.body || {};

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ ok: false, error: "bad_sessionId" });
  }

  const sess = sessions.get(sessionId);

  // Ensure worker WS is up (non-fatal)
  try { await ensureWorkerStream(sessionId); } catch {}

  // --- helper: safe fetch json/text ---
  async function safeJson(url) {
    try {
      const r = await fetchFn(url, { method: "GET" });
      const text = await r.text();
      try { return { ok: r.ok, status: r.status, json: JSON.parse(text) }; }
      catch { return { ok: r.ok, status: r.status, json: null, raw: text }; }
    } catch (e) {
      return { ok: false, status: 0, error: String(e?.message || e) };
    }
  }

  async function safeText(url) {
    try {
      const r = await fetchFn(url, { method: "GET" });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    } catch (e) {
      return { ok: false, status: 0, text: "", error: String(e?.message || e) };
    }
  }

  // 1) create/ensure worker agent session (IDLE)
  let workerStart = { ok: false, status: 0, raw: "" };
  try {
    const r = await fetchFn(`${WORKER_HTTP}/agent/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, model: model || "default" }),
    });
    const raw = await r.text();
    workerStart = { ok: r.ok, status: r.status, raw: raw.slice(0, 600) };

    if (!r.ok) {
      // even if agent/start failed, try to pull boot signals to show WHY
      const bootStatus = await safeJson(`${WORKER_HTTP}/debug/llm/status`);
      const bootLog = await safeText(`${WORKER_HTTP}/debug/llm/log?lines=250`);

      const payload = {
        ok: false,
        error: "worker_start_failed",
        workerStart,
        llmStatus: null,
        bootStatus: bootStatus.json ?? bootStatus.raw ?? bootStatus,
        bootLog: bootLog.text || "",
        ms: Date.now() - startedAt,
      };

      // push to frontend admin panel via WS
      broadcastToSession(sessionId, {
        type: "llm_status",
        sessionId,
        level: "down",
        reason: "worker_start_failed",
        payload,
        ts: Date.now(),
      });

      return res.status(502).json(payload);
    }
  } catch (e) {
    const payload = {
      ok: false,
      error: "worker_unreachable",
      detail: String(e?.message || e),
      workerStart,
      llmStatus: null,
      bootStatus: null,
      bootLog: "",
      ms: Date.now() - startedAt,
    };

    broadcastToSession(sessionId, {
      type: "llm_status",
      sessionId,
      level: "down",
      reason: "worker_unreachable",
      payload,
      ts: Date.now(),
    });

    return res.status(502).json(payload);
  }

  // 2) probe LLM health ONCE (after worker start)
  let llmStatus = null;
  try {
    const rr = await fetchFn(`${WORKER_HTTP}/health/llm?debug=1`, { method: "GET" });
    const text = await rr.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    // keep your structure stable
    llmStatus = json
      ? { ok: rr.ok, status: rr.status, ...json }
      : { ok: rr.ok, status: rr.status, raw: text.slice(0, 2000) };
  } catch (e) {
    llmStatus = {
      ok: false,
      status: 0,
      error: "llm_probe_failed",
      detail: String(e?.message || e),
    };
  }

  // 3) Pull boot status/log from worker (explicit and best for debugging)
  const bootStatusRes = await safeJson(`${WORKER_HTTP}/debug/llm/status`);
  const bootStatus = bootStatusRes.json ?? bootStatusRes.raw ?? bootStatusRes;

  // Always pull a short log tail if you want “maximum explicit”
  // If you prefer only-on-failure, wrap in `if (!llmStatus?.ok) { ... }`
  const bootLogRes = !llmStatus?.ok
    ? await safeText(`${WORKER_HTTP}/debug/llm/log?lines=350`)
    : { ok: true, status: 200, text: "" };

  const bootLog = bootLogRes.text || "";

  // 4) mark backend agent as idle
  sess.agent = {
    running: false,
    goal: "",
    model: model || "default",
    lastObsAt: 0,
    pendingApprovals: new Map(),
  };

  const ms = Date.now() - startedAt;

  const responsePayload = {
    ok: true,
    status: "idle",
    ms,
    workerStart,
    llmStatus,
    bootStatus,
    bootLog, // only non-empty if degraded in this version
  };

	broadcastToSession(sessionId, {
  type: "agent_event",
  sessionId,
  status: "llm_probe_complete",
  message: llmStatus?.ok ? "LLM probe: ready" : "LLM probe: degraded",
  ts: Date.now(),
});

  // 5) push to frontend admin panel via WS (this is your “most explicit” path)
  broadcastToSession(sessionId, {
    type: "llm_status",
    sessionId,
    level: llmStatus?.ok ? "ready" : "degraded",
    payload: responsePayload,
    ts: Date.now(),
  });

  return res.json(responsePayload);
});

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
