// src/routes/agent.routes.js
import { Router } from "express";
import { sessions } from "../services/agentStore.js";
import { push } from "../services/streamHub.js";
import { AgentSession } from "../agent/agentSession.js";

export const agentRouter = Router();

/**
 * Start: creates an agent session in IDLE mode (waiting for instructions).
 * Goal is optional here; instructions should go through /agent/instruction.
 */
agentRouter.post("/agent/start", (req, res) => {
  const { sessionId, model } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

  const sess = new AgentSession({ sessionId, goal: "", model });
  sessions.set(sessionId, sess);

  push(sessionId, {
    type: "agent_event",
    sessionId,
    status: "idle",
    message: "Agent connected and waiting for instructions.",
    ts: Date.now(),
  });

  res.json({ ok: true });
});

/**
 * Instruction: sets the current goal and moves the agent to RUNNING.
 * This is what you call with “change language to English”.
 */
agentRouter.post("/agent/instruction", (req, res) => {
  const { sessionId, text } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "no agent session (call /agent/start)" });
  if (!text || !String(text).trim()) return res.status(400).json({ error: "missing text" });

  sess.setInstruction(String(text).trim());

  push(sessionId, {
    type: "agent_event",
    sessionId,
    status: "running",
    message: `Instruction received: ${String(text).trim()}`,
    ts: Date.now(),
  });

  res.json({ ok: true });
});

/**
 * Observe: backend calls this with DOM snapshot.
 * - If IDLE: do nothing (no propose spam)
 * - If RUNNING: decide next action
 * - If DONE: do nothing
 */
agentRouter.post("/agent/observe", async (req, res) => {
  const { sessionId, obsId, url, viewport, elements, ts } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "no agent session (call /agent/start)" });

  sess.setObservation({ obsId, url, viewport, elements, ts });

  // 1) If idle, do not propose actions
  if (sess.status === "idle") {
    push(sessionId, {
      type: "agent_event",
      sessionId,
      status: "idle",
      message: "Waiting for instructions…",
      ts: Date.now(),
    });
    return res.json({ ok: true });
  }

  // 2) If done, do nothing
  if (sess.status === "done") {
    return res.json({ ok: true });
  }

  try {
    const decision = await sess.decideNextAction();
    const stepId = `step-${++sess.step}`;

    // If model says DONE -> emit done + go idle
    if (decision?.done) {
      sess.setIdle();

      push(sessionId, {
        type: "agent_event",
        sessionId,
        status: "done",
        message: decision.message || "Task completed. Waiting for more instructions.",
        ts: Date.now(),
      });

      return res.json({ ok: true });
    }

    // Push proposed action in the format your frontend expects:
    push(sessionId, {
      type: "agent_proposed_action",
      sessionId,
      stepId,
      action: decision.action,
      explanation: decision.explanation || "",
      ts: Date.now(),
    });

    // Only ask for approval if required (policy)
    if (decision.requiresApproval) {
      push(sessionId, {
        type: "agent_action_needs_approval",
        sessionId,
        stepId,
        ts: Date.now(),
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    push(sessionId, {
      type: "agent_event",
      sessionId,
      error: String(e?.message || e),
      ts: Date.now(),
    });
    return res.status(500).json({ error: "decide failed", detail: String(e?.message || e) });
  }
});

/**
 * Correction still OK; treat it as guidance while RUNNING.
 */
agentRouter.post("/agent/correction", (req, res) => {
  const { sessionId, text, mode } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "no agent session" });

  sess.addCorrection({ text, mode: mode || "override", ts: Date.now() });

  push(sessionId, {
    type: "agent_event",
    sessionId,
    status: "correction_received",
    mode: mode || "override",
    ts: Date.now(),
  });

  res.json({ ok: true });
});

agentRouter.post("/agent/action_result", (req, res) => {
  const { sessionId, stepId, ok, error } = req.body || {};
  if (sessionId && stepId) {
    push(sessionId, {
      type: "agent_event",
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
