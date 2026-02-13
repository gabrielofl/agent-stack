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
  return String(e?.text || e?.ariaLabel || e?.title || e?.placeholder || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Tokenize a single line into tokens, respecting "double" and 'single' quotes.
 * Example: TYPESEL "#q" "hello world" CLEAR
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
  // legacy/basic
  "CLICK",
  "HOVER",
  "TYPE",
  "TYPESEL",
  "SELECT",
  "PRESS",
  "SCROLL",
  "WAIT",
  "GOTO",
  "SCREENSHOT",
  "DONE",
  "ASK",

  // extended generic
  "CLICKSEL",
  "HOVERSEL",
  "FOCUSSEL",
  "CLEARSEL",
  "CHECKSEL",
  "UNCHECKSEL",
  "SUBMITSEL",
  "CHORD",

  // read/inspection (when unsure)
  "EXTRACT",
  "EXTRACTHTML",
]);

function stripBulletPrefix(line) {
  let s = String(line || "").trim();
  s = s.replace(/^[-*•]+\s*/g, "");
  s = s.replace(/^\d+[\.\)]\s*/g, "");
  s = s.replace(/^(action|output|next action)\s*:\s*/i, "");
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  return s.trim();
}

function extractFirstCommandLine(rawText) {
  const lines = String(rawText || "")
    .split("\n")
    .map((l) => stripBulletPrefix(l))
    .filter(Boolean);

  for (let line of lines) {
    const toks = tokenize(line);
    const cmd = String(toks[0] || "").toUpperCase();
    if (COMMANDS.has(cmd)) return line.replace(/\r?\n/g, " ").trim();
  }

  // Fallback: scan for any command occurrence in text
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
 * Deterministic fallback ONE-LINE command (generic for any website).
 * Priority:
 *  1) primary CTA / submit-ish buttons
 *  2) obvious input/search box
 *  3) menu / navigation
 *  4) scroll down to reveal more
 */
function buildFallbackCommandLine(goal, elements) {
  const g = String(goal || "").toLowerCase();
  const els = Array.isArray(elements) ? elements : [];

  const findBy = (re) => {
    for (let i = 0; i < els.length; i++) {
      const label = normLabel(els[i]);
      if (label && re.test(label)) return i + 1;
    }
    return null;
  };

  const cta =
    findBy(/\b(continue|next|ok|okay|accept|agree|save|submit|confirm|sign in|log in|login|start|go|search|apply)\b/i) ??
    findBy(/\b(add to cart|checkout|pay|place order)\b/i);

  if (cta != null) return `CLICK ${cta}`;

  const search =
    findBy(/\b(search|find|lookup)\b/i) ??
    findBy(/\b(email|username|password)\b/i) ??
    findBy(/\b(address|city|zip|postal)\b/i);

  if (search != null) return `CLICK ${search}`;

  const menu =
    findBy(/\b(menu|navigation|hamburger|more)\b/i) ??
    findBy(/\b(settings|account|profile)\b/i);

  if (menu != null) return `CLICK ${menu}`;

  if (g.includes("find") || g.includes("look") || g.includes("scroll")) {
    return `SCROLL 0 900`;
  }

  return `SCROLL 0 900`;
}

function parseMs(token, unit) {
  const n = Number(token);
  if (!Number.isFinite(n)) return null;
  const u = String(unit || "").toLowerCase();
  if (!u || u === "ms") return Math.round(n);
  if (u === "s" || u === "sec" || u === "secs" || u === "second" || u === "seconds") return Math.round(n * 1000);
  return Math.round(n);
}

// ---- helpers for "unsure" behavior ----

function looksLikeUncertaintyOrHedge(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return true;

  // Strong signals the model isn't confident / is asking questions instead of producing command
  const patterns = [
    "i'm not sure",
    "im not sure",
    "i am not sure",
    "cannot determine",
    "can't determine",
    "unable to determine",
    "unclear",
    "not enough information",
    "need more info",
    "need more information",
    "i need",
    "could you",
    "please provide",
    "as an ai",
    "i can't",
    "i cannot",
    "might be",
    "maybe",
    "perhaps",
  ];

  return patterns.some((p) => s.includes(p));
}

function actionKey(action) {
  try {
    return JSON.stringify(action || {});
  } catch {
    return String(action?.type || "unknown");
  }
}

/**
 * Convert model output -> decision object.
 * Only attempts parsing if we can extract a valid command line.
 */
function parseFreeformToDecision(freeformRaw, ctx) {
  const rawText = String(freeformRaw || "").trim();
  if (!rawText) return null;

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

  const toks = tokenize(text);
  if (!toks.length) return null;

  const cmd = String(toks[0] || "").toUpperCase();

  // DONE / ASK
  if (cmd === "DONE") {
    const msg = toks.slice(1).join(" ").trim() || "Done.";
    return { done: true, message: safeStr(msg, 400) };
  }

  if (cmd === "ASK") {
    const q = toks.slice(1).join(" ").trim() || "What should I do next?";
    return mk({ type: "ask_user", question: safeStr(q, 400) }, "Asking user for input.");
  }

  // NAV
  if (cmd === "GOTO") {
    const url = (toks[1] || "").trim();
    if (!url) return null;
    return mk({ type: "goto", url }, `Navigating to ${url}.`);
  }

  // WAIT
  if (cmd === "WAIT") {
    if (!toks[1]) return null;
    const ms = toks[2] ? parseMs(toks[1], toks[2]) : parseMs(toks[1], "ms");
    if (ms == null) return null;
    return mk({ type: "wait", ms }, "Waiting briefly.");
  }

  // SCROLL
  if (cmd === "SCROLL") {
    const dx = Number(toks[1]);
    const dy = Number(toks[2]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return mk({ type: "scroll", dx, dy }, `Scrolling by (${dx}, ${dy}).`);
  }

  // KEYS
  if (cmd === "PRESS") {
    const key = (toks[1] || "").trim();
    if (!key) return null;
    return mk({ type: "press_key", key }, `Pressing ${key}.`);
  }

  if (cmd === "CHORD") {
    const keys = toks.slice(1).map((k) => String(k || "").trim()).filter(Boolean);
    if (!keys.length) return null;
    return mk({ type: "key_chord", keys }, `Pressing key chord ${keys.join("+")}.`);
  }

  // BASIC TYPE (types into active element)
  if (cmd === "TYPE") {
    const payload = toks.slice(1).join(" ").trim();
    return mk({ type: "type", text: safeStr(payload, 20000) }, "Typing text.");
  }

  // TYPESEL "#selector" "text" CLEAR
  if (cmd === "TYPESEL") {
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
      { type: "type_in_selector", selector, text: safeStr(payload, 20000), clearFirst },
      `Typing into selector ${selector}.`
    );
  }

  // FOCUSSEL "#selector"
  if (cmd === "FOCUSSEL") {
    const selector = toks.slice(1).join(" ").trim();
    if (!selector) return null;
    return mk({ type: "focus_selector", selector: safeStr(selector, 500) }, `Focusing ${selector}.`);
  }

  // CLEARSEL "#selector"
  if (cmd === "CLEARSEL") {
    const selector = toks.slice(1).join(" ").trim();
    if (!selector) return null;
    return mk({ type: "clear_selector", selector: safeStr(selector, 500) }, `Clearing ${selector}.`);
  }

  // CHECKSEL "#selector"
  if (cmd === "CHECKSEL") {
    const selector = toks.slice(1).join(" ").trim();
    if (!selector) return null;
    return mk({ type: "check_selector", selector: safeStr(selector, 500) }, `Checking ${selector}.`);
  }

  // UNCHECKSEL "#selector"
  if (cmd === "UNCHECKSEL") {
    const selector = toks.slice(1).join(" ").trim();
    if (!selector) return null;
    return mk({ type: "uncheck_selector", selector: safeStr(selector, 500) }, `Unchecking ${selector}.`);
  }

  // SUBMITSEL "form#id"
  if (cmd === "SUBMITSEL") {
    const selector = toks.slice(1).join(" ").trim();
    if (!selector) return null;
    return mk({ type: "submit_selector", selector: safeStr(selector, 500) }, `Submitting ${selector}.`);
  }

  // SELECT "#selector" (VALUE|LABEL|INDEX) <value...>
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

  // HOVER <elementNumber> | HOVER x y | HOVER x,y
  if (cmd === "HOVER") {
    const a = toks[1];
    const b = toks[2];

    if (a && !b && /^\d{1,6}$/.test(a)) {
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

  // HOVERSEL "<selector>"
  if (cmd === "HOVERSEL") {
    const selector = (toks.slice(1).join(" ") || "").trim();
    if (!selector) return null;
    return mk({ type: "hover_selector", selector: safeStr(selector, 500) }, `Hovering selector ${selector}.`);
  }

  // CLICK <elementNumber> | CLICK x y [RIGHT] | CLICK x,y [RIGHT]
  if (cmd === "CLICK") {
    const a = toks[1];
    const b = toks[2];
    const c = String(toks[3] || "").toUpperCase();

    if (a && !b && /^\d{1,6}$/.test(a)) {
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

  // CLICKSEL "<selector>" [RIGHT]
  if (cmd === "CLICKSEL") {
    const selector = (toks[1] || "").trim();
    if (!selector) return null;
    const button = String(toks[2] || "").toUpperCase() === "RIGHT" ? "right" : "left";
    return mk({ type: "click_selector", selector: safeStr(selector, 500), button }, `Clicking selector ${selector}.`);
  }

  // SCREENSHOT x y w h [PNG|JPEG] [QUALITY n]
  if (cmd === "SCREENSHOT") {
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

  // EXTRACT "<selector>" [MAXLEN n]
  if (cmd === "EXTRACT") {
    const selector = (toks[1] || "").trim();
    if (!selector) return null;
    let maxLen = 4000;
    const up = toks.map((t) => String(t).toUpperCase());
    const mi = up.indexOf("MAXLEN");
    if (mi >= 0 && toks[mi + 1] != null) {
      const n = Number(toks[mi + 1]);
      if (Number.isFinite(n)) maxLen = n;
    }
    return mk({ type: "extract_text", selector, maxLen }, `Extracting text from ${selector}.`);
  }

  // EXTRACTHTML "<selector>" [MAXLEN n]
  if (cmd === "EXTRACTHTML") {
    const selector = (toks[1] || "").trim();
    if (!selector) return null;
    let maxLen = 8000;
    const up = toks.map((t) => String(t).toUpperCase());
    const mi = up.indexOf("MAXLEN");
    if (mi >= 0 && toks[mi + 1] != null) {
      const n = Number(toks[mi + 1]);
      if (Number.isFinite(n)) maxLen = n;
    }
    return mk({ type: "extract_html", selector, maxLen }, `Extracting HTML from ${selector}.`);
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

    // "ask user" coordination (do not nuke goal here; routes handle that)
    this.awaitingUser = false;
    this.lastAskUserAt = 0;
    this.lastAskUserMsg = "";

    // LLM reliability / cooldown
    this.llmFailStreak = 0;
    this.nextAllowedLlmAt = 0;

    // decide concurrency guard
    this._decideInFlight = false;

    // --- NEW: "unsure" read-the-page loop ---
    this._readMode = {
      active: false, // if true, we are waiting for extract results
      lastReadAt: 0,
      streak: 0,
      pendingKind: "", // "text"|"html"
      pendingSelector: "",
    };
    this._lastExtractHash = "";
    this._lastGoodCommandLine = "";
    this._lastModelRaw = "";

    this.promptMode = String(AGENT_PROMPT_MODE || "default").trim().toLowerCase();
    if (!["default", "simple", "constrained"].includes(this.promptMode)) {
      this.promptMode = "default";
    }

    this.modeMaxTokens = Number(AGENT_PROMPT_MAX_TOKENS || 0) || null;
    this.modeTimeoutMs = Number(AGENT_PROMPT_TIMEOUT_MS || 0) || null;
    this.modeMaxElements = Number(AGENT_PROMPT_MAX_ELEMENTS || 0) || null;

    this.defaultMaxTokens = Number(LLM_MAX_TOKENS || 320);
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

    // reset read loop state
    this._readMode.active = false;
    this._readMode.streak = 0;
    this._readMode.pendingKind = "";
    this._readMode.pendingSelector = "";
    this._readMode.lastReadAt = 0;
    this._lastExtractHash = "";

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

    this._readMode.active = false;
    this._readMode.streak = 0;
    this._readMode.pendingKind = "";
    this._readMode.pendingSelector = "";
    this._readMode.lastReadAt = 0;
    this._lastExtractHash = "";

    this.lastSeenAt = Date.now();
  }

  /**
   * Called by /agent/correction (guidance) AND by /agent/action_result (extract results, etc)
   * Expected shape: { text, mode, ts } but we also accept { data } for robustness.
   */
  addCorrection(c) {
    const entry = typeof c === "object" && c ? c : { text: String(c ?? "") };

    // IMPORTANT: if backend passes extract data via correction, convert it to a compact text chunk.
    // (Your routes currently call addCorrection({text, mode, ts}) but you mentioned wiring action_result too.)
    let text = String(entry.text ?? "").trim();

    // If action_result is forwarded as data, try to capture it.
    if (!text && entry.data && typeof entry.data === "object") {
      const t = entry.data.type || "";
      if (t === "extract_text" || t === "extract_html") {
        const selector = String(entry.data.selector || entry.data.sel || "").slice(0, 120);
        const content = String(entry.data.text || entry.data.html || "").slice(0, 6000);
        text = `EXTRACT_RESULT ${t} selector="${selector}"\n${content}`;
      }
    }

    if (text) {
      this.corrections.push({ ...entry, text: safeStr(text, 8000) });
      // bound memory
      if (this.corrections.length > 30) this.corrections = this.corrections.slice(-30);
    }

    // any correction counts as "user responded" from the agent’s perspective
    this.awaitingUser = false;
    this.lastSeenAt = Date.now();

    // if we were waiting on read results, allow agent to proceed after results arrive
    if (text.includes("EXTRACT_RESULT")) {
      this._readMode.active = false;
      this._readMode.pendingKind = "";
      this._readMode.pendingSelector = "";
    }
  }

  _getPromptConfig() {
    const base = {
      mode: this.promptMode,
      maxTokens: this.defaultMaxTokens,
      timeoutMs: this.defaultTimeoutMs,
      maxElements: Math.min(Number(MAX_ELEMENTS || 60), 25),
    };

    if (this.promptMode === "simple") {
      base.maxTokens = 180;
      base.timeoutMs = 90_000;
      base.maxElements = 14;
    }

    if (this.promptMode === "constrained") {
      base.maxTokens = 180;
      base.timeoutMs = 90_000;
      base.maxElements = 12;
    }

    if (Number.isFinite(this.modeMaxTokens) && this.modeMaxTokens > 0) {
      base.maxTokens = clamp(Math.round(this.modeMaxTokens), 60, 1200);
    }
    if (Number.isFinite(this.modeTimeoutMs) && this.modeTimeoutMs > 0) {
      base.timeoutMs = Math.max(90_000, Math.round(this.modeTimeoutMs));
    }
    if (Number.isFinite(this.modeMaxElements) && this.modeMaxElements > 0) {
      base.maxElements = clamp(Math.round(this.modeMaxElements), 5, 50);
    }

    return base;
  }

  _buildElementLines(elements, limit, labelLen, tagLen) {
    return (elements || [])
      .slice(0, limit)
      .map((e, i) => {
        const label = String(e.text || e.ariaLabel || e.title || e.placeholder || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, labelLen);
        const role = String(e.role || "").slice(0, 16);
        const tag = String(e.tag || "").slice(0, tagLen);
        const href = e.href ? ` href="${String(e.href).slice(0, 80)}"` : "";
        const value = e.value ? ` value="${String(e.value).slice(0, 60)}"` : "";
        return `${i + 1}. ${tag}${role ? `/${role}` : ""} "${label}" (${e.x},${e.y})${href}${value}`;
      })
      .join("\n");
  }

  _buildFreeformPrompt(cfg) {
    const { url, elements = [] } = this.lastObs || { url: "", elements: [] };
    const goal = String(this.goal || "(none)").trim().slice(0, 800) || "(none)";

    const corrText = this.corrections
      .slice(-6)
      .map((c) => `- ${String(c.text || "").slice(0, 380)}`)
      .join("\n");

    const elementLines = this._buildElementLines(elements, cfg.maxElements, 80, 24);

    // Add explicit instruction for "unsure → EXTRACT body → decide"
    return `
You are a GENERAL-PURPOSE browser automation agent.
Your job: given GOAL + current URL + visible ELEMENTS, choose the SINGLE best next action to progress toward the goal.

HARD RULES:
- Output EXACTLY ONE LINE.
- The line MUST start with one command keyword.
- NO explanations, NO multi-step plans, NO extra lines.
- If you are unsure what to do next OR elements are ambiguous, you MUST first read the page using:
  EXTRACT "main" MAXLEN 4000
  If "main" fails, use: EXTRACT "body" MAXLEN 4000

PREFERRED STRATEGY:
1) Prefer CLICK <elementNumber> from the ELEMENTS list.
2) If you must target a specific DOM node, use CLICKSEL "<css selector>".
3) Use TYPESEL to fill inputs, then CLICK submit/continue.
4) Use SCROLL to reveal missing elements.
5) If you need page context to decide, use EXTRACT/EXTRACTHTML.
6) Use ASK only if the user must make a choice that cannot be inferred.

AVAILABLE COMMANDS (one line only):
- CLICK <elementNumber>
- CLICK <x> <y> [RIGHT]     (or CLICK <x>,<y>)
- CLICKSEL "<selector>" [RIGHT]
- HOVER <elementNumber>
- HOVER <x> <y>             (or HOVER <x>,<y>)
- HOVERSEL "<selector>"
- TYPE <text...>
- TYPESEL "<selector>" "<text...>" [CLEAR]
- FOCUSSEL "<selector>"
- CLEARSEL "<selector>"
- SELECT "<selector>" (VALUE|LABEL|INDEX) <value...>
- CHECKSEL "<selector>"
- UNCHECKSEL "<selector>"
- SUBMITSEL "<selector>"
- PRESS <key>
- CHORD <key1> <key2> ...
- SCROLL <dx> <dy>
- WAIT <ms>   (or: WAIT <n> s)
- GOTO <http(s)://url>
- EXTRACT "<selector>" [MAXLEN <n>]     (extract visible text)
- EXTRACTHTML "<selector>" [MAXLEN <n>] (extract HTML)
- SCREENSHOT <x> <y> <w> <h> [PNG|JPEG] [QUALITY <1-100>]
- DONE <message...>
- ASK <question...>

GOAL:
${goal}

URL (context only, do not output):
${String(url || "").slice(0, 2000)}

RECENT CONTEXT (may include EXTRACT_RESULT):
${corrText || "none"}

ELEMENTS (top ${cfg.maxElements}):
${elementLines || "none"}

OUTPUT ONE LINE NOW:
`.trim();
  }

  _loopDetect(action) {
    const key = actionKey(action);

    this.lastActions.push(key);
    if (this.lastActions.length > 10) this.lastActions.shift();

    // identical 4x in a row
    if (this.lastActions.length >= 4) {
      const tail = this.lastActions.slice(-4);
      if (tail.every((x) => x === tail[0])) return true;
    }

    // A,B,A,B pattern
    if (this.lastActions.length >= 6) {
      const t = this.lastActions.slice(-6);
      const [a, b, c, d, e, f] = t;
      if (a === c && c === e && b === d && d === f && a !== b) return true;
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

  _fallbackDecision(reason, ctx, freeformRaw = "") {
    const fallbackLine = buildFallbackCommandLine(this.goal, ctx?.elements || []);

    console.log(
      `@@LLM_ASSISTANT_COERCED@@ sessionId=${this.sessionId ?? "?"} step=${this.step} reason=${reason}\n` +
        `raw=${safeStr(String(freeformRaw || ""), 400)}\n` +
        `coerced=${fallbackLine}\n` +
        `@@END_LLM_ASSISTANT_COERCED@@`
    );

    const parsed = parseFreeformToDecision(fallbackLine, ctx);

    if (parsed?.done === true) {
      return { done: true, message: safeStr(parsed.message || "Done.", 400) };
    }

    const v = parsed ? validateAndNormalizeDecision(parsed, ctx) : null;
    if (v?.ok) {
      v.decision.requiresApproval = false;
      v.decision.explanation = safeStr(`Fallback action (${reason}).`, 200);
      return v.decision;
    }

    return {
      done: false,
      requiresApproval: false,
      action: { type: "ask_user", question: "I couldn't proceed safely. What should I click next?" },
      explanation: `Fallback ASK (${reason}).`,
    };
  }

  /**
   * Decide whether we should perform an extraction step now to "read the page".
   * This triggers when:
   *  - model output is unparseable, or looks uncertain/hedged
   *  - too many bad outputs
   *  - element list is empty/weak and we haven't extracted recently
   */
  _shouldReadPageNow({ parseFailed, schemaFailed, uncertainRaw, elementsCount }) {
    const t = Date.now();

    // avoid spamming extract
    if (t - (this._readMode.lastReadAt || 0) < 1500) return false;

    // if we're already in "read pending" state, don't start another
    if (this._readMode.active) return false;

    // if we just extracted recently, don't re-extract unless we're really stuck
    const recentExtract = t - (this._readMode.lastReadAt || 0) < 10_000;

    if (this.badOutputCount >= 2 && !recentExtract) return true;
    if ((parseFailed || schemaFailed) && !recentExtract) return true;
    if (uncertainRaw && !recentExtract) return true;

    // if no elements and we haven't extracted recently, read page
    if ((elementsCount || 0) === 0 && !recentExtract) return true;

    // if we keep looping, reading page may help find context
    if (this._readMode.streak >= 2 && !recentExtract) return true;

    return false;
  }

  /**
   * Produce a safe extraction decision.
   * Uses "main" then "body" and ramps up only a bit.
   */
  _makeReadDecision(ctx) {
    const t = Date.now();
    this._readMode.lastReadAt = t;
    this._readMode.streak = clamp((this._readMode.streak || 0) + 1, 0, 5);

    // Alternate selectors in case "main" doesn't exist.
    const selector = this._readMode.streak % 2 === 1 ? "main" : "body";
    const maxLen = this._readMode.streak >= 3 ? 7000 : 4000;

    this._readMode.active = true;
    this._readMode.pendingKind = "text";
    this._readMode.pendingSelector = selector;

    const decision = {
      done: false,
      requiresApproval: false,
      action: { type: "extract_text", selector, maxLen },
      explanation: `Reading page (${selector}) to reduce uncertainty.`,
    };

    const v = validateAndNormalizeDecision({ action: decision.action }, ctx);
    if (v?.ok) return v.decision;

    // fallback to safest possible wait
    this._readMode.active = false;
    return {
      done: false,
      requiresApproval: false,
      action: { type: "wait", ms: 800 },
      explanation: "Could not validate extract action; waiting.",
    };
  }

  async decideNextAction() {
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

      // If waiting on user input, do not decide further
      if (this.awaitingUser) {
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

        this._lastModelRaw = String(freeformRaw || "");

        if (DBG.agent) dlogBig(this.sessionId, "MODEL_RAW_FREEFORM", freeformRaw);

        // reset LLM fail streak on success
        this.llmFailStreak = 0;
        this.nextAllowedLlmAt = 0;
      } catch (e) {
        if (DBG.agent) dlog(this.sessionId, "LLM_CALL_FAILED_FREEFORM", { message: String(e?.message || e) });
        return this._cooldownFromFailure("llm_call_failed_freeform");
      }

      console.log(
        `@@LLM_ASSISTANT_RAW@@ sessionId=${this.sessionId ?? "?"} step=${this.step} stage=AgentSession\n` +
          `${safeStr(String(freeformRaw || ""), 4000)}\n` +
          `@@END_LLM_ASSISTANT_RAW@@`
      );

      // Parse model output
      const parsedDecision = parseFreeformToDecision(freeformRaw, ctx);

      const parseFailed = !parsedDecision;
      const uncertainRaw = looksLikeUncertaintyOrHedge(freeformRaw);
      const elementsCount = Array.isArray(ctx.elements) ? ctx.elements.length : 0;

      if (parseFailed) {
        this.badOutputCount += 1;
        this.corrections.push({
          text:
            "Your output could not be parsed. Output EXACTLY ONE LINE starting with a valid command, e.g. 'CLICK 12' or 'TYPESEL \"#q\" \"hello\" CLEAR' or 'SCROLL 0 800'. If unsure, use: EXTRACT \"main\" MAXLEN 4000.",
        });
        if (this.corrections.length > 30) this.corrections = this.corrections.slice(-30);

        if (DBG.agent) {
          dlog(this.sessionId, "FREEFORM_PARSE_FAILED", { sample: String(freeformRaw || "").slice(0, 220) });
        }

        // If unsure/stuck: read the page instead of random clicking
        if (this._shouldReadPageNow({ parseFailed: true, schemaFailed: false, uncertainRaw: true, elementsCount })) {
          return this._makeReadDecision(ctx);
        }

        return this._fallbackDecision("freeform_parse_failed", ctx, freeformRaw);
      }

      if (parsedDecision.done === true) {
        return { done: true, message: safeStr(parsedDecision.message || "Done.", 400) };
      }

      // validate schema
      const v = validateAndNormalizeDecision(parsedDecision, ctx);

      if (!v.ok) {
        this.badOutputCount += 1;
        this.corrections.push({
          text: `Your action failed schema validation: ${v.error}. Output a valid one-line command like 'CLICK 12' or 'CLICKSEL "#login"' or 'TYPESEL "#q" "hello" CLEAR'. If unsure, use: EXTRACT "main" MAXLEN 4000.`,
        });
        if (this.corrections.length > 30) this.corrections = this.corrections.slice(-30);

        if (DBG.agent) dlog(this.sessionId, "ACTION_SCHEMA_INVALID", { error: v.error });

        if (this._shouldReadPageNow({ parseFailed: false, schemaFailed: true, uncertainRaw, elementsCount })) {
          return this._makeReadDecision(ctx);
        }

        return this._fallbackDecision("invalid_action_schema", ctx, freeformRaw);
      }

      // If the model chose ASK, set awaitingUser and throttle repeated asks
      if (v.decision?.action?.type === "ask_user") {
        const q = String(v.decision.action.question || "").trim();
        const t = Date.now();

        // Prevent spammy repeated asks
        if (q && q === this.lastAskUserMsg && t - this.lastAskUserAt < 12_000) {
          // if it keeps asking the same thing, read page instead
          if (this._shouldReadPageNow({ parseFailed: false, schemaFailed: false, uncertainRaw: true, elementsCount })) {
            return this._makeReadDecision(ctx);
          }
          return { done: false, requiresApproval: false, action: { type: "wait", ms: 2500 }, explanation: "Avoiding repeated ASK spam." };
        }

        this.awaitingUser = true;
        this.lastAskUserAt = t;
        this.lastAskUserMsg = q;

        return v.decision;
      }

      // If model output itself looks uncertain, prefer a read step (unless it already chose extract)
      if (
        uncertainRaw &&
        v.decision?.action?.type !== "extract_text" &&
        v.decision?.action?.type !== "extract_html" &&
        this._shouldReadPageNow({ parseFailed: false, schemaFailed: false, uncertainRaw: true, elementsCount })
      ) {
        return this._makeReadDecision(ctx);
      }

      // If we chose an extract action, record so we can avoid endless extractions
      if (v.decision?.action?.type === "extract_text" || v.decision?.action?.type === "extract_html") {
        const k = actionKey(v.decision.action);
        if (k === this._lastExtractHash && Date.now() - (this._readMode.lastReadAt || 0) < 10_000) {
          // identical extract again too soon -> avoid loop; scroll instead
          const loopParsed = parseFreeformToDecision("SCROLL 0 900", ctx);
          if (loopParsed) {
            const vv = validateAndNormalizeDecision(loopParsed, ctx);
            if (vv.ok) return vv.decision;
          }
        }
        this._lastExtractHash = k;
        this._readMode.active = true;
      }

      // loop detection
      if (this._loopDetect(v.decision.action)) {
        this.corrections.push({ text: "You repeated actions without progress. First, read the page with EXTRACT \"main\" MAXLEN 4000, then choose a different action." });
        if (this.corrections.length > 30) this.corrections = this.corrections.slice(-30);

        // Prefer read page when looping
        if (this._shouldReadPageNow({ parseFailed: false, schemaFailed: false, uncertainRaw: true, elementsCount })) {
          return this._makeReadDecision(ctx);
        }

        const loopParsed = parseFreeformToDecision("SCROLL 0 900", ctx);
        if (loopParsed) {
          const vv = validateAndNormalizeDecision(loopParsed, ctx);
          if (vv.ok) return vv.decision;
        }

        return this._fallbackDecision("loop_detected", ctx, freeformRaw);
      }

      // Too many failures -> ask user (but only after attempting extraction loop)
      if (this.badOutputCount >= 4) {
        if (this._shouldReadPageNow({ parseFailed: false, schemaFailed: false, uncertainRaw: true, elementsCount })) {
          return this._makeReadDecision(ctx);
        }

        this.awaitingUser = true;
        return {
          done: false,
          requiresApproval: false,
          action: {
            type: "ask_user",
            question:
              "I’m not making progress. What do you want me to click/type next? (Tell me the exact button text or where it is on the page.)",
          },
          explanation: "Too many invalid model outputs; asking user.",
        };
      }

      // enforce approval policy (belt+suspenders)
      v.decision.requiresApproval = v.decision?.action?.type === "screenshot_region";

      // normalize wait/scroll (belt+suspenders)
      if (v.decision?.action?.type === "wait") v.decision.action.ms = safeInt(v.decision.action.ms ?? 500, 500, 0, 60_000);
      if (v.decision?.action?.type === "scroll") {
        v.decision.action.dx = safeInt(v.decision.action.dx ?? 0, 0, -2000, 2000);
        v.decision.action.dy = safeInt(v.decision.action.dy ?? 500, 500, -4000, 4000);
      }

      // keep a tiny memory of last good command line to help debugging
      const cmdLine = extractFirstCommandLine(freeformRaw);
      if (cmdLine) this._lastGoodCommandLine = cmdLine;

      console.log(
        `@@LLM_ASSISTANT_COERCED@@ sessionId=${this.sessionId ?? "?"} step=${this.step} reason=final\n` +
          `coerced=${safeStr(JSON.stringify(v.decision.action), 1200)}\n` +
          `@@END_LLM_ASSISTANT_COERCED@@`
      );

      if (DBG.agent) {
        dlog(this.sessionId, "DECIDE_RETURN", {
          actionType: v?.decision?.action?.type,
          requiresApproval: !!v?.decision?.requiresApproval,
          badOutputCount: this.badOutputCount,
          readStreak: this._readMode?.streak,
        });
      }

      return v.decision;
    } finally {
      this._decideInFlight = false;
    }
  }
}
