// worker: src/services/llmDebug.js (ESM)
import fs from "fs";
import path from "path";

// Support BOTH names (bash uses *_FILE; node used *_PATH)
const STATUS_PATH =
  process.env.LLM_STATUS_PATH ||
  process.env.LLM_STATUS_FILE ||
  "/tmp/llm_status.json";

const BOOT_LOG_PATH =
  process.env.LLM_BOOT_LOG_PATH ||
  process.env.LLM_BOOT_LOG_FILE ||
  "/tmp/llm_boot.log";

export function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Normalize the bash schema (phase/message) into the schema your UI likes (level/summary)
function normalizeStatus(s) {
  if (!s || typeof s !== "object") return null;

  // If bash wrote { phase, message } map it
  if (s.phase && !s.level) {
    const phase = String(s.phase);
    const level =
      phase === "ready" ? "ready" :
      phase === "error" ? "down" :
      "booting";

    return {
      ok: !!s.ok,
      level,
      summary: s.message || phase,
      phase,
      message: s.message || "",
      ts: s.ts || Date.now(),
      modelPath: s.modelPath,
      ctxSize: s.ctxSize,
      ...s,
    };
  }

  // Already in modern shape
  return {
    ok: !!s.ok,
    level: s.level || (s.ok ? "ready" : "down"),
    summary: s.summary || s.message || "",
    ts: s.ts || Date.now(),
    ...s,
  };
}

export function getLlmStatus() {
  const raw = readJsonFileSafe(STATUS_PATH);

  // If missing, stable response
  if (!raw) {
    return {
      ok: false,
      level: "unknown",
      summary: "no_status_file",
      ts: Date.now(),
      statusPath: STATUS_PATH,
    };
  }

  return normalizeStatus(raw);
}

export function readBootLogTail(lines = 200) {
  try {
    if (!fs.existsSync(BOOT_LOG_PATH)) return "";
    const raw = fs.readFileSync(BOOT_LOG_PATH, "utf8");
    if (!raw) return "";
    const arr = raw.split("\n");
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  } catch {
    return "";
  }
}

export function appendBootLog(line) {
  try {
    fs.appendFileSync(BOOT_LOG_PATH, String(line) + "\n");
  } catch {}
}

export function writeStatusAtomic(obj) {
  const dir = path.dirname(STATUS_PATH);
  const tmp = `${STATUS_PATH}.tmp`;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
    fs.renameSync(tmp, STATUS_PATH);
    return true;
  } catch {
    try {
      fs.writeFileSync(STATUS_PATH, JSON.stringify(obj), "utf8");
      return true;
    } catch {}
    return false;
  }
}
