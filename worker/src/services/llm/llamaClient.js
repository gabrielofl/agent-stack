// src/services/llm/llamaClient.js
import { fetchFn } from "../fetch.js";
import {
  LLAMA_BASE_URL,
  LLM_TIMEOUT_MS,
  LLM_MAX_TOKENS,
  LLM_FAST_TIMEOUT_MS,
} from "../../config/env.js";
import { DBG, dlog, dlogBig } from "../debugLog.js";

function baseNow() {
  return globalThis.performance?.now ? performance.now() : Date.now();
}

function msSince(t0) {
  const t1 = globalThis.performance?.now ? performance.now() : Date.now();
  return Math.round(t1 - t0);
}

// Quick/rough token estimate (not exact, good for debugging)
function approxTokens(s) {
  const t = String(s ?? "");
  // English-ish heuristic: ~4 chars/token
  return Math.ceil(t.length / 4);
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function safeSlice(s, n) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n)}…(trunc ${str.length} chars)` : str;
}

/**
 * chatCompletion
 * - per-call timeout override (timeoutMs)
 * - per-call maxTokens (maxTokens)
 * - logs request/response in verbose debug mode
 *
 * meta: { sessionId, obsId, stepId, mode }
 */
export async function chatCompletion({
  prompt,
  temperature = 0.0,
  maxTokens = LLM_MAX_TOKENS,
  timeoutMs = LLM_FAST_TIMEOUT_MS || LLM_TIMEOUT_MS,
  meta = {},
}) {
  const sessionId = meta?.sessionId;

  const timeout = Number(timeoutMs || LLM_TIMEOUT_MS);
  const userPrompt = String(prompt || "").slice(0, 20_000);

  const body = {
    model: "local",
    temperature,
    max_tokens: Math.max(8, Math.min(2048, Number(maxTokens || 320))),
    messages: [
      {
        role: "system",
        content:
          "You are a precise browser automation agent. Output exactly one line. No markdown. No commentary. No extra keys.",
      },
      { role: "user", content: userPrompt },
    ],
  };

  const url = `${LLAMA_BASE_URL}/v1/chat/completions`;

  const controller = new AbortController();
  const t0 = baseNow();
  const timer = setTimeout(() => controller.abort(), timeout);

  if (DBG.llm) {
    dlog(sessionId, "LLM_CALL_BEGIN", {
      url,
      timeoutMs: timeout,
      maxTokens: body.max_tokens,
      temperature,
      meta,
      promptChars: userPrompt.length,
      approxPromptTokens: approxTokens(userPrompt),
    });

    // Only dump big stuff if explicitly enabled
    if (DBG.llmBody) dlogBig(sessionId, "LLM_REQ_BODY", JSON.stringify(body));
    else if (DBG.llmPrompt) dlogBig(sessionId, "LLM_PROMPT", userPrompt);
  }

  try {
    const r = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    const text = await r.text().catch(() => "");
    const latencyMs = msSince(t0);

    if (DBG.llm) {
      dlog(sessionId, "LLM_HTTP_DONE", {
        status: r.status,
        ok: r.ok,
        latencyMs,
        textChars: text.length,
        meta,
      });

      // Don’t always print the entire raw HTTP text; it can be huge/noisy.
      // Only print full if DEBUG_LLM_BODY is on; otherwise print a snippet.
      if (DBG.llmBody) {
        dlogBig(sessionId, "LLM_RAW_HTTP_TEXT", text);
      } else {
        dlog(sessionId, "LLM_RAW_HTTP_SNIP", { snip: safeSlice(text, 400) });
      }
    }

    if (!r.ok) {
      // Try to extract structured error message if any
      const parsedErr = safeJsonParse(text);
      const detail =
        parsedErr.ok
          ? safeSlice(parsedErr.value?.error?.message || parsedErr.value?.message || text, 500)
          : safeSlice(text, 500);

      throw new Error(`model-server ${r.status}: ${detail}`);
    }

    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      throw new Error(`model-server returned non-JSON response: ${safeSlice(text, 500)}`);
    }

    const content = parsed.value?.choices?.[0]?.message?.content ?? "";

    if (DBG.llm) {
      // This is the model’s final “assistant message content”
      dlogBig(sessionId, "LLM_CONTENT", content);
    }

    return content;
  } catch (e) {
    const latencyMs = msSince(t0);

    if (String(e?.name) === "AbortError") {
      const err = new Error(`model-server timeout after ${timeout}ms`);
      if (DBG.llm) dlog(sessionId, "LLM_TIMEOUT", { latencyMs, timeoutMs: timeout, meta });
      throw err;
    }

    if (DBG.llm) {
      dlog(sessionId, "LLM_ERROR", {
        latencyMs,
        error: String(e?.message || e),
        meta,
      });
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (DBG.llm) dlog(sessionId, "LLM_CALL_END", { meta });
  }
}
