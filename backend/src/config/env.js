// src/config/env.js (ESM)
import crypto from "crypto";

export const WORKER_HTTP = process.env.WORKER_HTTP || "http://worker-agent:4000";
export const WORKER_WS =
  process.env.WORKER_WS || "ws://worker-agent:4000/agent-stream";

export const AGENT_OBS_MIN_INTERVAL_MS = 1000; // 1Hz

export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// IMPORTANT: identical behavior to your original file:
// - if ADMIN_TOKEN env var is set, use it
// - otherwise generate a random token once per process boot
export const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString("hex");

export const AUTO_START_AGENT = process.env.AUTO_START_AGENT === "1";
export const AUTO_GOAL =
  process.env.AUTO_GOAL || "Explore the page and report what you find.";

export const PORT = process.env.PORT || 3000;
export const HOST = "0.0.0.0";

export const AGENT_ENABLED = process.env.AGENT_ENABLED !== "0";