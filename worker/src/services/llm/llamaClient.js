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

function approxTokens(s) {
  const t = String(s ?? "");
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

function safeStr(s, maxLen) {
  const t = String(s ?? "");
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

/**
 * chatCompletion
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
  const stepId = meta?.stepId;

  const timeout = Number(timeoutMs || LLM_TIMEOUT_MS);
  const userPrompt = String(prompt || "").slice(0, 20_000);

  const body = {
    model: "local",
    temperature,
    max_tokens: Math.max(8, Math.min(2048, Number(maxTokens || 320))),
    stop: ["\n"],
    messages: [
      {
        role: "system",
        content:
          "You are a precise browser automation agent. Output EXACTLY ONE LINE, no markdown, no commentary, no URL. The line must start with one command: CLICK, HOVER, HOVERSEL, TYPE, TYPESEL, SELECT, PRESS, SCROLL, WAIT, GOTO, SCREENSHOT, DONE, ASK.",
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

      if (DBG.llmBody) dlogBig(sessionId, "LLM_RAW_HTTP_TEXT", text);
      else dlog(sessionId, "LLM_RAW_HTTP_SNIP", { snip: safeSlice(text, 400) });
    }

    if (!r.ok) {
      const parsedErr = safeJsonParse(text);
      const detail =
        parsedErr.ok
          ? safeSlice(parsedErr.value?.error?.message || parsedErr.value?.message || text, 500)
          : safeSlice(text, 500);

      throw new Error(`llama-server ${r.status}: ${detail}`);
    }

    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      throw new Error(`llama-server returned non-JSON response: ${safeSlice(text, 500)}`);
    }

    const content = parsed.value?.choices?.[0]?.message?.content ?? "";

    console.log(
      `@@LLM_ASSISTANT_RAW@@ sessionId=${sessionId ?? "?"} stepId=${stepId ?? "?"} mode=${meta?.mode ?? "?"}\n` +
        `${safeStr(content, 4000)}\n` +
        `@@END_LLM_ASSISTANT_RAW@@`
    );

    if (DBG.llm) dlogBig(sessionId, "LLM_CONTENT", content);

    return content;
  } catch (e) {
    const latencyMs = msSince(t0);

    if (String(e?.name) === "AbortError") {
      const err = new Error(`llama-server timeout after ${timeout}ms`);
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
