// backend/src/services/frontendBroadcast.js
import { sessions } from "./sessionStore.js";

export function broadcastToSession(sessionId, msg) {
  const sess = sessions.get(sessionId);
  if (!sess?.clients) return 0;

  const payload = JSON.stringify(msg);
  let n = 0;

  for (const ws of sess.clients) {
    try {
      if (ws?.readyState === 1) {
        ws.send(payload);
        n++;
      }
    } catch {}
  }

  return n;
}
