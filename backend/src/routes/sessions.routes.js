// src/routes/sessions.routes.js (ESM)
import { Router } from "express";
import { sessions, newId } from "../services/sessionStore.js";
import { createSession, closeSession } from "../services/sessionLifecycle.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const sessionsRouter = Router();

sessionsRouter.post("/sessions", async (req, res) => {
  const sessionId = newId();
  const startUrl = req.body?.url || "https://example.com";

  try {
    const { viewport } = await createSession({ sessionId, startUrl });

    res.json({
      sessionId,
      wsPath: `/ws?sessionId=${sessionId}`,
      url: startUrl,
      viewport,
    });
  } catch (e) {
    // Clean up partial session if something failed mid-creation
    try {
      await closeSession(sessionId);
    } catch {}
    res.status(500).json({
      error: "failed_to_create_session",
      detail: String(e?.message || e),
    });
  }
});

// Optional convenience endpoint (does not remove any existing behavior)
sessionsRouter.delete("/sessions/:sessionId", requireAdmin, async (req, res) => {
  const { sessionId } = req.params;
  await closeSession(sessionId);
  res.json({ ok: true });
});

// (Optional) You can later add: GET /sessions (admin only) for monitoring.
// This file is where session management endpoints should live.
