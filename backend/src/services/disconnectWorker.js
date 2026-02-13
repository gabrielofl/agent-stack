// src/services/disconnectWorker.js (ESM)
import WebSocket from "ws";
import { sessions } from "./sessionStore.js";

export function disconnectWorker(sessionId, { disableReconnect = true } = {}) {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  if (disableReconnect) {
    sess.workerReconnectDisabled = true;
    if (sess.workerReconnectTimer) {
      clearTimeout(sess.workerReconnectTimer);
      sess.workerReconnectTimer = null;
    }
  }

  try {
    if (sess.workerWs && sess.workerWs.readyState !== WebSocket.CLOSED) {
      // terminate is more immediate than close
      sess.workerWs.terminate?.();
      sess.workerWs.close?.();
    }
  } catch {}

  sess.workerWs = null;
  sess.workerConnecting = null;
}
