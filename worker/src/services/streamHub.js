// src/services/streamHub.js
export const streams = new Map(); // sessionId -> Set<ws>

export function addStream(sessionId, ws) {
  let set = streams.get(sessionId);
  if (!set) {
    set = new Set();
    streams.set(sessionId, set);
  }
  set.add(ws);
}

export function removeStream(sessionId, ws) {
  const set = streams.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) streams.delete(sessionId);
}

export function push(sessionId, msg) {
  const set = streams.get(sessionId);
  if (!set) return;

  const payload = JSON.stringify(msg);
  for (const ws of set) {
    // readyState 1 = OPEN
    if (ws.readyState === 1) {
      try {
        ws.send(payload);
      } catch {
        // ignore per-client send errors
      }
    }
  }
}
