// src/services/llm/llamaClient.js
import { fetchFn } from "../fetch.js";
import {
  LLAMA_BASE_URL,
  LLM_TIMEOUT_MS,
  LLM_MAX_TOKENS,
  LLM_FAST_TIMEOUT_MS,
} from "../../config/env.js";

/**
 * chatCompletion
 * - Adds per-call timeout override (timeoutMs)
 * - Adds per-call maxTokens (maxTokens)
 * - Forces JSON-only output via system prompt
 */
export async function chatCompletion({
  prompt,
  temperature = 0.0,
  maxTokens = LLM_MAX_TOKENS,
  timeoutMs = LLM_FAST_TIMEOUT_MS || LLM_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Number(timeoutMs || LLM_TIMEOUT_MS));

  try {
    const r = await fetchFn(`${LLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "local",
        temperature,
        max_tokens: Math.max(8, Math.min(2048, Number(maxTokens || 320))),
        messages: [
          {
            role: "system",
            content:
              "You are a precise browser automation agent. Output ONLY JSON. No markdown. No commentary. No extra keys.",
          },
          { role: "user", content: String(prompt || "").slice(0, 20_000) },
        ],
      }),
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`llama-server ${r.status}: ${text.slice(0, 200)}`);

    const json = JSON.parse(text);
    return json?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    if (String(e?.name) === "AbortError") {
      throw new Error(`llama-server timeout after ${Number(timeoutMs || LLM_TIMEOUT_MS)}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}
