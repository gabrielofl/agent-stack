// src/services/debugLog.js
import {
  DEBUG,
  DEBUG_AGENT,
  DEBUG_LLM,
  DEBUG_LLM_BODY,
  DEBUG_LLM_PROMPT,
  DEBUG_TRUNC,
  DEBUG_SESSIONS,
} from "../config/env.js";

function ts() {
  return new Date().toISOString();
}

// Comma-separated sessionIds or "*" for all
const SESSIONS_RAW = String(DEBUG_SESSIONS || "").trim();
const DEBUG_ALL = SESSIONS_RAW === "*";

const DEBUG_SET = new Set(
  SESSIONS_RAW && !DEBUG_ALL
    ? SESSIONS_RAW.split(",").map((s) => s.trim()).filter(Boolean)
    : []
);

export const DBG = {
  enabled: Boolean(DEBUG || DEBUG_AGENT || DEBUG_LLM),
  agent: Boolean(DEBUG || DEBUG_AGENT),
  llm: Boolean(DEBUG || DEBUG_LLM),
  llmBody: Boolean(DEBUG_LLM_BODY),     // logs request body snippets
  llmPrompt: Boolean(DEBUG_LLM_PROMPT), // logs prompt text snippets
  trunc: Number(DEBUG_TRUNC || 900),
  sessions: DEBUG_SET,
  allSessions: DEBUG_ALL,
};

export function shouldLog(sessionId) {
  if (!DBG.enabled) return false;
  if (DBG.allSessions) return true;
  if (!sessionId) return true; // allow global logs
  return DBG.sessions.has(String(sessionId));
}

export function dlog(sessionId, label, obj) {
  if (!shouldLog(sessionId)) return;
  const base = `[${ts()}] [${label}]${sessionId ? ` [sid=${sessionId}]` : ""}`;

  if (obj === undefined) {
    console.log(base);
    return;
  }

  try {
    console.log(base, typeof obj === "string" ? obj : JSON.stringify(obj));
  } catch {
    console.log(base, String(obj));
  }
}

export function dlogBig(sessionId, label, text) {
  if (!shouldLog(sessionId)) return;
  const t = String(text ?? "");
  const n = DBG.trunc;
  const out = t.length > n ? `${t.slice(0, n)}…(trunc ${t.length} chars)` : t;
  console.log(`[${ts()}] [${label}]${sessionId ? ` [sid=${sessionId}]` : ""} ${out}`);
}
