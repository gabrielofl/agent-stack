// src/routes/agent.routes.js (WORKER)
import { Router } from "express";
import { sessions } from "../services/agentStore.js";
import { push } from "../services/streamHub.js";
import { AgentSession } from "../agent/agentSession.js"; // IMPORTANT: correct casing
import { DBG, dlog } from "../services/debugLog.js";

export const agentRouter = Router();

const OBS_DECISION_MIN_INTERVAL_MS = Number(process.env.OBS_DECISION_MIN_INTERVAL_MS || 1200);

function now() {
  return Date.now();
}

function safeSlice(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) : str;
}

function actionKey(action) {
  try {
    return JSON.stringify(action || {});
  } catch {
    return String(action?.type || "unknown");
  }
}

function ensureRouteState(sess) {
  if (!sess._route) {
    sess._route = {
      deciding: false,
      lastDecisionAt: 0,
      lastIdleEventAt: 0,
      lastProposedKey: "",
      lastProposedAt: 0,
    };
  }
  return sess._route;
}

/**
 * Start: creates an agent session.
 * If goal is provided -> RUNNING immediately (matches backend behavior)
 * Otherwise -> IDLE (waiting for instruction)
 */
agentRouter.post("/agent/start", (req, res) => {
  const { sessionId, model, goal } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

  if (DBG.agent) dlog(sessionId, "ROUTE_START", { model, hasGoal: !!goal });

  const sess = new AgentSession({ sessionId, goal: "", model });
  ensureRouteState(sess);
  sessions.set(sessionId, sess);

  const g = String(goal ?? "").trim();
  if (g) {
    sess.setInstruction(g);
    push(sessionId, {
      type: "agent_event",
      sessionId,
      status: "running",
      message: `Instruction received: ${safeSlice(g, 180)}`,
      ts: now(),
    });
  } else {
    push(sessionId, {
      type: "agent_event",
      sessionId,
      status: "idle",
      message: "Agent connected and waiting for instructions.",
      ts: now(),
    });
  }

  res.json({ ok: true });
});

/**
 * Instruction: sets the current goal and moves the agent to RUNNING.
 */
agentRouter.post("/agent/instruction", (req, res) => {
  const { sessionId, text } = req.body || {};
  const sess = sessions.get(sessionId);

  if (!sess) return res.status(404).json({ error: "no agent session (call /agent/start)" });
  if (!text || !String(text).trim()) return res.status(400).json({ error: "missing text" });

  ensureRouteState(sess);

  if (DBG.agent) {
    dlog(sessionId, "ROUTE_INSTRUCTION", {
      text: safeSlice(text, 200),
      model: sess.model,
    });
  }

  sess.setInstruction(String(text).trim());

  push(sessionId, {
    type: "agent_event",
    sessionId,
    status: "running",
    message: `Instruction received: ${safeSlice(String(text).trim(), 180)}`,
    ts: now(),
  });

  res.json({ ok: true });
});

/**
 * Observe: backend calls this with DOM snapshot.
 * - If IDLE: do nothing (avoid spam)
 * - If RUNNING: decide next action (throttled + no concurrent decides)
 * - If DONE: do nothing
 */
agentRouter.post("/agent/observe", async (req, res) => {
  const { sessionId, obsId, url, img, imgTs, viewport, elements, ts } = req.body || {};
  const sess = sessions.get(sessionId);

  if (!sess) return res.status(404).json({ error: "no agent session (call /agent/start)" });

  ensureRouteState(sess);

  sess.setObservation({ obsId, url, viewport, elements, ts });

  if (DBG.agent) {
    dlog(sessionId, "ROUTE_OBSERVE", {
      obsId,
      url,
      elementsCount: Array.isArray(elements) ? elements.length : 0,
      status: sess.status,
    });
  }

  // 1) IDLE -> throttle idle spam
  if (sess.status === "idle") {
    const t = now();
    if (t - sess._route.lastIdleEventAt > 15_000) {
      sess._route.lastIdleEventAt = t;
      push(sessionId, {
        type: "agent_event",
        sessionId,
        status: "idle",
        message: "Waiting for instructions…",
        ts: t,
      });
    }
    return res.json({ ok: true });
  }

  // 2) DONE -> do nothing
  if (sess.status === "done") {
    return res.json({ ok: true });
  }

  // 3) Throttle decideNextAction + prevent concurrent decides
  const t = now();

  if (sess._route.deciding) return res.json({ ok: true });

  if (t - sess._route.lastDecisionAt < OBS_DECISION_MIN_INTERVAL_MS) {
    return res.json({ ok: true });
  }

  sess._route.deciding = true;
  sess._route.lastDecisionAt = t;

  try {
    const decision = await sess.decideNextAction();

    // IMPORTANT:
    // AgentSession already increments sess.step for real LLM attempts.
    // Use its current step as the stepId so action_result correlates.
    const stepId = `step-${Number(sess.step || 0)}`;

    if (DBG.agent) {
      dlog(sessionId, "DECIDE_RESULT", {
        done: !!decision?.done,
        type: decision?.action?.type || null,
        requiresApproval: !!decision?.requiresApproval,
        explanation: safeSlice(decision?.explanation || "", 200),
      });
    }

    // DONE -> go idle once
    if (decision?.done) {
      sess.setIdle();
      push(sessionId, {
        type: "agent_event",
        sessionId,
        status: "done",
        message: safeSlice(decision.message || "Task completed. Waiting for more instructions.", 300),
        ts: now(),
      });
      return res.json({ ok: true });
    }

    // Skip UI spam for internal waits
    if (decision?.action?.type === "wait") {
      return res.json({ ok: true });
    }

    // De-dupe identical proposed actions for short window
    const key = actionKey(decision.action);
    if (key === sess._route.lastProposedKey && now() - sess._route.lastProposedAt < 10_000) {
      return res.json({ ok: true });
    }
    sess._route.lastProposedKey = key;
    sess._route.lastProposedAt = now();

    push(sessionId, {
      type: "agent_proposed_action",
      sessionId,
      stepId,
      action: decision.action,
      explanation: safeSlice(decision.explanation || "", 300),
      requiresApproval: !!decision.requiresApproval,
      ts: now(),
    });

    // ask_user: mark awaitingUser so AgentSession can pace itself
    if (decision?.action?.type === "ask_user") {
      sess.awaitingUser = true;

      push(sessionId, {
        type: "agent_event",
        sessionId,
        status: "waiting_user",
        message: "Waiting for user input…",
        ts: now(),
      });
    }

    if (decision?.requiresApproval) {
      push(sessionId, {
        type: "agent_action_needs_approval",
        sessionId,
        stepId,
        ts: now(),
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    push(sessionId, {
      type: "agent_event",
      sessionId,
      status: "error",
      error: String(e?.message || e),
      ts: now(),
    });
    return res.status(500).json({ error: "decide failed", detail: String(e?.message || e) });
  } finally {
    sess._route.deciding = false;
  }
});

/**
 * Correction: guidance while RUNNING.
 * Also unpauses AgentSession.awaitingUser via addCorrection() (your AgentSession does this).
 */
agentRouter.post("/agent/correction", (req, res) => {
  const { sessionId, text, mode } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "no agent session" });

  sess.addCorrection({ text, mode: mode || "override", ts: now() });

  push(sessionId, {
    type: "agent_event",
    sessionId,
    status: "correction_received",
    mode: mode || "override",
    ts: now(),
  });

  res.json({ ok: true });
});

/**
 * Action result: backend sends result of executing the proposed action.
 * We:
 * - forward to UI stream
 * - feed failures back into corrections so the agent can recover generically
 * - feed extracted text/html back into corrections so the agent can "read" pages
 */
agentRouter.post("/agent/action_result", (req, res) => {
  const { sessionId, stepId, ok, error, note, data } = req.body || {};
  const sess = sessions.get(sessionId);

  if (sessionId && stepId) {
    push(sessionId, {
      type: "agent_event",
      sessionId,
      status: "action_result",
      stepId,
      ok: !!ok,
      error: error || null,
      note: note || null,
      data: data ?? null,
      ts: now(),
    });
  }

  // Feed the agent with what happened (lightweight + capped)
  if (sess) {
    if (!ok && error) {
      sess.addCorrection({
        mode: "system",
        ts: now(),
        text: `Previous action failed: ${safeSlice(error, 240)}. Choose a different approach (different element, scroll, use selector-based action, etc).`,
      });
    }

    // If we extracted readable text/html, give it to the agent (truncated)
    if (ok && data && typeof data === "object") {
      if (data.type === "extract_text" && data.text) {
        sess.addCorrection({
          mode: "context",
          ts: now(),
          text: `Extracted text (${safeSlice(data.selector, 80)}): ${safeSlice(data.text, 700)}`,
        });
      } else if (data.type === "extract_html" && data.html) {
        sess.addCorrection({
          mode: "context",
          ts: now(),
          text: `Extracted HTML (${safeSlice(data.selector, 80)}): ${safeSlice(data.html, 700)}`,
        });
      }
    }
  }

  res.json({ ok: true });
});
