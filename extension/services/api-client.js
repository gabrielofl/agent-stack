// src/services/api-client.js
import { EXT_CONFIG } from "../config.js";

export async function apiFetch(path, { method = "GET", body, token } = {}) {
  const base = EXT_CONFIG?.auth?.apiBase;
  if (!base) throw new Error("Missing auth.apiBase in EXT_CONFIG");

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  }

  return data;
}