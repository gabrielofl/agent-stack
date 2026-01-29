// src/services/sessionStore.js (ESM)
import crypto from "crypto";

// -------------------- In-memory Sessions (MVP) --------------------
// sessionId -> {
//   browser, context, page, viewport,
//   clients:Set<WebSocket>, interval,
//   agent: { running, goal, model, lastObsAt, pendingApprovals: Map(stepId->action) },
//   workerWs, workerConnecting: Promise<void> | null,
//   workerReconnectTimer, workerBackoffMs
// }
export const sessions = new Map();

export function newId() {
  // more collision-resistant than Math.random
  return `${crypto.randomBytes(6).toString("hex")}-${Date.now().toString(36)}`;
}
