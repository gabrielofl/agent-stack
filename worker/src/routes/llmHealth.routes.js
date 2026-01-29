import { Router } from "express";
import { fetchFn } from "../services/fetch.js"; // adjust path if needed
import { LLAMA_BASE_URL } from "../config/env.js";

export const llmHealthRouter = Router();

// small helper
function msSince(t0) {
  return Math.round(performance.now() - t0);
}

// Node 20 has global performance; if not, fallback
const now = () => (globalThis.performance?.now ? performance.now() : Date.now());

llmHealthRouter.get("/health/llm", async (req, res) => {
  // If llama is local-in-container, this should be http://127.0.0.1:8080
  const base = LLAMA_BASE_URL || "http://127.0.0.1:8080";

  const result = {
    ok: false,
    llamaBaseUrl: base,
    health: { ok: false, latencyMs: null, error: null },
    chat: { ok: false, latencyMs: null, error: null },
    ts: Date.now(),
  };

  // 1) /health probe
  try {
    const t0 = now();
    const r = await fetchFn(`${base}/health`, { method: "GET" });
    const latency = msSince(t0);

    result.health.latencyMs = latency;

    if (!r.ok) {
      result.health.error = `HTTP ${r.status}`;
      return res.status(200).json(result);
    }

    result.health.ok = true;
  } catch (e) {
    result.health.error = String(e?.message || e);
    return res.status(200).json(result);
  }

  // 2) /v1/chat/completions probe (responsiveness)
  // keep it tiny: minimal tokens, short ctx, deterministic
  try {
    const t0 = now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // health timeout separate from LLM_TIMEOUT_MS

    const r = await fetchFn(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "local",
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with: OK" }],
      }),
    });

    clearTimeout(timeout);

    const latency = msSince(t0);
    result.chat.latencyMs = latency;

    const text = await r.text();
    if (!r.ok) {
      result.chat.error = `HTTP ${r.status}: ${text.slice(0, 120)}`;
      return res.status(200).json(result);
    }

    // Parse minimally; don’t hard-fail if parsing changes.
    let content = "";
    try {
      const json = JSON.parse(text);
      content = json?.choices?.[0]?.message?.content || "";
    } catch {
      content = text.slice(0, 120);
    }

    // Accept “OK” presence as a basic sanity check
    result.chat.ok = /ok/i.test(content);
    if (!result.chat.ok) {
      result.chat.error = `Unexpected response: ${String(content).slice(0, 80)}`;
      return res.status(200).json(result);
    }

    result.ok = true;
    return res.status(200).json(result);
  } catch (e) {
    result.chat.error = String(e?.name === "AbortError" ? "timeout" : e?.message || e);
    return res.status(200).json(result);
  }
});
