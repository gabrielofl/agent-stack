// src/services/streamHub.js
// Improvements:
// - Correct env parsing for dedupe skip types
// - More predictable dedupe key + per-type TTL
// - Rate-limit drops low-value spam first
// - Cleanup dead sockets automatically
// - Optional caps on viewers per session

export const streams = new Map(); // sessionId -> Set<ws>

// ---- tunables (env overridable) ----
const DEDUPE_WINDOW_MS = Number(process.env.STREAM_DEDUPE_WINDOW_MS || 8000);

// Messages per window per session.
// When exceeded, we drop low-priority messages first.
const RATE_LIMIT_MAX = Number(process.env.STREAM_RATE_LIMIT_MAX || 40);
const RATE_LIMIT_WINDOW_MS = Number(process.env.STREAM_RATE_LIMIT_WINDOW_MS || 5000);
const MAX_CLIENTS_PER_SESSION = Number(process.env.STREAM_MAX_CLIENTS_PER_SESSION || 25);

// Default: skip dedupe for these types (comma-separated)
const DEDUPE_SKIP_TYPES = new Set(
  String(process.env.STREAM_DEDUPE_SKIP_TYPES || "agent_proposed_action,llm_status")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// Prefer dropping these types when rate-limited
const LOW_PRIORITY_TYPES = new Set(
  String(process.env.STREAM_LOW_PRIORITY_TYPES || "agent_event,frame")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// sessionId -> { lastKeyByType: Map<string,string>, lastAtByType: Map<string,number>, rlCount, rlWindowStart }
const sessionState = new Map();

function now() {
  return Date.now();
}

function getState(sessionId) {
  let st = sessionState.get(sessionId);
  if (!st) {
    st = {
      lastKeyByType: new Map(),
      lastAtByType: new Map(),
      rlCount: 0,
      rlWindowStart: 0,
    };
    sessionState.set(sessionId, st);
  }
  return st;
}

function makeDedupeKey(msg) {
  try {
    const t = msg?.type || "";
    const sessionId = msg?.sessionId || "";
    const status = msg?.status || "";
    const message = msg?.message || "";
    const stepId = msg?.stepId || "";
    const aType = msg?.action?.type || "";
    const question =
      msg?.question || msg?.action?.question || msg?.action?.text || "";

    // keep stable, short-ish
    return `${t}|${sessionId}|${status}|${stepId}|${aType}|${message}|${question}`;
  } catch {
    return String(msg?.type || "unknown");
  }
}

function resetRateWindowIfNeeded(st) {
  const t = now();
  if (!st.rlWindowStart || t - st.rlWindowStart > RATE_LIMIT_WINDOW_MS) {
    st.rlWindowStart = t;
    st.rlCount = 0;
  }
}

function shouldDropByRateLimit(st, type) {
  resetRateWindowIfNeeded(st);
  st.rlCount++;

  if (st.rlCount <= RATE_LIMIT_MAX) return false;

  // When over limit: drop low-priority types first
  if (LOW_PRIORITY_TYPES.has(type)) return true;

  // If it's high priority, still allow a few extra before dropping
  // (prevents losing proposed_action/action_result messages)
  const hardCap = RATE_LIMIT_MAX + 15;
  return st.rlCount > hardCap;
}

function isWsOpen(ws) {
  // ws.readyState: 1 = OPEN
  return ws?.readyState === 1;
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

  // Optional cap
  if (set.size >= MAX_CLIENTS_PER_SESSION) {
    try {
      ws.close?.(1013, "too many viewers"); // try again later
    } catch {}
    return;
  }

  set.add(ws);

  // Best-effort cleanup on close/error
  try {
    ws.on?.("close", () => removeStream(sessionId, ws));
    ws.on?.("error", () => removeStream(sessionId, ws));
  } catch {}
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
  const type = String(msg?.type || "agent_event");
  const t = now();

  // Rate limit
  if (shouldDropByRateLimit(st, type)) return;

  // Dedupe per message type within a time window
  if (!DEDUPE_SKIP_TYPES.has(type)) {
    const key = makeDedupeKey(msg);
    const lastKey = st.lastKeyByType.get(type) || "";
    const lastAt = st.lastAtByType.get(type) || 0;

    if (key && key === lastKey && t - lastAt < DEDUPE_WINDOW_MS) {
      return;
    }

    st.lastKeyByType.set(type, key);
    st.lastAtByType.set(type, t);
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
