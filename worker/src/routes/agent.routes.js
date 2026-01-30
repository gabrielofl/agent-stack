// src/routes/agent.routes.js  (WORKER - the one that owns AgentSession)
// Fixes:
// - DO NOT setIdle() on ask_user (that nukes goal + causes weird behavior)
// - Add "cooldown" + "inflight" guard so /observe can’t pile up requests
// - Don’t push “Waiting for instructions…” on every observe tick (spam)
// - Don’t emit proposed_action for "wait" (optional, but prevents pointless UI spam)
// - De-dupe repeated identical proposed actions (esp. ask_user)
// - Respect AgentSession.awaitingUser + backoff by trusting decideNextAction() return
import { Router } from "express";
import { sessions } from "../services/agentStore.js";
import { push } from "../services/streamHub.js";
import { AgentSession } from "../agent/agentSession.js";

export const agentRouter = Router();

// ---- local helpers ----
const OBS_DECISION_MIN_INTERVAL_MS = Number(process.env.OBS_DECISION_MIN_INTERVAL_MS || 1200);

function now() {
  return Date.now();
}

function safeSlice(s, n) {
  return String(s ?? "").length > n ? String(s ?? "").slice(0, n) : String(s ?? "");
}

function actionKey(action) {
  try {
    return JSON.stringify(action || {});
  } catch {
    return String(action?.type || "unknown");
  }
}

/**
 * Start: creates an agent session in IDLE mode (waiting for instructions).
 */
agentRouter.post("/agent/start", (req, res) => {
  const { sessionId, model } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

  const sess = new AgentSession({ sessionId, goal: "", model });
  // route-level guards
  sess._route = {
    deciding: false,            // inflight /observe decide
    lastDecisionAt: 0,          // throttle calls to decideNextAction
    lastIdleEventAt: 0,         // throttle “waiting…” events
    lastProposedKey: "",        // dedupe identical actions
    lastProposedAt: 0,
  };

  sessions.set(sessionId, sess);

  push(sessionId, {
    type: "agent_event",
    sessionId,
    status: "idle",
    message: "Agent connected and waiting for instructions.",
    ts: now(),
  });

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

  sess.setInstruction(String(text).trim());
  if (!sess._route) {
    sess._route = { deciding: false, lastDecisionAt: 0, lastIdleEventAt: 0, lastProposedKey: "", lastProposedAt: 0 };
  }

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
  const { sessionId, obsId, url, viewport, elements, ts } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "no agent session (call /agent/start)" });

  sess.setObservation({ obsId, url, viewport, elements, ts });

  if (!sess._route) {
    sess._route = { deciding: false, lastDecisionAt: 0, lastIdleEventAt: 0, lastProposedKey: "", lastProposedAt: 0 };
  }

  // 1) If idle, DO NOT keep pushing idle events every tick
  if (sess.status === "idle") {
    const n = now();
    if (n - sess._route.lastIdleEventAt > 15_000) {
      sess._route.lastIdleEventAt = n;
      push(sessionId, {
        type: "agent_event",
        sessionId,
        status: "idle",
        message: "Waiting for instructions…",
        ts: n,
      });
    }
    return res.json({ ok: true });
  }

  // 2) If done, do nothing
  if (sess.status === "done") {
    return res.json({ ok: true });
  }

  // 3) Throttle /observe-driven decisions + prevent piling up concurrent decides
  const n = now();
  if (sess._route.deciding) return res.json({ ok: true });
  if (n - sess._route.lastDecisionAt < OBS_DECISION_MIN_INTERVAL_MS) return res.json({ ok: true });

  sess._route.deciding = true;
  sess._route.lastDecisionAt = n;

  try {
    const decision = await sess.decideNextAction();
    const stepId = `step-${++sess.step}`;

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

    // Optional: do not spam UI with "wait" actions — they're internal pacing
    if (decision?.action?.type === "wait") {
      return res.json({ ok: true });
    }

    // De-dupe identical proposed actions for a short window
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
      ts: now(),
    });

    // If the action is ask_user, DO NOT setIdle().
    // AgentSession now sets awaitingUser internally and will return wait until user responds.
    if (decision?.action?.type === "ask_user") {
      push(sessionId, {
        type: "agent_event",
        sessionId,
        status: "waiting_user",
        message: "Waiting for user input…",
        ts: now(),
      });
    }

    if (decision.requiresApproval) {
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
      error: String(e?.message || e),
      ts: now(),
    });
    return res.status(500).json({ error: "decide failed", detail: String(e?.message || e) });
  } finally {
    sess._route.deciding = false;
  }
});

/**
 * Correction: treat as guidance while RUNNING.
 * Also unpauses AgentSession.awaitingUser via addCorrection() (already implemented).
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
      ts: now(),
    });
  }
  res.json({ ok: true });
});
