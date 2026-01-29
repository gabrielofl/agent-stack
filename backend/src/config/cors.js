// src/config/cors.js
export const ALLOWED_ORIGINS = new Set([
  "https://purple-smoke-02e25d403.1.azurestaticapps.net",
]);

export function corsOriginDelegate(origin, cb) {
  // allow same-origin / server-to-server / curl (no Origin header)
  if (!origin) return cb(null, true);
  return cb(null, ALLOWED_ORIGINS.has(origin));
}
