// src/routes/llmHealth.routes.js (ESM)
import { Router } from "express";
import { fetchFn } from "../services/fetch.js";
import { LLAMA_BASE_URL } from "../config/env.js";

export const llmHealthRouter = Router();

// ---------------- SSE broadcast (frontend admin console) ----------------
const sseClients = new Set();

function sseHeaders(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // If behind nginx, this helps prevent buffering:
  res.setHeader("X-Accel-Buffering", "no");
  // Some proxies like an initial flush:
  res.flushHeaders?.();
}

function sseSend(res, eventName, data) {
  // SSE format: event:<name>\ndata:<json>\n\n
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(eventName, data) {
  for (const res of sseClients) {
    try {
      sseSend(res, eventName, data);
    } catch {
      // ignore broken clients
    }
  }
}

llmHealthRouter.get("/health/llm/stream", (req, res) => {
  sseHeaders(res);

  // Acknowledge connection
  sseSend(res, "connected", { ok: true, ts: Date.now() });

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });

  // Keep-alive ping every 25s (prevents idle disconnects)
  const ping = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {}
    }
  }, 25000);

  req.on("close", () => clearInterval(ping));
});

// ---------------- utilities ----------------
const baseNow = () => (globalThis.performance?.now ? performance.now() : Date.now());
const msSince = (t0) => Math.round((globalThis.performance?.now ? performance.now() : Date.now()) - t0);

async function safeText(r) {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

function trim(s, n = 2000) {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  return str.length > n ? str.slice(0, n) + `…(trimmed ${str.length - n})` : str;
}

function serializeCause(cause) {
  if (!cause) return null;
  if (typeof cause === "string") return { message: cause };
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      code: cause.code,
      errno: cause.errno,
      syscall: cause.syscall,
      address: cause.address,
      port: cause.port,
      stack: trim(cause.stack, 1200),
    };
  }
  // unknown object
  try {
    return JSON.parse(JSON.stringify(cause));
  } catch {
    return { message: String(cause) };
  }
}

function serializeError(e) {
  if (!e) return { message: "unknown_error" };
  if (typeof e === "string") return { message: e };

  // Node fetch often throws TypeError("fetch failed") with e.cause containing the real reason
  return {
    name: e.name,
    message: e.message,
    code: e.code,
    stack: trim(e.stack, 1200),
    cause: serializeCause(e.cause),
  };
}

function levelFrom(result) {
  if (!result.health.ok) return "down";
  if (!result.models.ok) return "degraded";
  if (!result.chat.ok) return "degraded";
  return "ready";
}

llmHealthRouter.get("/health/llm", async (req, res) => {
  const base = (LLAMA_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");

  const debug = String(req.query?.debug || "").toLowerCase();
  const debugOn = debug === "1" || debug === "true" || debug === "yes" || debug === "on";

  // You can also force broadcasting via ?broadcast=1 (optional)
  const broadcastQ = String(req.query?.broadcast || "").toLowerCase();
  const broadcastOn = broadcastQ === "1" || broadcastQ === "true" || broadcastQ === "yes" || broadcastQ === "on";

  const CHAT_SLOW_MS = 4000;
  const CHAT_TIMEOUT_MS = 8000;
  const MODELS_TIMEOUT_MS = 2000;

  const result = {
    ok: false,
    level: "down",
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
      request: null,
      responseText: null,
      responseJson: null,
    },
    ts: Date.now(),
  };

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
      return { r, latencyMs: msSince(t0) };
    } finally {
      clearTimeout(t);
    }
  }

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
      return { r, latencyMs: msSince(t0), requestBody: body };
    } finally {
      clearTimeout(t);
    }
  }

  // Prefer /v1/models as "reachability + readiness" probe
  async function probe(url, timeoutMs) {
    try {
      const { r, latencyMs } = await getWithTimeout(url, timeoutMs);
      const text = await safeText(r);
      return { ok: true, httpOk: r.ok, status: r.status, latencyMs, text };
    } catch (e) {
      const err = serializeError(e);
      const isAbort = e?.name === "AbortError";
      return { ok: false, error: isAbort ? { message: "timeout" } : err };
    }
  }

  const modelsProbe = await probe(`${base}/v1/models`, MODELS_TIMEOUT_MS);

  // If we cannot even connect -> truly down/unreachable
  if (!modelsProbe.ok) {
    result.health.error = modelsProbe.error || { message: "fetch_failed" };
    result.summary = "llama unreachable";
    result.level = levelFrom(result);

    // Broadcast a concise event so you see the real error in frontend console.
    const event = {
      type: "llm_health",
      ts: result.ts,
      llamaBaseUrl: base,
      level: result.level,
      ok: result.ok,
      summary: result.summary,
      models: null,
      chat: null,
      error: result.health.error,
    };

    // Always broadcast if there are SSE clients OR if broadcastOn/debugOn
    if (sseClients.size > 0 || broadcastOn || debugOn) {
      broadcast("llm_health", event);
    }

    console.log("[LLM_HEALTH]", JSON.stringify(event));
    return res.status(200).json(result);
  }

  // Connection exists (we got an HTTP status back)
  result.health.ok = true;
  result.health.status = modelsProbe.status;
  result.health.latencyMs = modelsProbe.latencyMs;

  // If /v1/models returns 503, llama is up but still loading
  if (modelsProbe.status === 503) {
    result.models.ok = false;
    result.models.status = 503;
    result.models.latencyMs = modelsProbe.latencyMs;
    result.models.error = "HTTP 503 (server loading model)";
    result.summary = "LLM loading (llama up, model not ready yet)";
    result.level = "degraded";
    result.ok = false;

    if (debugOn) {
      result.models.responseText = trim(modelsProbe.text, 2000);
    }

    const event = {
      type: "llm_health",
      ts: result.ts,
      llamaBaseUrl: base,
      level: result.level,
      ok: result.ok,
      summary: result.summary,
      models: {
        status: result.models.status,
        latencyMs: result.models.latencyMs,
        error: result.models.error,
        responseText: debugOn ? result.models.responseText : undefined,
      },
      chat: null,
    };

    if (sseClients.size > 0 || broadcastOn || debugOn) {
      broadcast("llm_health", event);
    }

    console.log("[LLM_HEALTH]", JSON.stringify(event));
    return res.status(200).json(result);
  }

  // Parse /v1/models if it succeeded
  let modelId = "local";
  if (!modelsProbe.httpOk) {
    result.models.status = modelsProbe.status;
    result.models.latencyMs = modelsProbe.latencyMs;
    result.models.error = `HTTP ${modelsProbe.status}: ${trim(modelsProbe.text, 200)}`;
  } else {
    result.models.ok = true;
    result.models.status = modelsProbe.status;
    result.models.latencyMs = modelsProbe.latencyMs;

    try {
      const json = JSON.parse(modelsProbe.text || "{}");
      const arr = Array.isArray(json?.data) ? json.data : null;
      result.models.count = arr ? arr.length : null;

      const firstId = arr?.[0]?.id;
      if (typeof firstId === "string" && firstId) modelId = firstId;
    } catch {
      // keep models.ok true; count stays null
    }
  }

  if (debugOn) {
    result.models.modelId = modelId;
    result.models.responseText = trim(modelsProbe.text, 2000);
  }

  // ---- Chat probe ----
  const chatBody = {
    model: modelId,
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

    // IMPORTANT: keep this even when debug is off, so we can broadcast it
    result.chat.responseText = trim(text, 4000);

    // Parse JSON if possible
    let parsedJson = null;
    try {
      parsedJson = text ? JSON.parse(text) : null;
    } catch {
      parsedJson = null;
    }

    if (debugOn) {
      result.chat.request = requestBody;
      result.chat.responseJson = parsedJson;
    }

    if (!r.ok) {
      result.chat.error = `HTTP ${r.status}: ${trim(text, 300)}`;
    } else {
      result.chat.ok = true;
      if (parsedJson) {
        const content = parsedJson?.choices?.[0]?.message?.content ?? "";
        result.chat.sample = String(content).slice(0, 200) || null;
        result.chat.parsed = true;
      } else {
        result.chat.sample = result.chat.responseText.slice(0, 200) || null;
      }
    }
  } catch (e) {
    const err = serializeError(e);
    result.chat.error = e?.name === "AbortError" ? "timeout" : err;
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

  // ---------------- broadcast to frontend admin console ----------------
  const event = {
    type: "llm_health",
    ts: result.ts,
    llamaBaseUrl: base,
    level: result.level,
    ok: result.ok,
    summary: result.summary,
    models: {
      ok: result.models.ok,
      status: result.models.status,
      latencyMs: result.models.latencyMs,
      count: result.models.count,
      modelId: debugOn ? result.models.modelId : undefined,
    },
    chat: {
      ok: result.chat.ok,
      status: result.chat.status,
      latencyMs: result.chat.latencyMs,
      slow: result.chat.slow,
      sample: result.chat.sample,
      // Always include responseText (trimmed) so you can see the real LLM output in the frontend console
      responseText: result.chat.responseText,
      error: result.chat.error,
      // Only include request/JSON when debug=1
      request: debugOn ? result.chat.request : undefined,
      responseJson: debugOn ? result.chat.responseJson : undefined,
    },
  };

  if (sseClients.size > 0 || broadcastOn || debugOn) {
    broadcast("llm_health", event);
  }

  console.log("[LLM_HEALTH]", JSON.stringify(event));

  return res.status(200).json(result);
});
