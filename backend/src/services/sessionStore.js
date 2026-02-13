// src/services/sessionStore.js (ESM)
import crypto from "crypto";

// sessionId -> {
//   browser, context, page, viewport,
//   clients:Set<WebSocket>,
//   interval, _frameInterval,
//
//   agent: { running, goal, model, lastObsAt, pendingApprovals: Map(stepId->action) },
//
//   workerWs, workerConnecting, workerReconnectTimer, workerBackoffMs,
//
//   // observe pacing / caching (set by sessionLifecycle)
//   _observeInflight, _observeCooldownUntil, _observeBackoffMs,
//   _lastElementsAt, _cachedElements, _cachedElementsHash,
//
//   // action backpressure (set by workerStream/viewerWs)
//   _actionQueue: Promise
// }
export const sessions = new Map();

export function newId() {
  return `${crypto.randomBytes(6).toString("hex")}-${Date.now().toString(36)}`;
}
