// src/services/llm/jsonGuard.js

// Try to extract a JSON object from messy text by bracket balancing.
// Works even if the model outputs: "Sure! { ...json... } Thanks!"
export function extractJsonObject(text) {
  const s = String(text ?? "");

  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      const candidate = s.slice(start, i + 1);
      return candidate;
    }
  }
  return null;
}

export function safeJsonParse(text) {
  const direct = String(text ?? "").trim();

  // quick sanity trim for huge outputs
  const capped = direct.length > 50_000 ? direct.slice(0, 50_000) : direct;

  try {
    return { ok: true, value: JSON.parse(capped) };
  } catch {}

  const extracted = extractJsonObject(capped);
  if (!extracted) return { ok: false, error: "no_json_object_found" };

  try {
    return { ok: true, value: JSON.parse(extracted) };
  } catch (e) {
    return { ok: false, error: "json_parse_failed", detail: String(e?.message || e) };
  }
}
