// worker-agent/src/agent/AgentSession.js
import { chatCompletion } from "../services/llm/llamaClient.js";
import { validateAndNormalizeDecision } from "./actionSchema.js";
import {
  MAX_ELEMENTS,
  AGENT_PROMPT_MODE,
  AGENT_PROMPT_MAX_TOKENS,
  AGENT_PROMPT_TIMEOUT_MS,
  AGENT_PROMPT_MAX_ELEMENTS,
  LLM_MAX_TOKENS,
  LLM_FAST_TIMEOUT_MS,
} from "../config/env.js";
import { DBG, dlog, dlogBig } from "../services/debugLog.js";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeInt(n, def, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return clamp(def, min, max);
  return clamp(Math.round(v), min, max);
}

function safeStr(s, maxLen) {
  const t = String(s ?? "");
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function normLabel(e) {
  return String(e?.text || e?.ariaLabel || e?.title || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Tokenize a single line into tokens, respecting "double" and 'single' quotes.
 * Example: SELECT "select#lang" LABEL "English (US)"
 */
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function parseMs(token, unit) {
  const n = Number(token);
  if (!Number.isFinite(n)) return null;
  const u = String(unit || "").toLowerCase();
  if (!u || u === "ms") return Math.round(n);
  if (u === "s" || u === "sec" || u === "secs" || u === "second" || u === "seconds")
    return Math.round(n * 1000);
  return Math.round(n);
}

/**
 * Deterministic conversion from model output -> decision object with schema-compatible action.
 *
 * Preferred one-line commands (ONE LINE ONLY):
 * - CLICK <elementNumber>
 * - CLICK <x> <y> [RIGHT]
 * - HOVER <elementNumber>
 * - HOVER <x> <y>
 * - HOVERSEL <selector>
 * - TYPE <text...>
 * - TYPESEL <selector> <text...> [CLEAR]
 * - SELECT <selector> (VALUE|LABEL|INDEX) <value...>
 * - PRESS <key>
 * - SCROLL <dx> <dy>
 * - WAIT <ms>   (or WAIT 2 s)
 * - GOTO <http(s)://url>
 * - SCREENSHOT <x> <y> <w> <h> [PNG|JPEG] [QUALITY <1-100>]
 * - DONE <message...>
 * - ASK <question...>
 *
 * Also supports a few loose legacy patterns as fallback.
 */
function parseFreeformToDecision(freeformRaw, ctx) {
  const rawText = String(freeformRaw || "").trim();
  if (!rawText) return null;

  // Use only the first non-empty line (model sometimes returns extra lines)
  const text = rawText.split("\n").map((l) => l.trim()).find(Boolean) || "";

  const elements = Array.isArray(ctx?.elements) ? ctx.elements : [];
  const viewport = ctx?.viewport || { width: 1280, height: 720 };
  const W = Number(viewport.width || 1280);
  const H = Number(viewport.height || 720);

  const byNum = (n) => {
    const idx = Number(n) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= elements.length) return null;
    const e = elements[idx];
    return { x: e?.x, y: e?.y, label: normLabel(e), idx: idx + 1 };
  };

  const byText = (needle) => {
    const q = String(needle || "").trim().toLowerCase();
    if (!q) return null;

    let best = null;
    for (let i = 0; i < elements.length; i++) {
      const e = elements[i];
      const label = normLabel(e);
      if (!label) continue;

      const ll = label.toLowerCase();
      if (ll === q) return { x: e?.x, y: e?.y, label, idx: i + 1 };
      if (ll.includes(q)) best ??= { x: e?.x, y: e?.y, label, idx: i + 1 };
    }
    return best;
  };

  const clampXY = (x, y) => ({
    x: clamp(Math.round(Number(x)), 0, W - 1),
    y: clamp(Math.round(Number(y)), 0, H - 1),
  });

  const mk = (action, explanation) => ({
    done: false,
    // validateAndNormalizeDecision will re-derive requiresApproval; keep it correct anyway
    requiresApproval: action?.type === "screenshot_region",
    action,
    explanation: safeStr(explanation || "", 400),
  });

  // ----------------------------
  // A) Structured commands (tokenized)
  // ----------------------------
  const toks = tokenize(text);
  if (toks.length) {
    const cmd = String(toks[0] || "").toUpperCase();

    // DONE ...
    if (cmd === "DONE") {
      const msg = toks.slice(1).join(" ").trim() || "Done.";
      return { done: true, message: safeStr(msg, 400) };
    }

    // ASK ...
    if (cmd === "ASK") {
      const q = toks.slice(1).join(" ").trim() || "What should I do next?";
      return mk({ type: "ask_user", question: safeStr(q, 400) }, "Asking user for input.");
    }

    // GOTO url
    if (cmd === "GOTO") {
      const url = (toks[1] || "").trim();
      if (!url) return null;
      return mk({ type: "goto", url }, `Navigating to ${url}.`);
    }

    // WAIT <ms> or WAIT <n> <unit>
    if (cmd === "WAIT") {
      if (!toks[1]) return null;
      let ms = null;
      if (toks[2]) ms = parseMs(toks[1], toks[2]);
      else ms = parseMs(toks[1], "ms");
      if (ms == null) return null;
      return mk({ type: "wait", ms }, "Waiting briefly.");
    }

    // SCROLL dx dy
    if (cmd === "SCROLL") {
      const dx = Number(toks[1]);
      const dy = Number(toks[2]);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
      return mk({ type: "scroll", dx, dy }, `Scrolling by (${dx}, ${dy}).`);
    }

    // PRESS key
    if (cmd === "PRESS") {
      const key = (toks[1] || "").trim();
      if (!key) return null;
      return mk({ type: "press_key", key }, `Pressing ${key}.`);
    }

    // TYPE <text...>
    if (cmd === "TYPE") {
      const payload = toks.slice(1).join(" ").trim();
      return mk({ type: "type", text: safeStr(payload, 2000) }, "Typing text.");
    }

    // TYPESEL <selector> <text...> [CLEAR]
    // (aliases)
    if (cmd === "TYPESEL" || cmd === "TYPE_IN_SELECTOR" || cmd === "TYPEIN") {
      const selector = (toks[1] || "").trim();
      if (!selector) return null;

      let clearFirst = false;
      let rest = toks.slice(2);

      // Support trailing CLEAR
      if (rest.length && String(rest[rest.length - 1]).toUpperCase() === "CLEAR") {
        clearFirst = true;
        rest = rest.slice(0, -1);
      }

      const payload = rest.join(" ").trim();
      return mk(
        { type: "type_in_selector", selector, text: safeStr(payload, 2000), clearFirst },
        `Typing into selector ${selector}.`
      );
    }

    // SELECT <selector> (VALUE|LABEL|INDEX) <value...>
    if (cmd === "SELECT") {
      const selector = (toks[1] || "").trim();
      const kind = String(toks[2] || "").toUpperCase();
      if (!selector || !kind) return null;

      if (kind === "INDEX") {
        const idx = toks[3];
        if (idx == null) return null;
        return mk(
          { type: "select", selector, index: Number(idx) },
          `Selecting index ${idx} in ${selector}.`
        );
      }

      if (kind === "VALUE") {
        const value = toks.slice(3).join(" ").trim();
        if (!value) return null;
        return mk(
          { type: "select", selector, value: safeStr(value, 500) },
          `Selecting value in ${selector}.`
        );
      }

      if (kind === "LABEL") {
        const label = toks.slice(3).join(" ").trim();
        if (!label) return null;
        return mk(
          { type: "select", selector, label: safeStr(label, 500) },
          `Selecting label in ${selector}.`
        );
      }

      return null;
    }

    // HOVER <n> or HOVER x y
    if (cmd === "HOVER") {
      const a = toks[1];
      const b = toks[2];

      // HOVER <elementNumber>
      if (a && !b && /^\d{1,3}$/.test(a)) {
        const hit = byNum(a);
        if (!hit || !Number.isFinite(hit.x) || !Number.isFinite(hit.y)) return null;
        const { x, y } = clampXY(hit.x, hit.y);
        return mk(
          { type: "hover", x, y },
          `Hovering element #${hit.idx}${hit.label ? ` (“${hit.label}”)` : ""}.`
        );
      }

      // HOVER x y
      if (a && b) {
        const x = Number(a);
        const y = Number(b);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const xy = clampXY(x, y);
        return mk({ type: "hover", x: xy.x, y: xy.y }, `Hovering at (${xy.x}, ${xy.y}).`);
      }

      return null;
    }

    // HOVERSEL <selector>
    if (cmd === "HOVERSEL") {
      const selector = (toks.slice(1).join(" ") || "").trim();
      if (!selector) return null;
      return mk({ type: "hover", selector: safeStr(selector, 500) }, `Hovering selector ${selector}.`);
    }

    // CLICK <n> OR CLICK x y [RIGHT]
    if (cmd === "CLICK") {
      const a = toks[1];
      const b = toks[2];
      const c = String(toks[3] || "").toUpperCase();

      // CLICK <elementNumber>
      if (a && !b && /^\d{1,3}$/.test(a)) {
        const hit = byNum(a);
        if (!hit || !Number.isFinite(hit.x) || !Number.isFinite(hit.y)) return null;
        const { x, y } = clampXY(hit.x, hit.y);
        return mk(
          { type: "click", x, y, button: "left" },
          `Clicking element #${hit.idx}${hit.label ? ` (“${hit.label}”)` : ""}.`
        );
      }

      // CLICK x y [RIGHT]
      if (a && b) {
        const x0 = Number(a);
        const y0 = Number(b);
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
        const { x, y } = clampXY(x0, y0);
        const button = c === "RIGHT" ? "right" : "left";
        return mk({ type: "click", x, y, button }, `Clicking at (${x}, ${y}) with ${button} button.`);
      }

      return null;
    }

    // SCREENSHOT x y w h [PNG|JPEG] [QUALITY n]
    if (cmd === "SCREENSHOT" || cmd === "SHOT" || cmd === "SNAP") {
      const x = Number(toks[1]);
      const y = Number(toks[2]);
      const w = Number(toks[3]);
      const h = Number(toks[4]);
      if (![x, y, w, h].every(Number.isFinite)) return null;

      let format = "png";
      let quality = undefined;

      const rest = toks.slice(5).map((t) => String(t).toUpperCase());
      if (rest.includes("JPEG")) format = "jpeg";
      if (rest.includes("PNG")) format = "png";

      const qi = rest.indexOf("QUALITY");
      if (qi >= 0 && rest[qi + 1] != null) {
        const q = Number(rest[qi + 1]);
        if (Number.isFinite(q)) quality = q;
      }

      const action = {
        type: "screenshot_region",
        x,
        y,
        w,
        h,
        format,
        ...(format === "jpeg" && quality != null ? { quality } : {}),
      };
      return mk(action, "Capturing screenshot region (requires approval).");
    }
  }

  // ----------------------------
  // B) Loose fallback patterns (keep minimal + safe)
  // ----------------------------

  // DONE-ish
  if (/\b(done|completed|finished|goal achieved)\b/i.test(text) && text.length <= 140) {
    return { done: true, message: "Done." };
  }

  // wait 4s / wait 4000ms
  {
    const m = text.match(/\bwait\s+(\d+)\s*(ms|s|sec|secs|second|seconds)?\b/i);
    if (m) {
      const ms = parseMs(m[1], m[2]);
      if (ms != null) return mk({ type: "wait", ms }, "Waiting briefly.");
    }
  }

  // scroll up/down
  if (/\bscroll\b/i.test(text)) {
    let dx = 0;
    let dy = /\bup\b/i.test(text) ? -800 : 800;

    const m = text.match(/\bscroll\b.*?(-?\d{1,5})\s*[,\s]\s*(-?\d{1,5})/i);
    if (m) {
      dx = Number(m[1]);
      dy = Number(m[2]);
    }

    return mk({ type: "scroll", dx, dy }, `Scrolling by (${dx}, ${dy}).`);
  }

  // goto URL anywhere
  {
    const m = text.match(/\bhttps?:\/\/\S+/i);
    if (m) return mk({ type: "goto", url: m[0] }, `Navigating to ${m[0]}.`);
  }

  // press key
  {
    const m = text.match(/\bpress(?:\s+key)?\s+([A-Za-z0-9_+-]+)\b/i);
    if (m) return mk({ type: "press_key", key: m[1] }, `Pressing ${m[1]}.`);
  }

  // click element N
  if (/\b(click|tap)\b/i.test(text)) {
    const mN = text.match(/\b(?:element|el|#)\s*(\d{1,3})\b/i);
    if (mN) {
      const hit = byNum(mN[1]);
      if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) {
        const { x, y } = clampXY(hit.x, hit.y);
        const right = /\bright\b.*\bclick\b/i.test(text) || /\bright[-\s]?click\b/i.test(text);
        return mk(
          { type: "click", x, y, button: right ? "right" : "left" },
          `Clicking element #${hit.idx}${hit.label ? ` (“${hit.label}”)` : ""}.`
        );
      }
    }

    // click "Some Text"
    const q = text.match(/"(.*?)"|'(.*?)'/);
    const needle = (q?.[1] || q?.[2] || "").trim();
    if (needle) {
      const hit = byText(needle);
      if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) {
        const { x, y } = clampXY(hit.x, hit.y);
        return mk(
          { type: "click", x, y, button: "left" },
          `Clicking element #${hit.idx}${hit.label ? ` (“${hit.label}”)` : ""}.`
        );
      }
    }

    // click (x,y)
    const mXY = text.match(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/);
    if (mXY) {
      const { x, y } = clampXY(Number(mXY[1]), Number(mXY[2]));
      return mk({ type: "click", x, y, button: "left" }, `Clicking at (${x}, ${y}).`);
    }
  }

  // type "text"
  if (/\b(type|enter|input)\b/i.test(text)) {
    const q = text.match(/"(.*?)"|'(.*?)'/);
    const payload = (q?.[1] || q?.[2] || "").trim();
    if (payload) return mk({ type: "type", text: safeStr(payload, 2000) }, "Typing text.");
  }

  // if clearly asking user
  if (/\b(need|cannot|can't|unable|blocked|stuck|missing)\b/i.test(text)) {
    return mk({ type: "ask_user", question: safeStr(text, 400) }, "Asking user for input.");
  }

  return null;
}

export class AgentSession {
  constructor({ sessionId, goal, model }) {
    this.sessionId = sessionId;
    this.goal = goal || "";
    this.model = model || "default";

    this.status = this.goal ? "running" : "idle"; // idle | running | done
    this.lastObs = null;
    this.corrections = [];
    this.step = 0;

    this.badOutputCount = 0;
    this.lastActions = [];
    this.lastSeenAt = Date.now();

    // --- anti-spam + resiliency ---
    this.awaitingUser = false;
    this.lastAskUserAt = 0;
    this.lastAskUserMsg = "";

    this.llmFailStreak = 0;
    this.nextAllowedLlmAt = 0;

    // --- prompt mode controls (single env flag) ---
    this.promptMode = String(AGENT_PROMPT_MODE || "default").trim().toLowerCase();
    if (!["default", "simple", "constrained"].includes(this.promptMode)) {
      this.promptMode = "default";
    }

    // unified mode-specific knobs (optional overrides)
    this.modeMaxTokens = Number(AGENT_PROMPT_MAX_TOKENS || 0) || null;
    this.modeTimeoutMs = Number(AGENT_PROMPT_TIMEOUT_MS || 0) || null;
    this.modeMaxElements = Number(AGENT_PROMPT_MAX_ELEMENTS || 0) || null;

    // --- default knobs from env.js ---
    this.defaultMaxTokens = Number(LLM_MAX_TOKENS || 320);

    // ALWAYS >= 90s
    this.defaultTimeoutMs = Math.max(90_000, Number(LLM_FAST_TIMEOUT_MS || 90_000));
  }

  setObservation(obs) {
    this.lastObs = obs;
    this.lastSeenAt = Date.now();

    if (DBG.agent) {
      dlog(this.sessionId, "OBS_RECEIVED", {
        url: obs?.url,
        obsId: obs?.obsId,
        viewport: obs?.viewport,
        elementsCount: Array.isArray(obs?.elements) ? obs.elements.length : 0,
        ts: obs?.ts,
      });
    }
  }

  setInstruction(text) {
    this.goal = String(text || "").trim();
    this.status = this.goal ? "running" : "idle";

    this.corrections = [];
    this.badOutputCount = 0;
    this.lastActions = [];

    this.awaitingUser = false;
    this.lastAskUserAt = 0;
    this.lastAskUserMsg = "";
    this.llmFailStreak = 0;
    this.nextAllowedLlmAt = 0;

    this.lastSeenAt = Date.now();

    if (DBG.agent) {
      dlog(this.sessionId, "INSTRUCTION_SET", {
        status: this.status,
        model: this.model,
        promptMode: this.promptMode,
        goal: String(this.goal || "").slice(0, 240),
      });
    }
  }

  setIdle() {
    this.status = "idle";
    this.goal = "";
    this.corrections = [];
    this.badOutputCount = 0;
    this.lastActions = [];

    this.awaitingUser = false;
    this.lastAskUserAt = 0;
    this.lastAskUserMsg = "";
    this.llmFailStreak = 0;
    this.nextAllowedLlmAt = 0;

    this.lastSeenAt = Date.now();
  }

  addCorrection(c) {
    this.corrections.push(c);
    this.awaitingUser = false;
    this.lastSeenAt = Date.now();
  }

  _getPromptConfig() {
    // Freeform step config
    const base = {
      mode: this.promptMode,
      maxTokens: this.defaultMaxTokens,
      timeoutMs: this.defaultTimeoutMs,
      maxElements: Math.min(Number(MAX_ELEMENTS || 40), 20),
    };

    if (this.promptMode === "simple") {
      base.maxTokens = 160;
      base.timeoutMs = 90_000;
      base.maxElements = 12;
    }

    if (this.promptMode === "constrained") {
      base.maxTokens = 160;
      base.timeoutMs = 90_000;
      base.maxElements = 10;
    }

    // env overrides (still enforce timeout >= 30s)
    if (Number.isFinite(this.modeMaxTokens) && this.modeMaxTokens > 0) {
      base.maxTokens = clamp(Math.round(this.modeMaxTokens), 40, 900);
    }
    if (Number.isFinite(this.modeTimeoutMs) && this.modeTimeoutMs > 0) {
      base.timeoutMs = Math.max(90_000, Math.round(this.modeTimeoutMs));
    }
    if (Number.isFinite(this.modeMaxElements) && this.modeMaxElements > 0) {
      base.maxElements = clamp(Math.round(this.modeMaxElements), 1, 25);
    }

    return base;
  }

  _buildElementLines(elements, limit, labelLen, tagLen) {
    return (elements || [])
      .slice(0, limit)
      .map((e, i) => {
        const label = String(e.text || e.ariaLabel || e.title || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, labelLen);
        return `${i + 1}. ${String(e.tag || "").slice(0, tagLen)} "${label}" (${e.x},${e.y})`;
      })
      .join("\n");
  }

  _buildFreeformPrompt(cfg) {
    const { url, elements = [] } = this.lastObs || { url: "", elements: [] };
    const goal = String(this.goal || "(none)").trim().slice(0, 400) || "(none)";

    const corrText = this.corrections
      .slice(-3)
      .map((c) => `- ${String(c.text || "").slice(0, 180)}`)
      .join("\n");

    const elementLines = this._buildElementLines(elements, cfg.maxElements, 60, 20);

    return `
You are a precise browser automation agent.
Given the GOAL, the current URL, and the visible ELEMENTS, decide the single best next action.

OUTPUT EXACTLY ONE LINE in ONE of these formats (no extra lines, no explanations):
- CLICK <elementNumber>
- CLICK <x> <y> [RIGHT]
- HOVER <elementNumber>
- HOVER <x> <y>
- HOVERSEL <selector>
- TYPE <text...>
- TYPESEL <selector> <text...> [CLEAR]
- SELECT <selector> (VALUE|LABEL|INDEX) <value...>
- PRESS <key>
- SCROLL <dx> <dy>
- WAIT <ms>   (or: WAIT <n> s)
- GOTO <http(s)://url>
- SCREENSHOT <x> <y> <w> <h> [PNG|JPEG] [QUALITY <1-100>]
- DONE <message...>
- ASK <question...>

Rules:
- Prefer CLICK <elementNumber> using the ELEMENT list coordinates.
- Output ONE action only: choose the best immediate next step toward the goal.
- If progress requires multiple steps, output only the next step now; the next observation will arrive and you will choose the next step then.
- If you reference a selector, quote it if it contains spaces.

GOAL:
${goal}

URL:
${String(url || "").slice(0, 2000)}

CORRECTIONS:
${corrText || "none"}

ELEMENTS (top ${cfg.maxElements}):
${elementLines || "none"}

OUTPUT ONE LINE NOW:
`.trim();
  }

  _loopDetect(action) {
    let key = "";
    try {
      key = JSON.stringify(action);
    } catch {
      key = String(action?.type || "unknown");
    }

    this.lastActions.push(key);
    if (this.lastActions.length > 6) this.lastActions.shift();

    if (this.lastActions.length >= 4) {
      const tail = this.lastActions.slice(-4);
      if (tail.every((x) => x === tail[0])) return true;
    }
    return false;
  }

  _cooldownFromFailure(reason = "llm_failure") {
    this.llmFailStreak += 1;
    const waitMs = Math.min(60_000, 2_000 * Math.pow(2, this.llmFailStreak));
    this.nextAllowedLlmAt = Date.now() + waitMs;

    if (DBG.agent) {
      dlog(this.sessionId, "DECIDE_RETURN_WAIT", {
        reason,
        llmFailStreak: this.llmFailStreak,
        waitMs,
      });
    }

    return {
      done: false,
      requiresApproval: false,
      action: { type: "wait", ms: waitMs },
      explanation: "LLM failure; retrying.",
    };
  }

  async decideNextAction() {
    if (DBG.agent) {
      dlog(this.sessionId, "DECIDE_BEGIN", {
        status: this.status,
        awaitingUser: this.awaitingUser,
        llmFailStreak: this.llmFailStreak,
        nextAllowedLlmAt: this.nextAllowedLlmAt,
        hasObs: !!this.lastObs,
        goal: String(this.goal || "").slice(0, 160),
        url: this.lastObs?.url,
        elementsCount: Array.isArray(this.lastObs?.elements) ? this.lastObs.elements.length : 0,
      });
    }

    if (this.awaitingUser) {
      if (DBG.agent) dlog(this.sessionId, "DECIDE_RETURN_WAIT", { reason: "awaiting_user" });
      return {
        done: false,
        requiresApproval: false,
        action: { type: "wait", ms: 5000 },
        explanation: "Waiting for user response.",
      };
    }

    if (!this.lastObs) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "wait", ms: 5000 },
        explanation: "No observation yet.",
      };
    }

    if (this.status !== "running" || !this.goal) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "wait", ms: 5000 },
        explanation: "Idle; no goal.",
      };
    }

    if (Date.now() < this.nextAllowedLlmAt) {
      const ms = Math.max(0, this.nextAllowedLlmAt - Date.now());
      if (DBG.agent) dlog(this.sessionId, "DECIDE_RETURN_WAIT", { reason: "backoff", ms });
      return {
        done: false,
        requiresApproval: false,
        action: { type: "wait", ms: Math.min(60_000, ms) },
        explanation: "Cooling down after LLM failures.",
      };
    }

    const ctx = {
      viewport: this.lastObs.viewport,
      url: this.lastObs.url,
      elements: this.lastObs.elements || [],
    };

    const cfg = this._getPromptConfig();

    // 1) FREEFORM (command) RESPONSE
    const freeformPrompt = this._buildFreeformPrompt(cfg);

    if (DBG.agent) {
      dlog(this.sessionId, "PROMPT_BUILT_FREEFORM", {
        mode: cfg.mode,
        maxTokens: cfg.maxTokens,
        timeoutMs: cfg.timeoutMs,
        maxElements: cfg.maxElements,
        promptChars: freeformPrompt.length,
      });
      if (DBG.llmPrompt) dlogBig(this.sessionId, "PROMPT_TEXT_FREEFORM", freeformPrompt);
    }

    let freeformRaw = "";
    try {
      freeformRaw = await chatCompletion({
        prompt: freeformPrompt,
        temperature: 0,
        maxTokens: cfg.maxTokens,
        timeoutMs: cfg.timeoutMs,
        meta: { sessionId: this.sessionId, mode: `${cfg.mode}:freeform` },
      });

      if (DBG.agent) dlogBig(this.sessionId, "MODEL_RAW_FREEFORM", freeformRaw);

      this.llmFailStreak = 0;
      this.nextAllowedLlmAt = 0;
    } catch (e) {
      if (DBG.agent) {
        dlog(this.sessionId, "LLM_CALL_FAILED_FREEFORM", { message: String(e?.message || e) });
      }
      return this._cooldownFromFailure("llm_call_failed_freeform");
    }

    // 2) DETERMINISTIC PARSE (NO JSONIFY MODEL)
    const parsedDecision = parseFreeformToDecision(freeformRaw, ctx);
    if (!parsedDecision) {
      this.badOutputCount += 1;

      this.corrections.push({
        text:
          "Your output could not be parsed. Output EXACTLY ONE LINE in the required format, e.g. 'CLICK 12' or 'SCROLL 0 800' or 'ASK <question>'.",
      });

      if (DBG.agent)
        dlog(this.sessionId, "FREEFORM_PARSE_FAILED", {
          sample: String(freeformRaw || "").slice(0, 200),
        });

      return this._cooldownFromFailure("freeform_parse_failed");
    }

    // DONE path
    if (parsedDecision.done === true) {
      return { done: true, message: safeStr(parsedDecision.message || "Done.", 400) };
    }

    // ACTION path => schema validate
    const v = validateAndNormalizeDecision(parsedDecision, ctx);

    if (!v.ok) {
      this.badOutputCount += 1;

      this.corrections.push({
        text: `Your action failed schema validation: ${v.error}. Output a valid one-line command like 'CLICK 12' or 'TYPESEL "#q" hello CLEAR'.`,
      });

      if (DBG.agent) dlog(this.sessionId, "ACTION_SCHEMA_INVALID", { error: v.error });

      return this._cooldownFromFailure("invalid_action_schema");
    }

    // Loop detect
    if (this._loopDetect(v.decision.action)) {
      this.corrections.push({
        text: "You repeated the same action multiple times. Choose a different element or scroll.",
      });
      return this._cooldownFromFailure("loop_detected");
    }

    // Guardrail: if we keep getting bad outputs, backoff
    if (this.badOutputCount >= 3) {
      return this._cooldownFromFailure("too_many_invalid_outputs");
    }

    // Extra safety: ensure requiresApproval strictly matches policy
    if (v.decision?.action?.type === "screenshot_region") v.decision.requiresApproval = true;
    else v.decision.requiresApproval = false;

    // Extra safety: normalize scroll/wait numbers (schema already does; keep belt+suspenders)
    if (v.decision?.action?.type === "wait") {
      v.decision.action.ms = safeInt(v.decision.action.ms ?? 500, 500, 0, 60_000);
    }
    if (v.decision?.action?.type === "scroll") {
      v.decision.action.dx = safeInt(v.decision.action.dx ?? 0, 0, -2000, 2000);
      v.decision.action.dy = safeInt(v.decision.action.dy ?? 500, 500, -4000, 4000);
    }

    if (DBG.agent) {
      dlog(this.sessionId, "DECIDE_RETURN", {
        actionType: v?.decision?.action?.type,
        requiresApproval: !!v?.decision?.requiresApproval,
      });
    }

    return v.decision;
  }
}
