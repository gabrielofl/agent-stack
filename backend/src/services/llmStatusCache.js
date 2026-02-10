// backend/src/services/llmStatusCache.js
import { fetchFn } from "./fetch.js";
import { WORKER_HTTP } from "../config/env.js";

let last = {
  ts: 0,
  level: "unknown",
  payload: null,
};

export function getCachedLlmStatus() {
  return last;
}

async function safeJson(url) {
  try {
    const r = await fetchFn(url, { method: "GET" });
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, json: JSON.parse(text) }; }
    catch { return { ok: r.ok, status: r.status, json: null, raw: text }; }
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

async function safeText(url) {
  try {
    const r = await fetchFn(url, { method: "GET" });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message || e) };
  }
}

export async function pollLlmStatusOnce() {
  const startedAt = Date.now();

  // probe
  let llmStatus = null;
  try {
    const rr = await fetchFn(`${WORKER_HTTP}/health/llm?debug=1`, { method: "GET" });
    const text = await rr.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    llmStatus = json ? { ok: rr.ok, status: rr.status, ...json } : { ok: rr.ok, status: rr.status, raw: text };
  } catch (e) {
    llmStatus = { ok: false, status: 0, error: "llm_probe_failed", detail: String(e?.message || e) };
  }

  // boot status + log on failure
  const bootStatusRes = await safeJson(`${WORKER_HTTP}/debug/llm/status`);
  const bootStatus = bootStatusRes.json ?? bootStatusRes.raw ?? bootStatusRes;

  const bootLogRes = !llmStatus?.ok
    ? await safeText(`${WORKER_HTTP}/debug/llm/log?lines=200`)
    : { ok: true, status: 200, text: "" };

  const payload = {
    ok: true,
    status: "snapshot",
    ms: Date.now() - startedAt,
    llmStatus,
    bootStatus,
    bootLog: bootLogRes.text || "",
  };

  last = {
    ts: Date.now(),
    level: llmStatus?.ok ? "ready" : "degraded",
    payload,
  };

  return last;
}

export function startLlmStatusPolling() {
  // run once immediately
  pollLlmStatusOnce().catch(() => {});

  // then poll every 10s (tune)
  setInterval(() => {
    pollLlmStatusOnce().catch(() => {});
  }, 10_000);
}
