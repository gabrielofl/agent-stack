// src/routes/health.routes.js
import { Router } from "express";

export const healthRouter = Router();
healthRouter.get("/health", (req, res) => res.json({ ok: true }));
