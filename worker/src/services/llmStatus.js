// src/services/llmStatus.js
import fs from "fs";
import path from "path";
import { push } from "./streamHub.js";

const STATUS_FILE = process.env.LLM_STATUS_FILE || "/tmp/llm_status.json";
const LOG_FILE = process.env.LLM_BOOT_LOG_FILE || "/tmp/llm_boot.log";
const WATCH_INTERVAL_MS = Number(process.env.LLM_STATUS_WATCH_INTERVAL_MS || 1000);

let current = { ok: false, phase: "unknown", message: "no status yet", ts: Date.now() };
let lastRaw = "";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function getLlmStatus() {
  return current;
}

export function readBootLogTail(lines = 200) {
  try {
    const txt = fs.readFileSync(LOG_FILE, "utf8");
    const arr = txt.split("\n");
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  } catch {
    return "";
  }
}

function updateFromDisk() {
  let raw = "";
  try {
    raw = fs.readFileSync(STATUS_FILE, "utf8");
  } catch {
    // file might not exist yet
    return;
  }

  if (!raw || raw === lastRaw) return;
  lastRaw = raw;

  const next = safeJsonParse(raw);
  if (!next) return;

  current = next;

  // broadcast to a global session "llm"
  push("llm", {
    type: "llm_status",
    status: next.phase,
    ok: !!next.ok,
    message: next.message || "",
    ts: next.ts || Date.now(),
    meta: {
      modelPath: next.modelPath,
      ctxSize: next.ctxSize,
      llamaPort: next.llamaPort,
      error: next.error,
    },
  });
}

export function initLlmStatusBroadcaster() {
  // Ensure folder exists
  try { fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true }); } catch {}

  // Initial poll + periodic poll (more reliable than fs.watch in containers)
  updateFromDisk();
  setInterval(updateFromDisk, WATCH_INTERVAL_MS).unref?.();
}
