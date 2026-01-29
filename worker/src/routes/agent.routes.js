// src/routes/agent.routes.js
import { Router } from "express";
import { sessions } from "../services/agentStore.js";
import { push } from "../services/streamHub.js";
import { AgentSession } from "../agent/agentSession.js";

export const agentRouter = Router();

agentRouter.post("/agent/start", (req, res) => {
  const { sessionId, goal, model } = req.body || {};
  if (!sessionId || !goal) return res.status(400).json({ error: "missing sessionId/goal" });

  sessions.set(sessionId, new AgentSession({ sessionId, goal, model }));

  push(sessionId, {
    type: "agent_status",
    sessionId,
    status: "started",
    goal,
    model: model || "default",
    ts: Date.now(),
  });

  res.json({ ok: true });
});

agentRouter.post("/agent/observe", async (req, res) => {
  const { sessionId, obsId, url, viewport, elements, ts } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "no agent session (call /agent/start)" });

  sess.setObservation({ obsId, url, viewport, elements, ts });

  try {
    push(sessionId, {
      type: "agent_status",
      sessionId,
      status: "observed",
      obsId,
      ts: Date.now(),
    });

    const decision = await sess.decideNextAction();
    const stepId = `step-${++sess.step}`;

    push(sessionId, {
      type: "propose_action",
      sessionId,
      stepId,
      requiresApproval: !!decision.requiresApproval,
      action: decision.action,
      explanation: decision.explanation || "",
      ts: Date.now(),
    });

    res.json({ ok: true });
  } catch (e) {
    push(sessionId, { type: "agent_error", sessionId, error: String(e?.message || e), ts: Date.now() });
    res.status(500).json({ error: "decide failed", detail: String(e?.message || e) });
  }
});

agentRouter.post("/agent/correction", (req, res) => {
  const { sessionId, text, mode } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "no agent session" });

  sess.addCorrection({ text, mode: mode || "override", ts: Date.now() });

  push(sessionId, {
    type: "agent_status",
    sessionId,
    status: "correction_received",
    mode: mode || "override",
    ts: Date.now(),
  });

  res.json({ ok: true });
});

// Backend sends this; you can use it later to improve planning.
// For now we keep it compatible and safe.
agentRouter.post("/agent/action_result", (req, res) => {
  const { sessionId, stepId, ok, error } = req.body || {};
  if (sessionId && stepId) {
    push(sessionId, {
      type: "agent_status",
      sessionId,
      status: "action_result",
      stepId,
      ok: !!ok,
      error: error || null,
      ts: Date.now(),
    });
  }
  res.json({ ok: true });
});
