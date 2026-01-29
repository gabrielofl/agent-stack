// src/services/workerStream.js (ESM)
import WebSocket from "ws";
import { sessions } from "./sessionStore.js";
import { fetchFn } from "./fetch.js";
import { WORKER_HTTP, WORKER_WS } from "../config/env.js";
import { broadcastToViewers, executeAgentAction } from "./pageHelpers.js";

export function scheduleWorkerReconnect(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  if (sess.workerReconnectTimer) return; // already scheduled

  sess.workerBackoffMs = Math.min(Math.max(sess.workerBackoffMs || 500, 500) * 2, 8000);

  sess.workerReconnectTimer = setTimeout(async () => {
    sess.workerReconnectTimer = null;
    try {
      await ensureWorkerStream(sessionId);
    } catch {
      // ensureWorkerStream will reschedule on failure
    }
  }, sess.workerBackoffMs);
}

function ensureAgentStruct(sess) {
  if (!sess.agent) {
    sess.agent = {
      running: false,
      goal: "",
      model: "default",
      lastObsAt: 0,
      pendingApprovals: new Map(),
    };
  }
  if (!sess.agent.pendingApprovals) sess.agent.pendingApprovals = new Map();
  return sess.agent;
}

async function postActionResult({ sessionId, stepId, ok, error, note, data }) {
  try {
    await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        stepId,
        ok: !!ok,
        error: error || null,
        note: note || null,
        data: data ?? null,
        ts: Date.now(),
      }),
    });
  } catch {
    // best-effort
  }
}

export async function ensureWorkerStream(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) throw new Error("unknown session");

  // Already connected?
  if (sess.workerWs && sess.workerWs.readyState === WebSocket.OPEN) return;

  // Connection in-flight?
  if (sess.workerConnecting) return sess.workerConnecting;

  sess.workerConnecting = (async () => {
    // Clear any stale socket
    try {
      if (sess.workerWs && sess.workerWs.readyState !== WebSocket.CLOSED) {
        sess.workerWs.close();
      }
    } catch {}

    const wsUrl = `${WORKER_WS}?sessionId=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
    sess.workerWs = ws;

    const cleanupConnecting = () => {
      sess.workerConnecting = null;
    };

    ws.on("open", () => {
      sess.workerBackoffMs = 500; // reset backoff on success
      cleanupConnecting();

      broadcastToViewers(sess, {
        type: "agent_event",
        sessionId,
        status: "worker_ws_open",
        ts: Date.now(),
      });
    });

    ws.on("close", () => {
      cleanupConnecting();
      scheduleWorkerReconnect(sessionId);

      broadcastToViewers(sess, {
        type: "agent_event",
        sessionId,
        status: "worker_ws_closed",
        ts: Date.now(),
      });
    });

    ws.on("error", (err) => {
      cleanupConnecting();
      scheduleWorkerReconnect(sessionId);

      broadcastToViewers(sess, {
        type: "agent_event",
        sessionId,
        status: "worker_ws_error",
        error: String(err?.message || err),
        ts: Date.now(),
      });
    });

    // Keepalive ping (some proxies kill idle WS)
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {}
      }
    }, 15000);

    ws.on("close", () => clearInterval(pingInterval));
    ws.on("error", () => clearInterval(pingInterval));

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const t = msg?.type;

      // ---- 1) Forward worker events/logs to viewers (safe) ----
      // NOTE: worker may emit "agent_event" for idle/running/done, errors, etc.
      if (t === "log" || t === "agent_event" || t === "status" || t === "agent_status" || t === "agent_error") {
        broadcastToViewers(sess, { type: "agent_event", ...msg });

        // If worker declared done in an event, mark backend as idle too
        if (t === "agent_event" && msg?.status === "done") {
          const agent = ensureAgentStruct(sess);
          agent.running = false;
          agent.goal = "";
        }
        return;
      }

      // Optional compatibility: some older worker builds might emit this
      if (t === "agent_done") {
        const agent = ensureAgentStruct(sess);
        agent.running = false;
        agent.goal = "";

        broadcastToViewers(sess, {
          type: "agent_event",
          sessionId,
          status: "done",
          message: msg.message || "Done. Waiting for next instruction.",
          ts: Date.now(),
        });
        return;
      }

      // ---- 2) Normalize propose messages (support old + new) ----
      const isPropose = t === "propose_action" || t === "agent_proposed_action";

      if (!isPropose) return;

      const agent = ensureAgentStruct(sess);

      const stepId = String(msg.stepId || msg.stepID || msg.step || "");
      const action = msg.action || null;
      const requiresApproval = !!msg.requiresApproval;

      // Forward proposed action to frontend in a consistent format
      broadcastToViewers(sess, {
        type: "agent_proposed_action",
        sessionId,
        stepId,
        action,
        explanation: msg.explanation || "",
        requiresApproval,
        ts: Date.now(),
      });

      // ---- 3) Store approvals if required ----
      if (requiresApproval) {
        agent.pendingApprovals.set(stepId, action);

        broadcastToViewers(sess, {
          type: "agent_action_needs_approval",
          sessionId,
          stepId,
          ts: Date.now(),
        });

        // Do not execute
        return;
      }

      // ---- 4) ask_user should never execute ----
      if (action?.type === "ask_user") {
        broadcastToViewers(sess, {
          type: "agent_question",
          sessionId,
          stepId,
          question: action.question || "",
          ts: Date.now(),
        });

        await postActionResult({
          sessionId,
          stepId,
          ok: true,
          note: "ask_user forwarded to viewer",
        });

        return;
      }

      // ---- 5) Execute immediately (autonomous actions) ----
      try {
        const execRes = await executeAgentAction(sess, action);

        broadcastToViewers(sess, {
          type: "agent_executed_action",
          sessionId,
          stepId,
          action,
          ts: Date.now(),
        });

        // If screenshot_region produced an image, forward it to viewers
        if (execRes?.data?.type === "screenshot_region") {
          broadcastToViewers(sess, {
            type: "agent_screenshot_region",
            sessionId,
            stepId,
            ...execRes.data,
            ts: Date.now(),
          });
        }

        await postActionResult({
          sessionId,
          stepId,
          ok: true,
          data: execRes?.data || null,
        });
      } catch (e) {
        const err = String(e?.message || e);

        broadcastToViewers(sess, {
          type: "agent_action_failed",
          sessionId,
          stepId,
          action,
          error: err,
          ts: Date.now(),
        });

        await postActionResult({
          sessionId,
          stepId,
          ok: false,
          error: err,
          data: null,
        });
      }
    });

    // Wait for open or error/close (whichever comes first)
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        ws.off("close", onClose);
        resolve();
      };
      const onError = (e) => {
        ws.off("open", onOpen);
        ws.off("close", onClose);
        reject(e);
      };
      const onClose = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        reject(new Error("worker ws closed before open"));
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
  })();

  try {
    await sess.workerConnecting;
  } catch (e) {
    sess.workerConnecting = null;
    scheduleWorkerReconnect(sessionId);
    throw e;
  }
}
