// src/agent/AgentSession.js
import { chatCompletion } from "../services/llm/llamaClient.js";
import { safeJsonParse } from "../services/llm/jsonGuard.js";
import { validateAndNormalizeDecision } from "./actionSchema.js";
import {
  MAX_ELEMENTS,
  // simple prompt mode (from env.js)
  AGENT_SIMPLE_PROMPT,
  AGENT_SIMPLE_MAX_TOKENS,
  AGENT_SIMPLE_TIMEOUT_MS,
  AGENT_SIMPLE_MAX_ELEMENTS,
  // (optional) reuse your existing llm knob defaults from env.js
  LLM_MAX_TOKENS,
  LLM_FAST_TIMEOUT_MS,
  LLM_REPAIR_MAX_TOKENS,
  LLM_REPAIR_TIMEOUT_MS,
} from "../config/env.js";

function truthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
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
    this.awaitingUser = false; // pause loop after ask_user until user responds
    this.lastAskUserAt = 0;
    this.lastAskUserMsg = "";

    this.llmFailStreak = 0; // exponential backoff on LLM failures
    this.nextAllowedLlmAt = 0;

    // --- simple prompt mode controls (ALL via env.js, but can be forced per-session via model="simple") ---
    this.simplePromptEnabled =
      truthy(AGENT_SIMPLE_PROMPT) || String(this.model || "") === "simple";

    this.simpleMaxTokens = Number(AGENT_SIMPLE_MAX_TOKENS || 80);
    this.simpleTimeoutMs = Number(AGENT_SIMPLE_TIMEOUT_MS || 12_000);
    this.simpleMaxElements = Number(AGENT_SIMPLE_MAX_ELEMENTS || 12);

    // --- default (non-simple) knobs also come from env.js ---
    this.defaultMaxTokens = Number(LLM_MAX_TOKENS || 320);
    this.defaultTimeoutMs = Number(LLM_FAST_TIMEOUT_MS || 25_000);
    this.repairMaxTokens = Number(LLM_REPAIR_MAX_TOKENS || 220);
    this.repairTimeoutMs = Number(LLM_REPAIR_TIMEOUT_MS || 15_000);
  }

  setObservation(obs) {
    this.lastObs = obs;
    this.lastSeenAt = Date.now();
  }

  setInstruction(text) {
    this.goal = String(text || "").trim();
    this.status = this.goal ? "running" : "idle";

    this.corrections = [];
    this.badOutputCount = 0;
    this.lastActions = [];

    // reset failure/backoff + unpause
    this.awaitingUser = false;
    this.lastAskUserAt = 0;
    this.lastAskUserMsg = "";
    this.llmFailStreak = 0;
    this.nextAllowedLlmAt = 0;

    this.lastSeenAt = Date.now();
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

    // user interacted => unpause
    this.awaitingUser = false;

    this.lastSeenAt = Date.now();
  }

  _shouldRateLimitAskUser(msg) {
    const now = Date.now();
    // If it's the same question and we asked within 15s, suppress repeating it.
    if (msg === this.lastAskUserMsg && now - this.lastAskUserAt < 15_000) return true;
    this.lastAskUserMsg = msg;
    this.lastAskUserAt = now;
    return false;
  }

  _askUser(question, explanation = "Need user input.") {
    const q =
      String(question || "What should I do next?").trim().slice(0, 400) ||
      "What should I do next?";
    if (this._shouldRateLimitAskUser(q)) {
      // Don't spam the same ask_user; just wait a bit.
      return {
        done: false,
        requiresApproval: false,
        action: { type: "wait", ms: 5000 },
        explanation: "Rate-limited repeated ask_user.",
      };
    }
    this.awaitingUser = true;
    return {
      done: false,
      requiresApproval: false,
      action: { type: "ask_user", question: q },
      explanation,
    };
  }

  _buildPrompt() {
    const { url, elements = [] } = this.lastObs || { url: "", elements: [] };

    // Keep GOAL short (prevents huge prompts from chatty users)
    const goal = String(this.goal || "(none)").trim().slice(0, 400) || "(none)";

    const corrText = this.corrections
      .slice(-3)
      .map((c) => `- (${c.mode}) ${String(c.text || "").slice(0, 180)}`)
      .join("\n");

    // Hard cap element count (even if MAX_ELEMENTS is higher)
    const effectiveMax = Math.min(Number(MAX_ELEMENTS || 40), 20);

    // Keep each line short: tag + short label + coords only
    const elementLines = elements
      .slice(0, effectiveMax)
      .map((e, i) => {
        const label = String(e.text || e.ariaLabel || e.title || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 50);
        return `${i + 1}. ${String(e.tag || "").slice(0, 20)} "${label}" @ (${e.x},${e.y})`;
      })
      .join("\n");

    // Deterministic playbook hint for language/locale tasks (reduces LLM wandering)
    const languagePlaybook = `
If the goal is about changing language/locale:
- Look for items containing: Language, Lang, Locale, Settings, Preferences, Account, Region, Español, English, Français, Deutsch.
- If a menu/profile/hamburger exists, open it first, then find language/settings.
- Prefer ONE action per step.
- If you can't find it after 2 attempts, ask_user a specific question (e.g., "Do you want English or Spanish?").
`.trim();

    return `
GOAL (current instruction):
${goal}

CURRENT URL:
${String(url || "").slice(0, 2000)}

RECENT CORRECTIONS (if any):
${corrText || "none"}

CLICKABLE ELEMENTS (top ${effectiveMax}):
${elementLines || "none"}

TASK:
You control a browser to achieve the GOAL.

${languagePlaybook}

Return ONLY JSON. Two possible outputs:

1) DONE:
{ "done": true, "message": "Short confirmation." }

2) ACTION:
{
  "done": false,
  "requiresApproval": false,
  "action": { "type": "click", "x": 123, "y": 456 },
  "explanation": "Short explanation"
}

Allowed action.type:
click, hover, type, type_in_selector, select, press_key, scroll, goto, wait, screenshot_region, ask_user

Rules:
- Prefer autonomous actions (requiresApproval false) except screenshot_region.
- Only set requiresApproval true if action.type is screenshot_region.
- If you cannot proceed, use ask_user with a clear, specific question.
- Output ONLY JSON. No markdown. No extra text.
`.trim();
  }

  /**
   * Simple prompt:
   * - very short
   * - asks for exactly ONE action (no DONE path unless truly done)
   * - fewer elements
   * - shorter strings
   */
  _buildSimplePrompt() {
    const { url, elements = [] } = this.lastObs || { url: "", elements: [] };

    const goal = String(this.goal || "(none)").trim().slice(0, 220) || "(none)";

    const corrText = this.corrections
      .slice(-2)
      .map((c) => `- ${String(c.text || "").slice(0, 120)}`)
      .join("\n");

    const effectiveMax = Math.min(
      Math.min(Number(MAX_ELEMENTS || 40), 20),
      Math.max(4, Number(this.simpleMaxElements || 12))
    );

    const elementLines = elements
      .slice(0, effectiveMax)
      .map((e, i) => {
        const label = String(e.text || e.ariaLabel || e.title || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 40);
        return `${i + 1}. ${String(e.tag || "").slice(0, 12)} "${label}" (${e.x},${e.y})`;
      })
      .join("\n");

    return `
GOAL:
${goal}

URL:
${String(url || "").slice(0, 600)}

CORRECTIONS:
${corrText || "none"}

ELEMENTS:
${elementLines || "none"}

Return ONLY JSON, and choose EXACTLY ONE:

A) DONE (only if goal already satisfied):
{ "done": true, "message": "Done." }

B) ONE ACTION (no extra keys, short explanation <= 10 words):
{
  "done": false,
  "requiresApproval": false,
  "action": { "type": "click", "x": 0, "y": 0 },
  "explanation": "..."
}

Allowed action.type:
click, type, press_key, scroll, goto, wait, ask_user

Rules:
- Prefer click if possible.
- ONE action only.
- If uncertain, ask_user one short question.
`.trim();
  }

  _buildRepairPrompt(rawText) {
    return `
Output ONLY valid JSON.

Correct it into one of the two valid shapes:

DONE shape:
{ "done": true, "message": "..." }

ACTION shape:
{
  "done": false,
  "requiresApproval": false,
  "action": { "type": "...", "...": "..." },
  "explanation": "..."
}

Previous output:
${String(rawText || "").slice(0, 4000)}
`.trim();
  }

  _loopDetect(action) {
    const key = JSON.stringify(action);
    this.lastActions.push(key);
    if (this.lastActions.length > 6) this.lastActions.shift();
    if (this.lastActions.length >= 4) {
      const tail = this.lastActions.slice(-4);
      if (tail.every((x) => x === tail[0])) return true;
    }
    return false;
  }

  async decideNextAction() {
    // If we recently asked the user something, pause instead of spamming.
    if (this.awaitingUser) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "wait", ms: 5000 },
        explanation: "Waiting for user response.",
      };
    }

    // If no observation yet, ask once and pause.
    if (!this.lastObs) {
      return this._askUser(
        "Start the session stream first, then give me an instruction.",
        "No observation yet."
      );
    }

    // If idle/no goal -> ask once and pause
    if (this.status !== "running" || !this.goal) {
      return this._askUser("I’m idle. What should I do next?", "Waiting for instruction.");
    }

    // Backoff window after repeated failures
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

    const useSimple = !!this.simplePromptEnabled;
    const prompt = useSimple ? this._buildSimplePrompt() : this._buildPrompt();

    let raw = "";

    // Primary LLM call (cheap + fast)
    try {
      raw = await chatCompletion({
        prompt,
        temperature: 0,
        maxTokens: useSimple ? this.simpleMaxTokens : this.defaultMaxTokens,
        timeoutMs: useSimple ? this.simpleTimeoutMs : this.defaultTimeoutMs,
      });
      // success resets failure streak
      this.llmFailStreak = 0;
    } catch (e) {
      this.llmFailStreak += 1;
      const waitMs = Math.min(60_000, 2_000 * Math.pow(2, this.llmFailStreak)); // 2s,4s,8s,... up to 60s
      this.nextAllowedLlmAt = Date.now() + waitMs;

      return this._askUser(
        `LLM error: ${String(e?.message || e)}. I will pause for ${Math.round(
          waitMs / 1000
        )}s. Want me to keep trying, or switch to manual guidance?`,
        "LLM call failed."
      );
    }

    let parsed = safeJsonParse(raw);

    // One repair attempt (also cheap)
    if (!parsed.ok) {
      const repairPrompt = this._buildRepairPrompt(raw);
      try {
        const raw2 = await chatCompletion({
          prompt: repairPrompt,
          temperature: 0,
          maxTokens: useSimple
            ? Math.max(40, Math.floor(this.simpleMaxTokens * 0.75))
            : this.repairMaxTokens,
          timeoutMs: useSimple
            ? Math.max(6000, Math.floor(this.simpleTimeoutMs * 0.75))
            : this.repairTimeoutMs,
        });
        parsed = safeJsonParse(raw2);
        raw = raw2;
      } catch (e) {
        return this._askUser(
          `Repair failed: ${String(e?.message || e)}. Rephrase the instruction or guide the next click.`,
          "Could not repair JSON."
        );
      }
    }

    if (!parsed.ok) {
      this.badOutputCount++;
      return this._askUser(
        "Model returned invalid JSON. Please restate the instruction more simply (one step), or tell me what to click next.",
        "Invalid JSON."
      );
    }

    const obj = parsed.value || {};

    // DONE path
    if (obj.done === true) {
      return { done: true, message: String(obj.message || "Done.").slice(0, 400) };
    }

    // ACTION path (schema validation)
    const v = validateAndNormalizeDecision(obj, ctx);
    if (!v.ok) {
      this.badOutputCount++;
      return this._askUser(
        `Invalid action from model (${v.error}). Tell me the next step (e.g., "open settings", "click language", "scroll").`,
        "Invalid action schema."
      );
    }

    // loop detection
    if (this._loopDetect(v.decision.action)) {
      return this._askUser(
        "I may be stuck in a loop. Should I try a different menu, scroll, or search?",
        "Loop detected."
      );
    }

    // too many bad outputs => pause + ask for simpler instruction
    if (this.badOutputCount >= 3) {
      this.awaitingUser = true;
      return this._askUser(
        "I’m getting inconsistent outputs. Please rephrase as a single small step (e.g., “Open the site menu”, “Click Settings”, “Select English”).",
        "Too many invalid outputs."
      );
    }

    return v.decision;
  }
}
