import { fetchFn } from "./fetch.js";
import { WORKER_HTTP } from "../config/env.js";
import { sessions } from "./sessionStore.js";

let last = { ts: 0, level: "unknown", payload: null };

let pollTimer = null;

export function getCachedLlmStatus() {
  return last;
}

function shouldPoll() {
  // Poll only if at least one session is "active" in a way that implies the UI/agent cares.
  // This prevents the backend from keeping the worker warm when nobody is connected.
  for (const sess of sessions.values()) {
    if (!sess) continue;

    const viewersConnected = (sess.clients?.size || 0) > 0;
    const agentRunning = !!sess.agent?.running;
    const workerWsOpen = !!sess.workerWs && sess.workerWs.readyState === 1;

    if (viewersConnected || agentRunning || workerWsOpen) return true;
  }
  return false;
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

  let llmStatus = null;
  try {
    const rr = await fetchFn(`${WORKER_HTTP}/health/llm?debug=1`, { method: "GET" });
    const text = await rr.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    llmStatus = json
      ? { ok: rr.ok, status: rr.status, ...json }
      : { ok: rr.ok, status: rr.status, raw: text };
  } catch (e) {
    llmStatus = { ok: false, status: 0, error: "llm_probe_failed", detail: String(e?.message || e) };
  }

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
  if (pollTimer) return; // already running

  // run once immediately (but only if we should)
  if (shouldPoll()) {
    pollLlmStatusOnce().catch(() => {});
  }

  pollTimer = setInterval(() => {
    if (!shouldPoll()) return; // ✅ idle => do nothing (no worker keepalive)
    pollLlmStatusOnce().catch(() => {});
  }, 10_000);
}

export function stopLlmStatusPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}
