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

const COMMANDS = new Set([
  "CLICK",
  "HOVER",
  "HOVERSEL",
  "TYPE",
  "TYPESEL",
  "SELECT",
  "PRESS",
  "SCROLL",
  "WAIT",
  "GOTO",
  "SCREENSHOT",
  "SHOT",
  "SNAP",
  "DONE",
  "ASK",
]);

function stripBulletPrefix(line) {
  let s = String(line || "").trim();
  // remove common bullets: "-", "*", "•"
  s = s.replace(/^[-*•]+\s*/g, "");
  // remove numeric bullets: "1." "2)" etc.
  s = s.replace(/^\d+[\.\)]\s*/g, "");
  // remove "Action:" / "Output:" prefixes
  s = s.replace(/^(action|output|next action)\s*:\s*/i, "");
  // remove wrapping quotes
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  return s.trim();
}

/**
 * Extract the first valid command line from raw model text.
 * Returns null if none found (so we can apply deterministic fallback instead of WAIT/backoff).
 */
function extractFirstCommandLine(rawText) {
  const lines = String(rawText || "")
    .split("\n")
    .map((l) => stripBulletPrefix(l))
    .filter(Boolean);

  // 1) Line begins with valid command
  for (let line of lines) {
    const toks = tokenize(line);
    const cmd = String(toks[0] || "").toUpperCase();
    if (COMMANDS.has(cmd)) return line.replace(/\r?\n/g, " ").trim();
  }

  // 2) Recovery: command appears later in text (rare)
  const upper = String(rawText || "").toUpperCase();
  for (const cmd of COMMANDS) {
    const idx = upper.indexOf(cmd);
    if (idx >= 0) {
      const slice = stripBulletPrefix(String(rawText).slice(idx));
      const firstLine = slice.split("\n")[0] || "";
      const toks = tokenize(firstLine);
      const firstCmd = String(toks[0] || "").toUpperCase();
      if (COMMANDS.has(firstCmd)) return firstLine.replace(/\r?\n/g, " ").trim();
    }
  }

  return null;
}

/**
 * Build a deterministic fallback ONE-LINE command.
 * Prefer clicking a Settings/Menu-ish element if present, otherwise ASK.
 */
function buildFallbackCommandLine(goal, elements) {
  const g = String(goal || "").toLowerCase();
  const els = Array.isArray(elements) ? elements : [];

  const findByLabel = (re) => {
    for (let i = 0; i < els.length; i++) {
      const label = normLabel(els[i]);
      if (label && re.test(label)) return i + 1; // elementNumber is 1-based
    }
    return null;
  };

  // Language tasks: almost always Settings first
  if (g.includes("language")) {
    const n =
      findByLabel(/instellingen|settings|param[eè]tres|configuraci[oó]n|taal|language/i) ??
      findByLabel(/account|profile|profiel/i) ??
      findByLabel(/menu|hamburger|navigation|navigatie/i);
    if (n != null) return `CLICK ${n}`;
  }

  // Generic: menu/settings
  const n =
    findByLabel(/menu|hamburger|navigation|navigatie/i) ??
    findByLabel(/instellingen|settings|param[eè]tres|configuraci[oó]n/i);
  if (n != null) return `CLICK ${n}`;

  return `ASK Which on-screen element should I use next?`;
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
 * This now ONLY attempts parsing if we can extract a valid command line.
 */
function parseFreeformToDecision(freeformRaw, ctx) {
  const rawText = String(freeformRaw || "").trim();
  if (!rawText) return null;

  // Must find a valid command line; otherwise return null and let caller fallback deterministically.
  const text = extractFirstCommandLine(rawText);
  if (!text) return null;

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

    if (cmd === "DONE") {
      const msg = toks.slice(1).join(" ").trim() || "Done.";
      return { done: true, message: safeStr(msg, 400) };
    }

    if (cmd === "ASK") {
      const q = toks.slice(1).join(" ").trim() || "What should I do next?";
      return mk({ type: "ask_user", question: safeStr(q, 400) }, "Asking user for input.");
    }

    if (cmd === "GOTO") {
      const url = (toks[1] || "").trim();
      if (!url) return null;
      return mk({ type: "goto", url }, `Navigating to ${url}.`);
    }

    if (cmd === "WAIT") {
      if (!toks[1]) return null;
      let ms = null;
      if (toks[2]) ms = parseMs(toks[1], toks[2]);
      else ms = parseMs(toks[1], "ms");
      if (ms == null) return null;
      return mk({ type: "wait", ms }, "Waiting briefly.");
    }

    if (cmd === "SCROLL") {
      const dx = Number(toks[1]);
      const dy = Number(toks[2]);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
      return mk({ type: "scroll", dx, dy }, `Scrolling by (${dx}, ${dy}).`);
    }

    if (cmd === "PRESS") {
      const key = (toks[1] || "").trim();
      if (!key) return null;
      return mk({ type: "press_key", key }, `Pressing ${key}.`);
    }

    if (cmd === "TYPE") {
      const payload = toks.slice(1).join(" ").trim();
      return mk({ type: "type", text: safeStr(payload, 2000) }, "Typing text.");
    }

    if (cmd === "TYPESEL" || cmd === "TYPE_IN_SELECTOR" || cmd === "TYPEIN") {
      const selector = (toks[1] || "").trim();
      if (!selector) return null;

      let clearFirst = false;
      let rest = toks.slice(2);

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

    if (cmd === "SELECT") {
      const selector = (toks[1] || "").trim();
      const kind = String(toks[2] || "").toUpperCase();
      if (!selector || !kind) return null;

      if (kind === "INDEX") {
        const idx = toks[3];
        if (idx == null) return null;
        return mk({ type: "select", selector, index: Number(idx) }, `Selecting index ${idx} in ${selector}.`);
      }

      if (kind === "VALUE") {
        const value = toks.slice(3).join(" ").trim();
        if (!value) return null;
        return mk({ type: "select", selector, value: safeStr(value, 500) }, `Selecting value in ${selector}.`);
      }

      if (kind === "LABEL") {
        const label = toks.slice(3).join(" ").trim();
        if (!label) return null;
        return mk({ type: "select", selector, label: safeStr(label, 500) }, `Selecting label in ${selector}.`);
      }

      return null;
    }

    if (cmd === "HOVER") {
      const a = toks[1];
      const b = toks[2];

      if (a && !b && /^\d{1,3}$/.test(a)) {
        const hit = byNum(a);
        if (!hit || !Number.isFinite(hit.x) || !Number.isFinite(hit.y)) return null;
        const { x, y } = clampXY(hit.x, hit.y);
        return mk({ type: "hover", x, y }, `Hovering element #${hit.idx}${hit.label ? ` (“${hit.label}”)` : ""}.`);
      }

      if (a && !b && /-?\d+,-?\d+/.test(a)) {
        const [xs, ys] = String(a).split(",");
        const x0 = Number(xs);
        const y0 = Number(ys);
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
        const { x, y } = clampXY(x0, y0);
        return mk({ type: "hover", x, y }, `Hovering at (${x}, ${y}).`);
      }

      if (a && b) {
        const x = Number(a);
        const y = Number(b);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const xy = clampXY(x, y);
        return mk({ type: "hover", x: xy.x, y: xy.y }, `Hovering at (${xy.x}, ${xy.y}).`);
      }

      return null;
    }

    if (cmd === "HOVERSEL") {
      const selector = (toks.slice(1).join(" ") || "").trim();
      if (!selector) return null;
      return mk({ type: "hover", selector: safeStr(selector, 500) }, `Hovering selector ${selector}.`);
    }

    if (cmd === "CLICK") {
      const a = toks[1];
      const b = toks[2];
      const c = String(toks[3] || "").toUpperCase();

      if (a && !b && /^\d{1,3}$/.test(a)) {
        const hit = byNum(a);
        if (!hit || !Number.isFinite(hit.x) || !Number.isFinite(hit.y)) return null;
        const { x, y } = clampXY(hit.x, hit.y);
        return mk(
          { type: "click", x, y, button: "left" },
          `Clicking element #${hit.idx}${hit.label ? ` (“${hit.label}”)` : ""}.`
        );
      }

      if (a && !b && /-?\d+,-?\d+/.test(a)) {
        const [xs, ys] = String(a).split(",");
        const x0 = Number(xs);
        const y0 = Number(ys);
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
        const { x, y } = clampXY(x0, y0);
        const button = c === "RIGHT" ? "right" : "left";
        return mk({ type: "click", x, y, button }, `Clicking at (${x}, ${y}) with ${button} button.`);
      }

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

  // If we had a valid command token but couldn't parse it, treat as parse failure.
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

    // Prevent re-entrant decide loops (obs inflight / repeated waits)
    this._decideInFlight = false;

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

CRITICAL OUTPUT RULES (must follow exactly):
- Your ENTIRE response must be EXACTLY ONE LINE.
- That line MUST START with one of these commands:
  CLICK, HOVER, HOVERSEL, TYPE, TYPESEL, SELECT, PRESS, SCROLL, WAIT, GOTO, SCREENSHOT, DONE, ASK
- Do NOT output bullet lists, multiple steps, explanations, or the URL.
- Prefer CLICK <elementNumber> from the ELEMENTS list.
- Only use GOTO if you truly must change to a different website/page URL; otherwise CLICK/SCROLL/SELECT.

OUTPUT FORMATS (choose ONE):
- CLICK <elementNumber>
- CLICK <x> <y> [RIGHT]     (or CLICK <x>,<y>)
- HOVER <elementNumber>
- HOVER <x> <y>             (or HOVER <x>,<y>)
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

GOAL:
${goal}

URL (for context only, DO NOT output it):
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
    // Keep cooldown ONLY for real LLM call failures (timeouts/network),
    // not for parse/schema issues (those now fallback deterministically).
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

  _fallbackDecision(reason, ctx, freeformRaw = "") {
    const fallbackLine = buildFallbackCommandLine(this.goal, ctx?.elements || []);
    console.log(
      `@@LLM_ASSISTANT_COERCED@@ sessionId=${this.sessionId ?? "?"} step=${this.step} reason=${reason}\n` +
        `raw=${safeStr(String(freeformRaw || ""), 300)}\n` +
        `coerced=${fallbackLine}\n` +
        `@@END_LLM_ASSISTANT_COERCED@@`
    );

    const parsed = parseFreeformToDecision(fallbackLine, ctx);

    if (parsed?.done === true) {
      return { done: true, message: safeStr(parsed.message || "Done.", 400) };
    }

    const v = parsed ? validateAndNormalizeDecision(parsed, ctx) : null;
    if (v?.ok) {
      // Never require approval for these fallbacks (they won't be screenshot_region)
      v.decision.requiresApproval = false;
      v.decision.explanation = safeStr(`Fallback action (${reason}).`, 200);
      return v.decision;
    }

    // Absolute last resort: ASK
    return {
      done: false,
      requiresApproval: false,
      action: { type: "ask_user", question: "I couldn't parse the model output. What should I click next?" },
      explanation: `Fallback ASK (${reason}).`,
    };
  }

  async decideNextAction() {
    // Prevent re-entrant calls from spamming WAIT loops.
    if (this._decideInFlight) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "wait", ms: 250 },
        explanation: "Decision in progress; throttling.",
      };
    }

    this._decideInFlight = true;
    try {
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
        this.step += 1;

        freeformRaw = await chatCompletion({
          prompt: freeformPrompt,
          temperature: 0,
          maxTokens: cfg.maxTokens,
          timeoutMs: cfg.timeoutMs,
          meta: { sessionId: this.sessionId, stepId: this.step, mode: `${cfg.mode}:freeform` },
        });

        if (DBG.agent) dlogBig(this.sessionId, "MODEL_RAW_FREEFORM", freeformRaw);

        // Reset LLM call failure backoff on successful call
        this.llmFailStreak = 0;
        this.nextAllowedLlmAt = 0;
      } catch (e) {
        if (DBG.agent) {
          dlog(this.sessionId, "LLM_CALL_FAILED_FREEFORM", { message: String(e?.message || e) });
        }
        return this._cooldownFromFailure("llm_call_failed_freeform");
      }

      // Print the raw response again with a marker close to the decision logic (easy grep)
      console.log(
        `@@LLM_ASSISTANT_RAW@@ sessionId=${this.sessionId ?? "?"} step=${this.step} stage=AgentSession\n` +
          `${safeStr(String(freeformRaw || ""), 4000)}\n` +
          `@@END_LLM_ASSISTANT_RAW@@`
      );

      // 2) DETERMINISTIC PARSE
      const parsedDecision = parseFreeformToDecision(freeformRaw, ctx);

      // If parse fails: DO NOT backoff-wait. Deterministically fallback immediately.
      if (!parsedDecision) {
        this.badOutputCount += 1;

        this.corrections.push({
          text:
            "Your output could not be parsed. Output EXACTLY ONE LINE starting with a valid command, e.g. 'CLICK 12' or 'SCROLL 0 800' or 'ASK <question>'. Do not include the URL.",
        });

        if (DBG.agent) {
          dlog(this.sessionId, "FREEFORM_PARSE_FAILED", {
            sample: String(freeformRaw || "").slice(0, 200),
          });
        }

        return this._fallbackDecision("freeform_parse_failed", ctx, freeformRaw);
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

        // No backoff WAIT here either; fallback immediately.
        return this._fallbackDecision("invalid_action_schema", ctx, freeformRaw);
      }

      // Loop detect => immediate safe alternative (scroll) instead of WAIT loop
      if (this._loopDetect(v.decision.action)) {
        this.corrections.push({
          text: "You repeated the same action multiple times. Choose a different element or scroll.",
        });

        // Prefer a non-destructive action that often reveals new clickable items.
        console.log(
          `@@LLM_ASSISTANT_COERCED@@ sessionId=${this.sessionId ?? "?"} step=${this.step} reason=loop_detected\n` +
            `coerced=SCROLL 0 800\n` +
            `@@END_LLM_ASSISTANT_COERCED@@`
        );

        const loopParsed = parseFreeformToDecision("SCROLL 0 800", ctx);
        if (loopParsed) {
          const vv = validateAndNormalizeDecision(loopParsed, ctx);
          if (vv.ok) return vv.decision;
        }

        return this._fallbackDecision("loop_detected", ctx, freeformRaw);
      }

      // If too many invalid outputs, ask user instead of WAIT storm
      if (this.badOutputCount >= 3) {
        return {
          done: false,
          requiresApproval: false,
          action: {
            type: "ask_user",
            question:
              "I’m getting inconsistent model outputs. Can you tell me what button/link I should click next (or what you see on screen)?",
          },
          explanation: "Too many invalid model outputs; asking user.",
        };
      }

      // Extra safety: ensure requiresApproval strictly matches policy
      if (v.decision?.action?.type === "screenshot_region") v.decision.requiresApproval = true;
      else v.decision.requiresApproval = false;

      // Normalize scroll/wait numbers (schema already does; keep belt+suspenders)
      if (v.decision?.action?.type === "wait") {
        v.decision.action.ms = safeInt(v.decision.action.ms ?? 500, 500, 0, 60_000);
      }
      if (v.decision?.action?.type === "scroll") {
        v.decision.action.dx = safeInt(v.decision.action.dx ?? 0, 0, -2000, 2000);
        v.decision.action.dy = safeInt(v.decision.action.dy ?? 500, 500, -4000, 4000);
      }

      // Print final action with searchable marker
      console.log(
        `@@LLM_ASSISTANT_COERCED@@ sessionId=${this.sessionId ?? "?"} step=${this.step} reason=final\n` +
          `coerced=${safeStr(JSON.stringify(v.decision.action), 800)}\n` +
          `@@END_LLM_ASSISTANT_COERCED@@`
      );

      if (DBG.agent) {
        dlog(this.sessionId, "DECIDE_RETURN", {
          actionType: v?.decision?.action?.type,
          requiresApproval: !!v?.decision?.requiresApproval,
        });
      }

      return v.decision;
    } finally {
      this._decideInFlight = false;
    }
  }
}
