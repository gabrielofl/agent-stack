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

  sess.workerBackoffMs = Math.min(
    Math.max(sess.workerBackoffMs || 500, 500) * 2,
    8000
  );

  sess.workerReconnectTimer = setTimeout(async () => {
    sess.workerReconnectTimer = null;
    try {
      await ensureWorkerStream(sessionId);
    } catch {
      // ensureWorkerStream will reschedule on failure
    }
  }, sess.workerBackoffMs);
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
    });

    ws.on("close", () => {
      cleanupConnecting();
      scheduleWorkerReconnect(sessionId);
    });

    ws.on("error", () => {
      cleanupConnecting();
      scheduleWorkerReconnect(sessionId);
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

      // forward non-sensitive worker events to viewers for debugging/UX
      if (
        msg.type === "log" ||
        msg.type === "agent_event" ||
        msg.type === "status" ||
        msg.type === "agent_status" ||
        msg.type === "agent_error"
      ) {
        broadcastToViewers(sess, { type: "agent_event", ...msg });
        return;
	  }
		if (msg.type === "agent_done") {
  // mark idle
  if (sess.agent) {
    sess.agent.running = false;
    sess.agent.goal = "";
  }

  broadcastToViewers(sess, {
    type: "agent_event",
    sessionId,
    status: "done",
    message: msg.message || "Done. Waiting for next instruction.",
    ts: Date.now(),
  });

  return;
}

      if (msg.type === "propose_action") {
        // forward proposed action to frontend viewers
        broadcastToViewers(sess, { type: "agent_proposed_action", ...msg });

        // If requires approval, store it and stop here
        if (msg.requiresApproval) {
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
          sess.agent.pendingApprovals.set(msg.stepId, msg.action);

          broadcastToViewers(sess, {
            type: "agent_action_needs_approval",
            sessionId,
            stepId: msg.stepId,
            ts: Date.now(),
          });
          return;
        }

        // ask_user action: forward to viewer and DO NOT execute
        if (msg.action?.type === "ask_user") {
          broadcastToViewers(sess, {
            type: "agent_question",
            sessionId,
            stepId: msg.stepId,
            question: msg.action.question || "",
            ts: Date.now(),
          });

          // optional: tell worker you didn't execute anything
          await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              stepId: msg.stepId,
              ok: true,
              note: "ask_user forwarded to viewer",
              ts: Date.now(),
              data: null,
            }),
          }).catch(() => {});

          return; // ✅ critical: don't fall through to executeAgentAction
        }

        // Execute immediately
        try {
          const execRes = await executeAgentAction(sess, msg.action);

          broadcastToViewers(sess, {
            type: "agent_executed_action",
            sessionId,
            stepId: msg.stepId,
            action: msg.action,
            ts: Date.now(),
          });

          // If screenshot_region produced an image, forward it to viewers
          if (execRes?.data?.type === "screenshot_region") {
            broadcastToViewers(sess, {
              type: "agent_screenshot_region",
              sessionId,
              stepId: msg.stepId,
              ...execRes.data,
              ts: Date.now(),
            });
          }

          await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              stepId: msg.stepId,
              ok: true,
              ts: Date.now(),
              data: execRes?.data || null,
            }),
          }).catch(() => {});
        } catch (e) {
          const err = String(e?.message || e);

          broadcastToViewers(sess, {
            type: "agent_action_failed",
            sessionId,
            stepId: msg.stepId,
            action: msg.action,
            error: err,
            ts: Date.now(),
          });

          await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              stepId: msg.stepId,
              ok: false,
              error: err,
              ts: Date.now(),
              data: null,
            }),
          }).catch(() => {});
        }
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
