// src/config/env.js
export const PORT = process.env.PORT || 4000;
export const HOST = "0.0.0.0";

export const LLAMA_BASE_URL =
  process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080";

export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 15000);

// Guardrails
export const MAX_ELEMENTS = Number(process.env.MAX_ELEMENTS || 40);
export const MAX_TEXT_LEN = Number(process.env.MAX_TEXT_LEN || 800);

// Optional: if you want to garbage-collect sessions
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);
