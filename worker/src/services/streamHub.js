// src/services/streamHub.js
// Improvements:
// - Deduplicate identical payloads per session for a short TTL
// - Rate-limit pushes per session to avoid event storms and memory/CPU spikes
// - Cleanup dead sockets automatically on send failure
// - Optional caps on viewers per session
//
// This is intentionally simple (no async queues) so it can't "pile up" memory.

export const streams = new Map(); // sessionId -> Set<ws>

// ---- tunables (env overridable) ----
const DEDUPE_WINDOW_MS = Number(process.env.STREAM_DEDUPE_WINDOW_MS || 8000);
const RATE_LIMIT_MAX = Number(process.env.STREAM_RATE_LIMIT_MAX || 40); // messages
const RATE_LIMIT_WINDOW_MS = Number(process.env.STREAM_RATE_LIMIT_WINDOW_MS || 5000); // per session
const MAX_CLIENTS_PER_SESSION = Number(process.env.STREAM_MAX_CLIENTS_PER_SESSION || 25);

// Optional: skip dedupe for these message types
const DEDUPE_SKIP_TYPES = new Set(
  String(process.env.STREAM_DEDUPE_SKIP_TYPES || "agent_proposed_action" || "llm_status")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// sessionId -> { lastKey, lastAt, rlCount, rlWindowStart }
const sessionState = new Map();

function now() {
  return Date.now();
}

function getState(sessionId) {
  let st = sessionState.get(sessionId);
  if (!st) {
    st = { lastKey: "", lastAt: 0, rlCount: 0, rlWindowStart: 0 };
    sessionState.set(sessionId, st);
  }
  return st;
}

function makeDedupeKey(msg) {
  try {
    // stable-ish key: type + status + message + stepId + action.type + ask_user question
    const t = msg?.type || "";
    const status = msg?.status || "";
    const message = msg?.message || "";
    const stepId = msg?.stepId || "";
    const aType = msg?.action?.type || "";
    const question = msg?.action?.question || "";
    return `${t}|${status}|${stepId}|${aType}|${message}|${question}`;
  } catch {
    return String(msg?.type || "unknown");
  }
}

function shouldDropByRateLimit(st) {
  const t = now();
  if (!st.rlWindowStart || t - st.rlWindowStart > RATE_LIMIT_WINDOW_MS) {
    st.rlWindowStart = t;
    st.rlCount = 0;
  }
  st.rlCount++;
  return st.rlCount > RATE_LIMIT_MAX;
}

function isWsOpen(ws) {
  // ws (popular libs): readyState 1 = OPEN
  // some libs expose WebSocket.OPEN (1)
  const rs = ws?.readyState;
  if (typeof rs !== "number") return true; // best-effort
  return rs === 1;
}

function cleanupIfEmpty(sessionId) {
  const set = streams.get(sessionId);
  if (!set || set.size === 0) {
    streams.delete(sessionId);
    sessionState.delete(sessionId);
  }
}

export function addStream(sessionId, ws) {
  let set = streams.get(sessionId);
  if (!set) {
    set = new Set();
    streams.set(sessionId, set);
  }

  // Optional cap: drop extra viewers to prevent unbounded memory usage
  if (set.size >= MAX_CLIENTS_PER_SESSION) {
    try {
      ws.close?.();
    } catch {}
    return;
  }

  set.add(ws);

  // Best-effort cleanup on close/error (if your ws lib emits these)
  try {
    ws.on?.("close", () => removeStream(sessionId, ws));
    ws.on?.("error", () => removeStream(sessionId, ws));
  } catch {
    // ignore if ws.on is not available
  }
}

export function removeStream(sessionId, ws) {
  const set = streams.get(sessionId);
  if (!set) return;

  set.delete(ws);
  cleanupIfEmpty(sessionId);
}

export function push(sessionId, msg) {
  const set = streams.get(sessionId);
  if (!set || set.size === 0) return;

  const st = getState(sessionId);

  // Rate-limit: drop if session is spamming
  if (shouldDropByRateLimit(st)) return;

  // Dedupe identical event payloads within a time window
  const type = msg?.type || "";
  const t = now();

  if (!DEDUPE_SKIP_TYPES.has(type)) {
    const key = makeDedupeKey(msg);
    if (key && key === st.lastKey && t - st.lastAt < DEDUPE_WINDOW_MS) {
      return;
    }
    st.lastKey = key;
    st.lastAt = t;
  }

  // stringify once
  let payload;
  try {
    payload = JSON.stringify(msg);
  } catch {
    payload = JSON.stringify({
      type: "agent_event",
      sessionId,
      status: "error",
      message: "streamHub: failed to serialize message",
      ts: t,
    });
  }

  // Send to all open sockets; remove dead ones
  for (const ws of set) {
    if (!ws) continue;

    if (!isWsOpen(ws)) {
      set.delete(ws);
      continue;
    }

    try {
      ws.send(payload);
    } catch {
      set.delete(ws);
    }
  }

  cleanupIfEmpty(sessionId);
}
