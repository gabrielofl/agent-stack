// src/services/fetch.js
let fetchFn = globalThis.fetch?.bind(globalThis);

if (!fetchFn) {
  try {
    const mod = await import("node-fetch");
    fetchFn = mod.default;
  } catch {
    throw new Error(
      "Global fetch is not available and node-fetch is not installed. Use Node 18+ or add node-fetch."
    );
  }
}

export { fetchFn };
