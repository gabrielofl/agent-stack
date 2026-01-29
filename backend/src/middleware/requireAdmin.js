// src/middleware/requireAdmin.js (ESM)
import { ADMIN_TOKEN } from "../config/env.js";

export function requireAdmin(req, res, next) {
  // Let CORS preflight requests through
  if (req.method === "OPTIONS") return res.sendStatus(204);

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
