import { Router } from "express";
import { fetchFn } from "../services/fetch.js";
import { LLAMA_BASE_URL } from "../config/env.js";

export const llmHealthRouter = Router();

const baseNow = () => (globalThis.performance?.now ? performance.now() : Date.now());
const msSince = (t0) => Math.round((globalThis.performance?.now ? performance.now() : Date.now()) - t0);

async function safeText(r) {
  try { return await r.text(); } catch { return ""; }
}

function levelFrom(result) {
  // Down if llama /health fails
  if (!result.health.ok) return "down";
  // Degraded if models or chat fail
  if (!result.models.ok) return "degraded";
  if (!result.chat.ok) return "degraded";
  // Ready if everything ok
  return "ready";
}

llmHealthRouter.get("/health/llm", async (req, res) => {
  const base = LLAMA_BASE_URL || "http://127.0.0.1:8080";

  const debug = String(req.query?.debug || "").toLowerCase();
  const debugOn = debug === "1" || debug === "true" || debug === "yes" || debug === "on";

  // thresholds to help you see "slow but working"
  const CHAT_SLOW_MS = 4000;
  const CHAT_TIMEOUT_MS = 8000;
  const MODELS_TIMEOUT_MS = 2000;
  const HEALTH_TIMEOUT_MS = 1500;

  const result = {
    ok: false,
    level: "down", // down | degraded | ready
    summary: "",
    llamaBaseUrl: base,
    health: { ok: false, status: 0, latencyMs: null, error: null },
    models: { ok: false, status: 0, latencyMs: null, error: null, count: null },
    chat: {
      ok: false,
      status: 0,
      latencyMs: null,
      error: null,
      slow: false,
      sample: null,
      parsed: false,

      // ✅ debug fields (only filled when debugOn)
      request: null,
      responseText: null,
      responseJson: null,
    },
    ts: Date.now(),
  };

  // helper: GET with timeout
  async function getWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = baseNow();
    try {
      const r = await fetchFn(url, {
        method: "GET",
        signal: controller.signal,
        headers: { "cache-control": "no-cache" },
      });
      return { r, latencyMs: msSince(t0), aborted: false };
    } finally {
      clearTimeout(t);
    }
  }

  // helper: POST with timeout
  async function postWithTimeout(url, body, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = baseNow();
    try {
      const r = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", "cache-control": "no-cache" },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      return { r, latencyMs: msSince(t0), aborted: false, requestBody: body };
    } finally {
      clearTimeout(t);
    }
  }

  // 1) llama /health
  try {
    const { r, latencyMs } = await getWithTimeout(`${base}/health`, HEALTH_TIMEOUT_MS);
    result.health.status = r.status;
    result.health.latencyMs = latencyMs;

    if (!r.ok) {
      result.health.error = `HTTP ${r.status}`;
      result.level = levelFrom(result);
      result.summary = "llama /health failed";
      return res.status(200).json(result);
    }

    result.health.ok = true;
  } catch (e) {
    result.health.error = e?.name === "AbortError" ? "timeout" : String(e?.message || e);
    result.level = levelFrom(result);
    result.summary = "llama /health unreachable";
    return res.status(200).json(result);
  }

  // 2) /v1/models
  try {
    const { r, latencyMs } = await getWithTimeout(`${base}/v1/models`, MODELS_TIMEOUT_MS);
    result.models.status = r.status;
    result.models.latencyMs = latencyMs;

    const text = await safeText(r);
    if (!r.ok) {
      result.models.error = `HTTP ${r.status}: ${text.slice(0, 120)}`;
    } else {
      result.models.ok = true;
      try {
        const json = JSON.parse(text);
        const arr = Array.isArray(json?.data) ? json.data : null;
        result.models.count = arr ? arr.length : null;
      } catch {}
    }
  } catch (e) {
    result.models.error = e?.name === "AbortError" ? "timeout" : String(e?.message || e);
  }

  // 3) /v1/chat/completions (responsiveness)
  const chatBody = {
    model: "local",
    temperature: 0,
    max_tokens: 16,
    messages: [
      { role: "system", content: "You are a healthcheck. Reply with a short answer." },
      { role: "user", content: "ping" },
    ],
  };

  try {
    const { r, latencyMs, requestBody } = await postWithTimeout(
      `${base}/v1/chat/completions`,
      chatBody,
      CHAT_TIMEOUT_MS
    );

    result.chat.status = r.status;
    result.chat.latencyMs = latencyMs;
    result.chat.slow = latencyMs >= CHAT_SLOW_MS;

    const text = await safeText(r);

    // ✅ include debug request/response (only when ?debug=1)
    if (debugOn) {
      result.chat.request = requestBody;
      result.chat.responseText = text; // full raw response
      // try parse; store if ok
      try {
        result.chat.responseJson = text ? JSON.parse(text) : null;
      } catch {
        result.chat.responseJson = null;
      }
    }

    if (!r.ok) {
      result.chat.error = `HTTP ${r.status}: ${text.slice(0, 120)}`;
    } else {
      result.chat.ok = true;

      // existing "sample" logic kept
      try {
        const json = JSON.parse(text);
        const content = json?.choices?.[0]?.message?.content ?? "";
        result.chat.sample = String(content).slice(0, 80) || null;
        result.chat.parsed = true;
      } catch {
        result.chat.sample = text.slice(0, 80) || null;
      }
    }
  } catch (e) {
    result.chat.error = e?.name === "AbortError" ? "timeout" : String(e?.message || e);
  }

  result.level = levelFrom(result);
  result.ok = result.level === "ready";

  if (result.level === "ready") {
    result.summary = result.chat.slow ? "LLM ready (slow)" : "LLM ready";
  } else if (result.level === "degraded") {
    result.summary = "LLM degraded (server up, API partially failing)";
  } else {
    result.summary = "LLM down";
  }

  return res.status(200).json(result);
});

