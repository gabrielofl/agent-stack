// src/services/llm/llamaClient.js
import { fetchFn } from "../fetch.js";
import { LLAMA_BASE_URL, LLM_TIMEOUT_MS } from "../../config/env.js";

export async function chatCompletion({ prompt, temperature = 0.2 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const r = await fetchFn(`${LLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "local",
        temperature,
        messages: [
          {
            role: "system",
            content:
              "You are a precise browser automation agent. Output ONLY JSON. No markdown. No commentary.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`llama-server ${r.status}: ${text.slice(0, 200)}`);

    const json = JSON.parse(text);
    return json?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    // Normalize abort errors
    if (String(e?.name) === "AbortError") {
      throw new Error(`llama-server timeout after ${LLM_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}
