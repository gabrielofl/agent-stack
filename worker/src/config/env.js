// src/config/env.js

function truthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Treat anything non-production as "local/dev" for default knobs
// const IS_PROD = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
const IS_PROD = false;

// --------------------
// Core server config
// --------------------
export const PORT = process.env.PORT || 4000;
export const HOST = "0.0.0.0";

// --------------------
// LLM / llama config
// --------------------
export const LLAMA_BASE_URL = process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080";

/**
 * Global default timeout (ms) for LLM requests if caller does not override.
 */
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90000);

// Guardrails
export const MAX_ELEMENTS = Number(process.env.MAX_ELEMENTS || 40);
export const MAX_TEXT_LEN = Number(process.env.MAX_TEXT_LEN || 800);

// --------------------
// LLM knobs
// --------------------

// Primary “fast” timeout: bump to 30 seconds by default
export const LLM_FAST_TIMEOUT_MS = Number(process.env.LLM_FAST_TIMEOUT_MS || 90000);

// Repair timeout: bump to 30 seconds by default (Fix for your log)
export const LLM_REPAIR_TIMEOUT_MS = Number(process.env.LLM_REPAIR_TIMEOUT_MS || 90000);

export const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 320);
export const LLM_REPAIR_MAX_TOKENS = Number(process.env.LLM_REPAIR_MAX_TOKENS || 220);

// Optional: if you want to garbage-collect sessions
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);

// --------------------
// Agent prompt mode (single flag + optional overrides)
// --------------------
// AGENT_PROMPT_MODE: "default" | "simple" | "constrained"
// export const AGENT_PROMPT_MODE = String(
//   process.env.AGENT_PROMPT_MODE ?? (IS_PROD ? "default" : "simple")
// )
//   .trim()
//   .toLowerCase();
export const AGENT_PROMPT_MODE = "constrained";
// Optional mode overrides
export const AGENT_PROMPT_MAX_TOKENS = Number(process.env.AGENT_PROMPT_MAX_TOKENS || 0);
export const AGENT_PROMPT_TIMEOUT_MS = Number(process.env.AGENT_PROMPT_TIMEOUT_MS || 0);
export const AGENT_PROMPT_MAX_ELEMENTS = Number(process.env.AGENT_PROMPT_MAX_ELEMENTS || 0);

// --------------------
// Debug knobs (local defaults)
// --------------------
const DEFAULT_DEBUG_ON = IS_PROD ? "0" : "1";

// Master switches
export const DEBUG = truthy(process.env.DEBUG ?? DEFAULT_DEBUG_ON);
export const DEBUG_AGENT = truthy(process.env.DEBUG_AGENT ?? DEFAULT_DEBUG_ON);
export const DEBUG_LLM = truthy(process.env.DEBUG_LLM ?? DEFAULT_DEBUG_ON);

// Verbose (these can get huge; default ON in dev, OFF in prod)
export const DEBUG_LLM_BODY = truthy(process.env.DEBUG_LLM_BODY ?? (IS_PROD ? "0" : "1"));
export const DEBUG_LLM_PROMPT = truthy(process.env.DEBUG_LLM_PROMPT ?? (IS_PROD ? "0" : "1"));

// "*" logs all sessions by default in dev; none by default in prod
export const DEBUG_SESSIONS = String(process.env.DEBUG_SESSIONS ?? (IS_PROD ? "" : "*")).trim();

// Bigger truncation for dev logs; smaller in prod
export const DEBUG_TRUNC = Number(process.env.DEBUG_TRUNC ?? (IS_PROD ? 900 : 2500));

// --------------------
// Other tunables
// --------------------
export const OBS_DECISION_MIN_INTERVAL_MS = Number(process.env.OBS_DECISION_MIN_INTERVAL_MS || 1200);

export const STREAM_DEDUPE_WINDOW_MS = Number(process.env.STREAM_DEDUPE_WINDOW_MS || 8000);
export const STREAM_RATE_LIMIT_MAX = Number(process.env.STREAM_RATE_LIMIT_MAX || 40);
export const STREAM_RATE_LIMIT_WINDOW_MS = Number(process.env.STREAM_RATE_LIMIT_WINDOW_MS || 5000);
export const STREAM_MAX_CLIENTS_PER_SESSION = Number(process.env.STREAM_MAX_CLIENTS_PER_SESSION || 25);
export const STREAM_DEDUPE_SKIP_TYPES = String(
  process.env.STREAM_DEDUPE_SKIP_TYPES || "agent_proposed_action" || "llm_status"
);
