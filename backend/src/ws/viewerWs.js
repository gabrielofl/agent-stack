// src/ws/viewerWs.js (ESM)
import { WebSocketServer } from "ws";
import { URL } from "url";

import { sessions } from "../services/sessionStore.js";
import { fetchFn } from "../services/fetch.js";
import { WORKER_HTTP, ADMIN_TOKEN } from "../config/env.js";
import { ensureWorkerStream } from "../services/workerStream.js";
import { executeAgentAction, broadcastToViewers } from "../services/pageHelpers.js";
import { closeSession } from "../services/sessionLifecycle.js";
import { getCachedLlmStatus } from "../services/llmStatusCache.js";

// Lightweight WS admin auth
function isWsAdmin(msg) {
  const token = msg?.adminToken || "";
  return token && token === ADMIN_TOKEN;
}

function enqueueAction(sess, fn) {
  if (!sess._actionQueue) sess._actionQueue = Promise.resolve();
  sess._actionQueue = sess._actionQueue.then(fn).catch(() => {});
  return sess._actionQueue;
}

function broadcastResultData(sess, sessionId, stepId, data) {
  if (!data || !data.type) return;

  broadcastToViewers(sess, {
    type: "agent_action_data",
    sessionId,
    stepId,
    data,
    ts: Date.now(),
  });

  if (data.type === "screenshot_region") {
    broadcastToViewers(sess, {
      type: "agent_screenshot_region",
      sessionId,
      stepId,
      ...data,
      ts: Date.now(),
    });
  }

  if (data.type === "extract_text") {
    broadcastToViewers(sess, {
      type: "agent_extract_text",
      sessionId,
      stepId,
      selector: data.selector,
      text: data.text,
      ts: Date.now(),
    });
  }

  if (data.type === "extract_html") {
    broadcastToViewers(sess, {
      type: "agent_extract_html",
      sessionId,
      stepId,
      selector: data.selector,
      html: data.html,
      ts: Date.now(),
    });
  }
}

export function attachViewerWs(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId || !sessions.has(sessionId)) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid sessionId" }));
      ws.close();
      return;
    }

    const sess = sessions.get(sessionId);
    sess.clients.add(ws);

    ws.send(JSON.stringify({ type: "hello", sessionId, message: "Connected. Streaming frames." }));

    // Send cached LLM status immediately
    const snap = getCachedLlmStatus();
    if (snap?.payload) {
      try {
        ws.send(JSON.stringify({
          type: "llm_status",
          sessionId,
          level: snap.level,
          payload: snap.payload,
          ts: snap.ts,
          cached: true,
        }));
      } catch {}
    }

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      try {
        if (msg.type === "user_click") {
          const { x, y, button } = msg;
          await sess.page.mouse.click(x, y, { button: button || "left" });
          ws.send(JSON.stringify({ type: "ack", action: "user_click", x, y }));
          return;
        }

        if (msg.type === "user_type") {
          await sess.page.keyboard.type(msg.text || "");
          ws.send(JSON.stringify({ type: "ack", action: "user_type" }));
          return;
        }

        if (msg.type === "goto") {
          await sess.page.goto(msg.url, { waitUntil: "domcontentloaded", timeout: 60000 });
          ws.send(JSON.stringify({ type: "ack", action: "goto", url: msg.url }));
          return;
        }

        if (msg.type === "close_session") {
          await closeSession(sessionId);
          return;
        }

        if (msg.type === "agent_start") {
          if (!isWsAdmin(msg)) {
            ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
            return;
          }

          const goal = msg.goal;
          const model = msg.model || "default";
          if (!goal) {
            ws.send(JSON.stringify({ type: "error", message: "missing goal" }));
            return;
          }

          try { await ensureWorkerStream(sessionId); } catch {}

          sess.agent = {
            running: true,
            goal,
            model,
            lastObsAt: 0,
            pendingApprovals: new Map(),
          };

          const r = await fetchFn(`${WORKER_HTTP}/agent/start`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, goal, model }),
          });

          const text = await r.text();
          if (!r.ok) {
            ws.send(JSON.stringify({
              type: "error",
              message: "worker start failed",
              detail: text.slice(0, 200),
            }));
            return;
          }

          ws.send(JSON.stringify({ type: "ack", action: "agent_start" }));
          return;
        }

        if (msg.type === "agent_correction") {
          if (!isWsAdmin(msg)) {
            ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
            return;
          }

          const text = msg.text;
          const mode = msg.mode || "override";
          if (!text) {
            ws.send(JSON.stringify({ type: "error", message: "missing text" }));
            return;
          }

          const r = await fetchFn(`${WORKER_HTTP}/agent/correction`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, text, mode }),
          });

          const out = await r.text();
          if (!r.ok) {
            ws.send(JSON.stringify({
              type: "error",
              message: "worker correction failed",
              detail: out.slice(0, 200),
            }));
            return;
          }

          ws.send(JSON.stringify({ type: "ack", action: "agent_correction" }));
          return;
        }

        if (msg.type === "agent_approve") {
          if (!isWsAdmin(msg)) {
            ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
            return;
          }

          const stepId = msg.stepId;
          if (!stepId) {
            ws.send(JSON.stringify({ type: "error", message: "missing stepId" }));
            return;
          }

          const action = sess.agent?.pendingApprovals?.get(stepId);
          if (!action) {
            ws.send(JSON.stringify({ type: "error", message: "no_pending_action" }));
            return;
          }

          sess.agent.pendingApprovals.delete(stepId);

          // Execute approval in the same serialized queue as other actions
          enqueueAction(sess, async () => {
            try {
              const execRes = await executeAgentAction(sess, action);

              broadcastToViewers(sess, {
                type: "agent_executed_action",
                sessionId,
                stepId,
                action,
                ts: Date.now(),
              });

              if (execRes?.data) {
                broadcastResultData(sess, sessionId, stepId, execRes.data);
              }

              await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  sessionId,
                  stepId,
                  ok: true,
                  data: execRes?.data || null,
                  ts: Date.now(),
                }),
              });

              ws.send(JSON.stringify({ type: "ack", action: "agent_approve", stepId }));
            } catch (e) {
              const err = String(e?.message || e);

              await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  sessionId,
                  stepId,
                  ok: false,
                  error: err,
                  ts: Date.now(),
                }),
              });

              ws.send(JSON.stringify({ type: "error", message: "action_failed", detail: err }));
            }
          });

          return;
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: String(e?.message || e) }));
      }
    });

    ws.on("close", async () => {
      sess.clients.delete(ws);
    });
  });

  return wss;
}
