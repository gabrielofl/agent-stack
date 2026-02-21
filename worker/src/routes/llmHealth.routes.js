// src/routes/llmHealth.routes.js (ESM)
import { Router } from "express";
import { fetchFn } from "../services/fetch.js";
import { LLAMA_BASE_URL } from "../config/env.js";
import { llmIsBusy } from "../services/llm/llamaClient.js";

export const llmHealthRouter = Router();

// ---------------- SSE broadcast (frontend admin console) ----------------
const sseClients = new Set();
let lastResult = null;
let lastAt = 0;

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

  // Optionally push the last known status immediately (nice UX)
  if (lastResult) {
    sseSend(res, "llm_health", {
      type: "llm_health",
      ts: lastResult.ts ?? Date.now(),
      llamaBaseUrl: lastResult.llamaBaseUrl,
      level: lastResult.level,
      ok: lastResult.ok,
      summary: lastResult.summary,
      models: lastResult.models,
      chat: lastResult.chat,
      cached: true,
    });
  }

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
  try {
    return JSON.parse(JSON.stringify(cause));
  } catch {
    return { message: String(cause) };
  }
}

function serializeError(e) {
  if (!e) return { message: "unknown_error" };
  if (typeof e === "string") return { message: e };
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
  // lightweight cache so your frontend polling doesn't hammer llama
  if (Date.now() - lastAt < 1000 && lastResult) return res.json(lastResult);

  const base = (LLAMA_BASE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");

  const debug = String(req.query?.debug || "").toLowerCase();
  const debugOn = debug === "1" || debug === "true" || debug === "yes" || debug === "on";

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
      skipped: false,
    },
    ts: Date.now(),
  };

  const finalizeAndReturn = () => {
    // store cache
    lastResult = result;
    lastAt = Date.now();

    // broadcast a single health event
    const event = {
      type: "llm_health",
      ts: result.ts,
      llamaBaseUrl: base,
      level: result.level,
      ok: result.ok,
      summary: result.summary,
      busy: !!result.busy,
      models: {
        ok: result.models.ok,
        status: result.models.status,
        latencyMs: result.models.latencyMs,
        count: result.models.count,
        modelId: debugOn ? result.models.modelId : undefined,
        error: result.models.error ?? undefined,
        responseText: debugOn ? result.models.responseText : undefined,
      },
      chat: {
        ok: result.chat.ok,
        status: result.chat.status,
        latencyMs: result.chat.latencyMs,
        slow: result.chat.slow,
        sample: result.chat.sample,
        skipped: result.chat.skipped,
        responseText: result.chat.responseText,
        error: result.chat.error,
        request: debugOn ? result.chat.request : undefined,
        responseJson: debugOn ? result.chat.responseJson : undefined,
      },
      health: {
        ok: result.health.ok,
        status: result.health.status,
        latencyMs: result.health.latencyMs,
        error: result.health.error ?? undefined,
      },
    };

    if (sseClients.size > 0 || broadcastOn || debugOn) broadcast("llm_health", event);
    console.log("[LLM_HEALTH]", JSON.stringify(event));

    return res.status(200).json(result);
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

  // ---------------- (1) models probe: always do this ----------------
  const modelsProbe = await probe(`${base}/v1/models`, MODELS_TIMEOUT_MS);

  // cannot connect at all
  if (!modelsProbe.ok) {
    result.health.ok = false;
    result.health.error = modelsProbe.error || { message: "fetch_failed" };
    result.summary = "llama unreachable";
    result.level = "down";
    result.ok = false;
    return finalizeAndReturn();
  }

  // reachability ok (we got an HTTP status)
  result.health.ok = true;
  result.health.status = modelsProbe.status;
  result.health.latencyMs = modelsProbe.latencyMs;

  // llama up but loading model
  if (modelsProbe.status === 503) {
    result.models.ok = false;
    result.models.status = 503;
    result.models.latencyMs = modelsProbe.latencyMs;
    result.models.error = "HTTP 503 (server loading model)";
    if (debugOn) result.models.responseText = trim(modelsProbe.text, 2000);

    result.summary = "LLM loading (llama up, model not ready yet)";
    result.level = "degraded";
    result.ok = false;
    return finalizeAndReturn();
  }

  // parse /v1/models if it succeeded
  let modelId = "local";
  if (!modelsProbe.httpOk) {
    result.models.ok = false;
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

  // ---------------- (2) if busy -> skip chat probe ----------------
  const busy = llmIsBusy(); // global busy (any session)
  if (busy) {
    result.busy = true;
    result.chat.ok = true;
    result.chat.skipped = true;
    result.chat.status = 0;
    result.chat.latencyMs = 0;
    result.chat.slow = false;
    result.chat.sample = "skipped (llm busy)";
    result.chat.error = null;

    // Decide without chat probe
    result.level = result.models.ok ? "ready" : "degraded";
    result.ok = result.level === "ready";
    result.summary = "LLM ready (chat probe skipped: busy)";
    return finalizeAndReturn();
  }

  // ---------------- (3) chat probe ----------------
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
    result.chat.responseText = trim(text, 4000);

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
      result.chat.ok = false;
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
    result.chat.ok = false;
    result.chat.error = e?.name === "AbortError" ? { message: "timeout" } : err;
  }

  // ---------------- compute level/summary ----------------
  result.level = levelFrom(result);
  result.ok = result.level === "ready";

  if (result.level === "ready") {
    result.summary = result.chat.slow ? "LLM ready (slow)" : "LLM ready";
  } else if (result.level === "degraded") {
    result.summary = "LLM degraded (server up, API partially failing)";
  } else {
    result.summary = "LLM down";
  }

  return finalizeAndReturn();
});
