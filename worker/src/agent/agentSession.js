// src/agent/AgentSession.js
import { chatCompletion } from "../services/llm/llamaClient.js";
import { safeJsonParse } from "../services/llm/jsonGuard.js";
import { validateAndNormalizeDecision } from "./actionSchema.js";
import { MAX_ELEMENTS } from "../config/env.js";

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
  }

  setObservation(obs) {
    this.lastObs = obs;
    this.lastSeenAt = Date.now();
  }

  setInstruction(text) {
    this.goal = String(text || "").trim();
    this.status = this.goal ? "running" : "idle";
    this.corrections = []; // optional: clear old guidance per new task
    this.badOutputCount = 0;
    this.lastActions = [];
    this.lastSeenAt = Date.now();
  }

  setIdle() {
    this.status = "idle";
    this.goal = "";
    this.corrections = [];
    this.badOutputCount = 0;
    this.lastActions = [];
    this.lastSeenAt = Date.now();
  }

  addCorrection(c) {
    this.corrections.push(c);
    this.lastSeenAt = Date.now();
  }

  _buildPrompt() {
    const { url, elements = [] } = this.lastObs || { url: "", elements: [] };

    const corrText = this.corrections
      .slice(-3)
      .map((c) => `- (${c.mode}) ${c.text}`)
      .join("\n");

    const elementLines = elements
      .slice(0, MAX_ELEMENTS)
      .map(
        (e, i) =>
          `${i + 1}. ${e.tag} "${(e.text || "").slice(0, 80)}" @ (${e.x},${e.y}) [${e.w}x${e.h}]`
      )
      .join("\n");

    return `
GOAL (current instruction):
${this.goal || "(none)"}

CURRENT URL:
${url}

RECENT CORRECTIONS (if any):
${corrText || "none"}

CLICKABLE ELEMENTS:
${elementLines || "none"}

TASK:
You are controlling a browser to achieve the GOAL.

Return ONLY JSON. Two possible outputs:

1) If the goal is already achieved:
{
  "done": true,
  "message": "Short confirmation of what you did / verified."
}

2) If you need to take an action:
{
  "done": false,
  "requiresApproval": false,
  "action": { "type": "click", "x": 123, "y": 456 },
  "explanation": "Short explanation"
}

Allowed action.type:
click, hover, type, type_in_selector, select, press_key, scroll, goto, wait, screenshot_region, ask_user

Rules:
- Prefer acting autonomously (requiresApproval should be false for normal actions).
- Only set requiresApproval true if the action is screenshot_region.
- If you cannot proceed, use ask_user with a clear question.
- Output ONLY JSON. No markdown.
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
${rawText}
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
    // If no observation yet, do not spam approvals: just ask user (no approval needed later)
    if (!this.lastObs) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "ask_user", question: "Start the session stream first, then give me an instruction." },
        explanation: "No observation yet.",
      };
    }

    // If idle / no goal -> do nothing (router will suppress proposals too)
    if (this.status !== "running" || !this.goal) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "ask_user", question: "I’m idle. What should I do next?" },
        explanation: "Waiting for instruction.",
      };
    }

    const ctx = {
      viewport: this.lastObs.viewport,
      url: this.lastObs.url,
      elements: this.lastObs.elements || [],
    };

    const prompt = this._buildPrompt();
    let raw = "";

    try {
      raw = await chatCompletion({ prompt });
    } catch (e) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "ask_user", question: `LLM error: ${String(e?.message || e)}. What should I do next?` },
        explanation: "LLM call failed.",
      };
    }

    let parsed = safeJsonParse(raw);
    if (!parsed.ok) {
      const repairPrompt = this._buildRepairPrompt(raw);
      try {
        const raw2 = await chatCompletion({ prompt: repairPrompt, temperature: 0.0 });
        parsed = safeJsonParse(raw2);
        raw = raw2;
      } catch (e) {
        return {
          done: false,
          requiresApproval: false,
          action: { type: "ask_user", question: `Repair failed: ${String(e?.message || e)}. What should I do next?` },
          explanation: "Could not repair JSON.",
        };
      }
    }

    if (!parsed.ok) {
      this.badOutputCount++;
      return {
        done: false,
        requiresApproval: false,
        action: { type: "ask_user", question: "Model returned invalid JSON. Please restate the instruction or provide guidance." },
        explanation: "Invalid JSON.",
      };
    }

    const obj = parsed.value || {};

    // DONE path
    if (obj.done === true) {
      return { done: true, message: String(obj.message || "Done.") };
    }

    // ACTION path
    const v = validateAndNormalizeDecision(obj, ctx);
    if (!v.ok) {
      this.badOutputCount++;
      return {
        done: false,
        requiresApproval: false,
        action: { type: "ask_user", question: `Invalid action from model (${v.error}). How should I proceed?` },
        explanation: "Invalid action schema.",
      };
    }

    if (this._loopDetect(v.decision.action)) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "ask_user", question: "I may be stuck in a loop. Should I try a different menu / scroll / search?" },
        explanation: "Loop detected.",
      };
    }

    if (this.badOutputCount >= 3) {
      return {
        done: false,
        requiresApproval: false,
        action: { type: "ask_user", question: "I’m getting inconsistent outputs. Can you confirm the next step or rephrase the instruction?" },
        explanation: "Too many invalid outputs.",
      };
    }

    return v.decision;
  }
}
