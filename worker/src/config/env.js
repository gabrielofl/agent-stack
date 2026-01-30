// src/config/env.js
export const PORT = process.env.PORT || 4000;
export const HOST = "0.0.0.0";

export const LLAMA_BASE_URL = process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080";

/**
 * Global default timeout (ms) for LLM requests if caller does not override.
 * Keep your old default, but now we support per-call overrides in llamaClient.
 */
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90000);

// Guardrails
export const MAX_ELEMENTS = Number(process.env.MAX_ELEMENTS || 40);
export const MAX_TEXT_LEN = Number(process.env.MAX_TEXT_LEN || 800);

// New (optional) guardrails / knobs
export const LLM_FAST_TIMEOUT_MS = Number(process.env.LLM_FAST_TIMEOUT_MS || 25000);
export const LLM_REPAIR_TIMEOUT_MS = Number(process.env.LLM_REPAIR_TIMEOUT_MS || 15000);
export const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 320);
export const LLM_REPAIR_MAX_TOKENS = Number(process.env.LLM_REPAIR_MAX_TOKENS || 220);

// Optional: if you want to garbage-collect sessions
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);

/**
 * Agent "simple prompt" mode (single action, fewer tokens).
 *
 * These are consumed by AgentSession (either directly from process.env
 * or you can import & use them there—your choice).
 *
 * Suggested defaults for tiny CPU boxes:
 * - max tokens: 60–100
 * - timeout: 8–15s
 * - elements: 8–15
 */
export const AGENT_SIMPLE_PROMPT = 1;
// interpret truthy in AgentSession, but export raw string too if you need
export const AGENT_SIMPLE_MAX_TOKENS = Number(process.env.AGENT_SIMPLE_MAX_TOKENS || 80);
export const AGENT_SIMPLE_TIMEOUT_MS = Number(process.env.AGENT_SIMPLE_TIMEOUT_MS || 25000);
export const AGENT_SIMPLE_MAX_ELEMENTS = Number(process.env.AGENT_SIMPLE_MAX_ELEMENTS || 12);
