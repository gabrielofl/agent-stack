// src/routes/admin.routes.js (ESM)
import { Router } from "express";
import { ADMIN_PASSWORD, ADMIN_TOKEN } from "../config/env.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const adminRouter = Router();

adminRouter.post("/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "invalid_password" });
  res.json({ token: ADMIN_TOKEN });
});

adminRouter.get("/admin/me", requireAdmin, (req, res) => {
  res.json({ ok: true, role: "admin" });
});
