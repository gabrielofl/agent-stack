// src/services/fetch.js (ESM)
// fetch polyfill (works on Node 18+ with global fetch; falls back if needed)

let fetchFn = globalThis.fetch?.bind(globalThis);

if (!fetchFn) {
  try {
    // Optional dependency fallback (only used if global fetch is missing)
    const mod = await import("node-fetch");
    fetchFn = mod.default;
  } catch {
    throw new Error(
      "Global fetch is not available and node-fetch is not installed. Use Node 18+ or add node-fetch."
    );
  }
}

export { fetchFn };
