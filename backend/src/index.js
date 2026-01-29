// src/index.js (ESM)
import { createServer } from "./server.js";
import { HOST, PORT, ADMIN_TOKEN } from "./config/env.js";

const server = createServer();

server.listen(PORT, HOST, () => {
  console.log(`Backend listening on ${HOST}:${PORT}`);
  console.log(`Admin token (server): ${ADMIN_TOKEN}`);
});

// // index.js (ESM)
// // Backend: Express + Playwright browser sessions + WS frame streaming + Worker-agent integration

// import express from "express";
// import http from "http";
// import cors from "cors";
// import crypto from "crypto";
// import { WebSocketServer } from "ws";
// import WebSocket from "ws";
// import { chromium } from "playwright";

// // ---- fetch polyfill (works on Node 18+ with global fetch; falls back if needed) ----
// let fetchFn = globalThis.fetch?.bind(globalThis);
// if (!fetchFn) {
//   try {
//     // Optional dependency fallback (only used if global fetch is missing)
//     const mod = await import("node-fetch");
//     fetchFn = mod.default;
//   } catch {
//     throw new Error(
//       "Global fetch is not available and node-fetch is not installed. Use Node 18+ or add node-fetch."
//     );
//   }
// }

// // -------------------- Config --------------------
// const WORKER_HTTP = process.env.WORKER_HTTP || "http://worker-agent:4000";
// const WORKER_WS = process.env.WORKER_WS || "ws://worker-agent:4000/agent-stream";
// const AGENT_OBS_MIN_INTERVAL_MS = 1000; // 1Hz

// const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
// const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString("hex");

// const ALLOWED_ORIGINS = new Set([
//   "https://purple-smoke-02e25d403.1.azurestaticapps.net",
// ]);

// // -------------------- App --------------------
// const app = express();

// app.use(
//   cors({
//     origin: (origin, cb) => {
//       // allow same-origin / server-to-server / curl (no Origin header)
//       if (!origin) return cb(null, true);
//       return cb(null, ALLOWED_ORIGINS.has(origin));
//     },
//   })
// );

// app.use(express.json({ limit: "2mb" }));

// app.get("/health", (req, res) => res.json({ ok: true }));

// function requireAdmin(req, res, next) {
//   const auth = req.headers.authorization || "";
//   const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
//   if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
//   next();
// }

// app.post("/admin/login", (req, res) => {
//   const { password } = req.body || {};
//   if (!ADMIN_PASSWORD) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
//   if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "invalid_password" });
//   res.json({ token: ADMIN_TOKEN });
// });

// app.get("/admin/me", requireAdmin, (req, res) => {
//   res.json({ ok: true, role: "admin" });
// });

// app.get("/worker/health", async (req, res) => {
//   try {
//     const r = await fetchFn(`${WORKER_HTTP}/health`, { method: "GET" });
//     const text = await r.text();
//     res.status(r.status).send(text || JSON.stringify({ ok: r.ok }));
//   } catch (e) {
//     res.status(502).json({ ok: false, error: "worker_unreachable", detail: String(e?.message || e) });
//   }
// });

// // -------------------- In-memory Sessions (MVP) --------------------
// // sessionId -> {
// //   browser, context, page, viewport,
// //   clients:Set<WebSocket>, interval,
// //   agent: { running, goal, model, lastObsAt, pendingApprovals: Map(stepId->action) },
// //   workerWs, workerConnecting: Promise<void> | null,
// //   workerReconnectTimer, workerBackoffMs
// // }
// const sessions = new Map();

// function newId() {
//   // more collision-resistant than Math.random
//   return `${crypto.randomBytes(6).toString("hex")}-${Date.now().toString(36)}`;
// }

// // -------------------- Page helpers --------------------
// async function extractClickableElements(page) {
//   return page.evaluate(() => {
//     const sel = [
//       "a[href]",
//       "button",
//       "input",
//       "textarea",
//       "select",
//       "[role='button']",
//       "[onclick]",
//     ].join(",");

//     const nodes = Array.from(document.querySelectorAll(sel));
//     const out = [];

//     for (const el of nodes.slice(0, 60)) {
//       const r = el.getBoundingClientRect();
//       if (r.width < 6 || r.height < 6) continue;

//       const text = (
//         el.innerText ||
//         el.getAttribute("aria-label") ||
//         el.getAttribute("title") ||
//         ""
//       ).trim();

//       out.push({
//         tag: el.tagName.toLowerCase(),
//         text: text.slice(0, 80),
//         x: Math.round(r.left + r.width / 2),
//         y: Math.round(r.top + r.height / 2),
//         w: Math.round(r.width),
//         h: Math.round(r.height),
//       });
//     }
//     return out;
//   });
// }

// function broadcastToViewers(sess, obj) {
//   const payload = JSON.stringify(obj);
//   for (const ws of sess.clients) {
//     if (ws.readyState === WebSocket.OPEN) ws.send(payload);
//   }
// }

// async function executeAgentAction(sess, action) {
//   if (!action || !action.type) throw new Error("bad action");
//   if (!sess?.page) throw new Error("session page not available");

//   if (action.type === "click") {
//     await sess.page.mouse.click(action.x, action.y, { button: action.button || "left" });
//   } else if (action.type === "type") {
//     await sess.page.keyboard.type(action.text || "");
//   } else if (action.type === "goto") {
//     await sess.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 60000 });
//   } else if (action.type === "wait") {
//     await new Promise((r) => setTimeout(r, Math.max(0, action.ms || 0)));
//   } else {
//     throw new Error("unsupported action: " + action.type);
//   }
// }

// // -------------------- Worker stream management --------------------
// function scheduleWorkerReconnect(sessionId) {
//   const sess = sessions.get(sessionId);
//   if (!sess) return;

//   if (sess.workerReconnectTimer) return; // already scheduled

//   sess.workerBackoffMs = Math.min(Math.max(sess.workerBackoffMs || 500, 500) * 2, 8000);

//   sess.workerReconnectTimer = setTimeout(async () => {
//     sess.workerReconnectTimer = null;
//     try {
//       await ensureWorkerStream(sessionId);
//     } catch {
//       // ensureWorkerStream will reschedule on failure
//     }
//   }, sess.workerBackoffMs);
// }

// async function ensureWorkerStream(sessionId) {
//   const sess = sessions.get(sessionId);
//   if (!sess) throw new Error("unknown session");

//   // Already connected?
//   if (sess.workerWs && sess.workerWs.readyState === WebSocket.OPEN) return;

//   // Connection in-flight?
//   if (sess.workerConnecting) return sess.workerConnecting;

//   sess.workerConnecting = (async () => {
//     // Clear any stale socket
//     try {
//       if (sess.workerWs && sess.workerWs.readyState !== WebSocket.CLOSED) {
//         sess.workerWs.close();
//       }
//     } catch {}

//     const wsUrl = `${WORKER_WS}?sessionId=${encodeURIComponent(sessionId)}`;
//     const ws = new WebSocket(wsUrl);
//     sess.workerWs = ws;

//     const cleanupConnecting = () => {
//       sess.workerConnecting = null;
//     };

//     ws.on("open", () => {
//       sess.workerBackoffMs = 500; // reset backoff on success
//       cleanupConnecting();
//       // console.log("[agent] worker stream open", sessionId);
//     });

//     ws.on("close", () => {
//       cleanupConnecting();
//       // console.log("[agent] worker stream closed", sessionId);
//       scheduleWorkerReconnect(sessionId);
//     });

//     ws.on("error", (e) => {
//       cleanupConnecting();
//       // console.log("[agent] worker stream error", sessionId, String(e));
//       scheduleWorkerReconnect(sessionId);
//     });

//     // Keepalive ping (some proxies kill idle WS)
//     const pingInterval = setInterval(() => {
//       if (ws.readyState === WebSocket.OPEN) {
//         try {
//           ws.ping();
//         } catch {}
//       }
//     }, 15000);

//     ws.on("close", () => clearInterval(pingInterval));
//     ws.on("error", () => clearInterval(pingInterval));

//     ws.on("message", async (data) => {
//       let msg;
//       try {
//         msg = JSON.parse(data.toString());
//       } catch {
//         return;
//       }

//       // You can forward non-sensitive worker events to viewers for debugging/UX
//       if (
//   msg.type === "log" ||
//   msg.type === "agent_event" ||
//   msg.type === "status" ||
//   msg.type === "agent_status" ||
//   msg.type === "agent_error"
// ) {
//   broadcastToViewers(sess, { type: "agent_event", ...msg });
//   return;
// }

//       if (msg.type === "propose_action") {
//         // forward proposed action to frontend viewers
//         broadcastToViewers(sess, { type: "agent_proposed_action", ...msg });

//         // If requires approval, store it and stop here
//         if (msg.requiresApproval) {
//           if (!sess.agent) sess.agent = { running: false, goal: "", model: "default", lastObsAt: 0 };
//           if (!sess.agent.pendingApprovals) sess.agent.pendingApprovals = new Map();
//           sess.agent.pendingApprovals.set(msg.stepId, msg.action);
//           broadcastToViewers(sess, {
//             type: "agent_action_needs_approval",
//             sessionId,
//             stepId: msg.stepId,
//           });
//           return;
// 		}
// 		  if (msg.action?.type === "ask_user") {
//     broadcastToViewers(sess, {
//       type: "agent_question",
//       sessionId,
//       stepId: msg.stepId,
//       question: msg.action.question || "",
//       ts: Date.now(),
//     });

//     // optional: tell worker you didn't execute anything
//     await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
//       method: "POST",
//       headers: { "content-type": "application/json" },
//       body: JSON.stringify({
//         sessionId,
//         stepId: msg.stepId,
//         ok: true,
//         note: "ask_user forwarded to viewer",
//         ts: Date.now(),
//       }),
//     }).catch(() => {});

//     return; // ✅ critical: don't fall through to executeAgentAction
//   }

//         // For MVP: execute immediately
//         try {
//           await executeAgentAction(sess, msg.action);

// 			broadcastToViewers(sess, {
//   type: "agent_executed_action",
//   sessionId,
//   stepId: msg.stepId,
//   action: msg.action,
//   ts: Date.now(),
// });

//           await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
//             method: "POST",
//             headers: { "content-type": "application/json" },
//             body: JSON.stringify({
//               sessionId,
//               stepId: msg.stepId,
//               ok: true,
//               ts: Date.now(),
//             }),
//           });
//         } catch (e) {
//           await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
//             method: "POST",
//             headers: { "content-type": "application/json" },
//             body: JSON.stringify({
//               sessionId,
//               stepId: msg.stepId,
//               ok: false,
//               error: String(e?.message || e),
//               ts: Date.now(),
//             }),
//           });
//         }
//       }
//     });

//     // Wait for open or error/close (whichever comes first)
//     await new Promise((resolve, reject) => {
//       const onOpen = () => {
//         ws.off("error", onError);
//         ws.off("close", onClose);
//         resolve();
//       };
//       const onError = (e) => {
//         ws.off("open", onOpen);
//         ws.off("close", onClose);
//         reject(e);
//       };
//       const onClose = () => {
//         ws.off("open", onOpen);
//         ws.off("error", onError);
//         reject(new Error("worker ws closed before open"));
//       };

//       ws.once("open", onOpen);
//       ws.once("error", onError);
//       ws.once("close", onClose);
//     });
//   })();

//   try {
//     await sess.workerConnecting;
//   } catch (e) {
//     sess.workerConnecting = null;
//     scheduleWorkerReconnect(sessionId);
//     throw e;
//   }
// }

// // -------------------- Session lifecycle --------------------
// async function closeSession(sessionId) {
//   const sess = sessions.get(sessionId);
//   if (!sess) return;

//   // stop streaming interval
//   try {
//     clearInterval(sess.interval);
//   } catch {}

//   // stop worker reconnect timer
//   try {
//     if (sess.workerReconnectTimer) clearTimeout(sess.workerReconnectTimer);
//   } catch {}

//   // close worker ws
//   try {
//     if (sess.workerWs && sess.workerWs.readyState === WebSocket.OPEN) sess.workerWs.close();
//   } catch {}

//   // close all client viewers
//   try {
//     for (const ws of sess.clients) {
//       try {
//         ws.close();
//       } catch {}
//     }
//   } catch {}

//   // close browser resources
//   try {
//     await sess.context?.close();
//   } catch {}
//   try {
//     await sess.browser?.close();
//   } catch {}

//   sessions.delete(sessionId);
// }

// // -------------------- Routes --------------------
// app.post("/sessions", async (req, res) => {
//   const sessionId = newId();
//   const startUrl = req.body?.url || "https://example.com";

//   try {
//     const browser = await chromium.launch({
//       headless: true,
//       args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
//     });

//     const viewport = { width: 1280, height: 720, deviceScaleFactor: 1 };

//     const context = await browser.newContext({
//       viewport: { width: viewport.width, height: viewport.height },
//       deviceScaleFactor: viewport.deviceScaleFactor,
//     });

//     const page = await context.newPage();
//     await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

//     const clients = new Set();

//     // Store session before interval starts (so interval can find it safely)
//     sessions.set(sessionId, {
//       browser,
//       context,
//       page,
//       viewport,
//       clients,
//       interval: null,
//       agent: null,
//       workerWs: null,
//       workerConnecting: null,
//       workerReconnectTimer: null,
//       workerBackoffMs: 500,
//     });

// 	  // AUTO-START AGENT (MVP)
// const AUTO_START_AGENT = process.env.AUTO_START_AGENT === "1";
// const AUTO_GOAL = process.env.AUTO_GOAL || "Explore the page and report what you find.";

// if (AUTO_START_AGENT) {
//   const sess = sessions.get(sessionId);
//   sess.agent = {
//     running: true,
//     goal: AUTO_GOAL,
//     model: "default",
//     lastObsAt: 0,
//     pendingApprovals: new Map(),
//   };

//   // best effort: connect worker ws
//   ensureWorkerStream(sessionId).catch(() => {});

//   // start worker session
//   fetchFn(`${WORKER_HTTP}/agent/start`, {
//     method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify({ sessionId, goal: AUTO_GOAL, model: "default" }),
//   }).catch(() => {});
// }

//     // Stream screenshots at ~2 fps
//     const interval = setInterval(async () => {
//       const sess = sessions.get(sessionId);
//       if (!sess) return;

//       // Agent observation tick (small payload)
//       try {
//         if (sess.agent?.running) {
//           const now = Date.now();
//           if (!sess.agent.lastObsAt || now - sess.agent.lastObsAt > AGENT_OBS_MIN_INTERVAL_MS) {
//             sess.agent.lastObsAt = now;
//             const elements = await extractClickableElements(page);

// 			  broadcastToViewers(sess, {
//   type: "agent_elements",
//   sessionId,
//   elements,
//   ts: now,
// });

//             fetchFn(`${WORKER_HTTP}/agent/observe`, {
//               method: "POST",
//               headers: { "content-type": "application/json" },
//               body: JSON.stringify({
//                 sessionId,
//                 obsId: `obs-${now}`,
//                 url: page.url(),
//                 viewport: sess.viewport,
//                 elements,
//                 ts: now,
//               }),
//             }).catch(() => {});
//           }
//         }
//       } catch {
//         // ignore observe errors
//       }

//       // Frame streaming tick
//       try {
//         const jpeg = await page.screenshot({ type: "jpeg", quality: 60 });
//         const img = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

//         const payload = JSON.stringify({
//           type: "frame",
//           sessionId,
//           img,
//           viewport: sess.viewport,
//           url: page.url(),
//           ts: Date.now(),
//         });

//         for (const ws of clients) {
//           if (ws.readyState === WebSocket.OPEN) ws.send(payload);
//         }
//       } catch {
//         // ignore streaming errors (page might be navigating/closing)
//       }
//     }, 500);

//     sessions.get(sessionId).interval = interval;

//     res.json({
//       sessionId,
//       wsPath: `/ws?sessionId=${sessionId}`,
//       url: startUrl,
//       viewport,
//     });
//   } catch (e) {
//     // Clean up partial session if something failed mid-creation
//     try {
//       await closeSession(sessionId);
//     } catch {}
//     res.status(500).json({ error: "failed_to_create_session", detail: String(e?.message || e) });
//   }
// });

// // Optional convenience endpoint (does not remove any existing behavior)
// app.delete("/sessions/:sessionId", requireAdmin, async (req, res) => {
//   const { sessionId } = req.params;
//   await closeSession(sessionId);
//   res.json({ ok: true });
// });

// // ---- Agent control ----
// app.post("/agent/start", requireAdmin, async (req, res) => {
//   const { sessionId, goal, model } = req.body || {};
//   if (!sessionId || !sessions.has(sessionId)) return res.status(400).json({ error: "bad sessionId" });
//   if (!goal) return res.status(400).json({ error: "missing goal" });

//   const sess = sessions.get(sessionId);

//   // ensure worker WS is up (best-effort; start still proceeds via HTTP)
//   try {
//     await ensureWorkerStream(sessionId);
//   } catch {
//     // worker may still be reachable by HTTP; don’t hard-fail here
//   }

//   // mark running
//   sess.agent = {
//     running: true,
//     goal,
//     model: model || "default",
//     lastObsAt: 0,
//     pendingApprovals: new Map(),
//   };

//   const r = await fetchFn(`${WORKER_HTTP}/agent/start`, {
//     method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify({ sessionId, goal, model: model || "default" }),
//   });

//   const text = await r.text();
//   if (!r.ok) return res.status(500).json({ error: "worker start failed", detail: text.slice(0, 200) });

//   res.json({ ok: true });
// });

// app.post("/agent/correction", requireAdmin, async (req, res) => {
//   const { sessionId, text, mode } = req.body || {};
//   if (!sessionId || !sessions.has(sessionId)) return res.status(400).json({ error: "bad sessionId" });
//   if (!text) return res.status(400).json({ error: "missing text" });

//   const r = await fetchFn(`${WORKER_HTTP}/agent/correction`, {
//     method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify({ sessionId, text, mode: mode || "override" }),
//   });

//   const out = await r.text();
//   if (!r.ok) return res.status(500).json({ error: "worker correction failed", detail: out.slice(0, 200) });

//   res.json({ ok: true });
// });

// // INTERNAL: proxy observe manually (admin only)
// app.post("/agent/observe", requireAdmin, async (req, res) => {
//   const { sessionId, obs } = req.body || {};
//   if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

//   const r = await fetchFn(`${WORKER_HTTP}/agent/observe`, {
//     method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify({ sessionId, ...(obs || {}) }),
//   });

//   const out = await r.text();
//   if (!r.ok) return res.status(500).json({ error: "worker observe failed", detail: out.slice(0, 200) });

//   res.json({ ok: true });
// });

// // Optional: approve a pending action that required approval
// app.post("/agent/approve", requireAdmin, async (req, res) => {
//   const { sessionId, stepId } = req.body || {};
//   const sess = sessions.get(sessionId);
//   if (!sess) return res.status(400).json({ error: "bad sessionId" });
//   if (!stepId) return res.status(400).json({ error: "missing stepId" });

//   const action = sess.agent?.pendingApprovals?.get(stepId);
//   if (!action) return res.status(404).json({ error: "no_pending_action" });

//   sess.agent.pendingApprovals.delete(stepId);

//   try {
//     await executeAgentAction(sess, action);
//     await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
//       method: "POST",
//       headers: { "content-type": "application/json" },
//       body: JSON.stringify({ sessionId, stepId, ok: true, ts: Date.now() }),
//     });
//     res.json({ ok: true });
//   } catch (e) {
//     await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
//       method: "POST",
//       headers: { "content-type": "application/json" },
//       body: JSON.stringify({
//         sessionId,
//         stepId,
//         ok: false,
//         error: String(e?.message || e),
//         ts: Date.now(),
//       }),
//     });
//     res.status(500).json({ error: "action_failed", detail: String(e?.message || e) });
//   }
// });

// // Optional: stop agent locally (doesn't assume worker has /stop; just stops observations)
// app.post("/agent/stop", requireAdmin, async (req, res) => {
//   const { sessionId } = req.body || {};
//   const sess = sessions.get(sessionId);
//   if (!sess) return res.status(400).json({ error: "bad sessionId" });
//   if (sess.agent) sess.agent.running = false;
//   res.json({ ok: true });
// });

// // -------------------- HTTP server + WS viewer stream --------------------
// const server = http.createServer(app);
// const wss = new WebSocketServer({ server, path: "/ws" });

// // Lightweight WS admin auth (for agent_start / agent_correction over WS)
// function isWsAdmin(msg) {
//   const token = msg?.adminToken || "";
//   return token && token === ADMIN_TOKEN;
// }

// wss.on("connection", async (ws, req) => {
//   const url = new URL(req.url, "http://localhost");
//   const sessionId = url.searchParams.get("sessionId");

//   if (!sessionId || !sessions.has(sessionId)) {
//     ws.send(JSON.stringify({ type: "error", message: "Invalid sessionId" }));
//     ws.close();
//     return;
//   }

//   const sess = sessions.get(sessionId);
//   sess.clients.add(ws);

//   ws.send(JSON.stringify({ type: "hello", sessionId, message: "Connected. Streaming frames." }));

//   ws.on("message", async (data) => {
//     let msg;
//     try {
//       msg = JSON.parse(data.toString());
//     } catch {
//       return;
//     }

//     try {
//       if (msg.type === "user_click") {
//         const { x, y, button } = msg;
//         await sess.page.mouse.click(x, y, { button: button || "left" });
//         ws.send(JSON.stringify({ type: "ack", action: "user_click", x, y }));
//       } else if (msg.type === "user_type") {
//         await sess.page.keyboard.type(msg.text || "");
//         ws.send(JSON.stringify({ type: "ack", action: "user_type" }));
//       } else if (msg.type === "goto") {
//         await sess.page.goto(msg.url, { waitUntil: "domcontentloaded", timeout: 60000 });
//         ws.send(JSON.stringify({ type: "ack", action: "goto", url: msg.url }));
//       } else if (msg.type === "close_session") {
//         await closeSession(sessionId);
//       } else if (msg.type === "agent_start") {
//         // Allow starting agent via WS, but require admin token in message
//         if (!isWsAdmin(msg)) {
//           ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
//           return;
//         }

//         const goal = msg.goal;
//         const model = msg.model || "default";
//         if (!goal) {
//           ws.send(JSON.stringify({ type: "error", message: "missing goal" }));
//           return;
//         }

//         try {
//           await ensureWorkerStream(sessionId);
//         } catch {
//           // best-effort
//         }

//         sess.agent = {
//           running: true,
//           goal,
//           model,
//           lastObsAt: 0,
//           pendingApprovals: new Map(),
//         };

//         const r = await fetchFn(`${WORKER_HTTP}/agent/start`, {
//           method: "POST",
//           headers: { "content-type": "application/json" },
//           body: JSON.stringify({ sessionId, goal, model }),
//         });

//         const text = await r.text();
//         if (!r.ok) {
//           ws.send(JSON.stringify({ type: "error", message: "worker start failed", detail: text.slice(0, 200) }));
//           return;
//         }

//         ws.send(JSON.stringify({ type: "ack", action: "agent_start" }));
//       } else if (msg.type === "agent_correction") {
//         if (!isWsAdmin(msg)) {
//           ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
//           return;
//         }

//         const text = msg.text;
//         const mode = msg.mode || "override";
//         if (!text) {
//           ws.send(JSON.stringify({ type: "error", message: "missing text" }));
//           return;
//         }

//         const r = await fetchFn(`${WORKER_HTTP}/agent/correction`, {
//           method: "POST",
//           headers: { "content-type": "application/json" },
//           body: JSON.stringify({ sessionId, text, mode }),
//         });

//         const out = await r.text();
//         if (!r.ok) {
//           ws.send(JSON.stringify({ type: "error", message: "worker correction failed", detail: out.slice(0, 200) }));
//           return;
//         }

//         ws.send(JSON.stringify({ type: "ack", action: "agent_correction" }));
//       } else if (msg.type === "agent_approve") {
//         if (!isWsAdmin(msg)) {
//           ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
//           return;
//         }
//         const stepId = msg.stepId;
//         if (!stepId) {
//           ws.send(JSON.stringify({ type: "error", message: "missing stepId" }));
//           return;
//         }

//         const action = sess.agent?.pendingApprovals?.get(stepId);
//         if (!action) {
//           ws.send(JSON.stringify({ type: "error", message: "no_pending_action" }));
//           return;
//         }

//         sess.agent.pendingApprovals.delete(stepId);

//         try {
//           await executeAgentAction(sess, action);
//           await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
//             method: "POST",
//             headers: { "content-type": "application/json" },
//             body: JSON.stringify({ sessionId, stepId, ok: true, ts: Date.now() }),
//           });
//           ws.send(JSON.stringify({ type: "ack", action: "agent_approve", stepId }));
//         } catch (e) {
//           await fetchFn(`${WORKER_HTTP}/agent/action_result`, {
//             method: "POST",
//             headers: { "content-type": "application/json" },
//             body: JSON.stringify({
//               sessionId,
//               stepId,
//               ok: false,
//               error: String(e?.message || e),
//               ts: Date.now(),
//             }),
//           });
//           ws.send(JSON.stringify({ type: "error", message: "action_failed", detail: String(e?.message || e) }));
//         }
//       }
//     } catch (e) {
//       ws.send(JSON.stringify({ type: "error", message: String(e?.message || e) }));
//     }
//   });

//   ws.on("close", async () => {
//     sess.clients.delete(ws);
//     // Optional: if nobody watching, you could auto-close after N mins.
//   });
// });

// // -------------------- Start --------------------
// const PORT = process.env.PORT || 3000;
// server.listen(PORT, "0.0.0.0", () => {
//   console.log(`Backend listening on 0.0.0.0:${PORT}`);
//   console.log(`Admin token (server): ${ADMIN_TOKEN}`);
// });
