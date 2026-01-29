// src/middleware/requireAdmin.js (ESM)
import { ADMIN_TOKEN } from "../config/env.js";

export function requireAdmin(req, res, next) {
  // ✅ allow CORS preflight through
  if (req.method === "OPTIONS") return next();

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
