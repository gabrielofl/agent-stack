// src/index.js
import { PORT, HOST } from "./config/env.js";
import { createServer } from "./server.js";

createServer({ port: PORT, host: HOST });

// import express from "express";
// import { WebSocketServer } from "ws";
// import { AgentSession } from "./agent.js";

// const app = express();
// app.use(express.json({ limit: "2mb" }));

// app.get("/health", (req, res) => res.json({ ok: true }));

// const sessions = new Map(); // sessionId -> AgentSession
// const streams = new Map();  // sessionId -> Set<ws>

// function push(sessionId, msg) {
//   const set = streams.get(sessionId);
//   if (!set) return;
//   const payload = JSON.stringify(msg);
//   for (const ws of set) {
//     if (ws.readyState === 1) ws.send(payload);
//   }
// }

// app.post("/agent/start", (req, res) => {
//   const { sessionId, goal, model } = req.body || {};
//   if (!sessionId || !goal) return res.status(400).json({ error: "missing sessionId/goal" });

//   sessions.set(sessionId, new AgentSession({ sessionId, goal, model }));
//   res.json({ ok: true });
// });

// app.post("/agent/observe", async (req, res) => {
//   const { sessionId, obsId, url, viewport, elements, ts } = req.body || {};
//   const sess = sessions.get(sessionId);
//   if (!sess) return res.status(404).json({ error: "no agent session (call /agent/start)" });

//   sess.setObservation({ obsId, url, viewport, elements, ts });

// 	try {
// 	push(sessionId, { type: "agent_status", sessionId, status: "observed", obsId, ts: Date.now() });

//     const decision = await sess.decideNextAction();
//     const stepId = `step-${++sess.step}`;

//     push(sessionId, {
//       type: "propose_action",
//       sessionId,
//       stepId,
//       requiresApproval: !!decision.requiresApproval,
//       action: decision.action,
//       explanation: decision.explanation || ""
//     });

//     res.json({ ok: true });
//   } catch (e) {
//     push(sessionId, { type: "agent_error", sessionId, error: String(e?.message || e) });
//     res.status(500).json({ error: "decide failed", detail: String(e?.message || e) });
//   }
// });

// app.post("/agent/correction", (req, res) => {
//   const { sessionId, text, mode } = req.body || {};
//   const sess = sessions.get(sessionId);
//   if (!sess) return res.status(404).json({ error: "no agent session" });

//   sess.addCorrection({ text, mode: mode || "override", ts: Date.now() });
//   res.json({ ok: true });
// });

// app.post("/agent/action_result", (req, res) => {
//   res.json({ ok: true });
// });

// // Listen
// const PORT = process.env.PORT || 4000;
// const server = app.listen(PORT, "0.0.0.0", () => {
//   console.log(`worker-agent listening on 0.0.0.0:${PORT}`);
// });

// const wss = new WebSocketServer({ server, path: "/agent-stream" });
// wss.on("connection", (ws, req) => {
//   const url = new URL(req.url, "http://localhost");
//   const sessionId = url.searchParams.get("sessionId") || "";

//   if (!sessionId) {
//     ws.close();
//     return;
//   }

//   let set = streams.get(sessionId);
//   if (!set) { set = new Set(); streams.set(sessionId, set); }
//   set.add(ws);

//   ws.on("close", () => {
//     set.delete(ws);
//     if (set.size === 0) streams.delete(sessionId);
//   });
// });
