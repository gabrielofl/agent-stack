// src/agent/AgentSession.js
import { chatCompletion } from "../services/llm/llamaClient.js";
import { safeJsonParse } from "../services/llm/jsonGuard.js";
import { validateAndNormalizeDecision } from "./actionSchema.js";
import { MAX_ELEMENTS } from "../config/env.js";

export class AgentSession {
  constructor({ sessionId, goal, model }) {
    this.sessionId = sessionId;
    this.goal = goal;
    this.model = model || "default";
    this.lastObs = null;
    this.corrections = [];
    this.step = 0;

    // Useful for robustness:
    this.badOutputCount = 0;
    this.lastActions = []; // rolling window for loop detection
    this.lastSeenAt = Date.now();
  }

  setObservation(obs) {
    this.lastObs = obs;
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
GOAL:
${this.goal}

CURRENT URL:
${url}

RECENT CORRECTIONS (if any):
${corrText || "none"}

CLICKABLE ELEMENTS (use these coords if clicking/hovering):
${elementLines || "none"}

TASK:
Pick the best next action to move toward the goal.
Return ONLY valid JSON with this shape:

{
  "requiresApproval": false,
  "action": { "type": "click", "x": 123, "y": 456 }
}

Allowed action.type and shapes:

- click:
  { "type":"click","x":123,"y":456,"button":"left|right" }

- hover:
  { "type":"hover","x":123,"y":456 }
  OR { "type":"hover","selector":"CSS_SELECTOR" }

- type:
  { "type":"type","text":"..." }

- type_in_selector:
  { "type":"type_in_selector","selector":"CSS_SELECTOR","text":"...","clearFirst":true }

- select:
  { "type":"select","selector":"CSS_SELECTOR","value":"..." }
  OR { "type":"select","selector":"CSS_SELECTOR","label":"..." }
  OR { "type":"select","selector":"CSS_SELECTOR","index":0 }

- press_key:
  { "type":"press_key","key":"Enter|Tab|ArrowDown|Control+A|..." }

- scroll:
  { "type":"scroll","dx":0,"dy":800 }

- goto:
  { "type":"goto","url":"https://example.com" }  (http/https only)

- wait:
  { "type":"wait","ms":1000 }  (0..60000)

- screenshot_region:
  { "type":"screenshot_region","x":10,"y":10,"w":400,"h":200,"format":"png" }
  (Note: screenshot_region will require approval by policy)

- ask_user:
  { "type":"ask_user","question":"..." } (use if uncertain)

Rules:
- Output ONLY JSON. No markdown. No extra text.
- If uncertain or missing info, use ask_user.
`.trim();
  }

  _buildRepairPrompt(rawText) {
    return `
You must output ONLY valid JSON, no extra text.

Your previous output was invalid or not matching the required schema.
Fix it by returning ONLY a valid JSON object with:

{
  "requiresApproval": false,
  "action": {
    "type": "click|hover|type|type_in_selector|select|press_key|scroll|goto|wait|screenshot_region|ask_user",
    "...": "fields required by that type"
  }
}

Previous output:
${rawText}
`.trim();
  }

  _loopDetect(action) {
    const key = JSON.stringify(action);
    this.lastActions.push(key);
    if (this.lastActions.length > 6) this.lastActions.shift();

    // If last 4 actions are identical -> likely stuck
    if (this.lastActions.length >= 4) {
      const tail = this.lastActions.slice(-4);
      if (tail.every((x) => x === tail[0])) return true;
    }
    return false;
  }

  async decideNextAction() {
    if (!this.lastObs) {
      return {
        requiresApproval: true,
        action: {
          type: "ask_user",
          question: "No observation yet. Start the session stream first.",
        },
      };
    }

    const ctx = {
      viewport: this.lastObs.viewport,
      url: this.lastObs.url,
      elements: this.lastObs.elements || [],
    };

    // 1) Primary attempt
    const prompt = this._buildPrompt();
    let raw = "";
    try {
      raw = await chatCompletion({ prompt });
    } catch (e) {
      return {
        requiresApproval: true,
        action: {
          type: "ask_user",
          question: `LLM error: ${String(e?.message || e)}. What should I do next?`,
        },
      };
    }

    // Parse (tolerant)
    let parsed = safeJsonParse(raw);
    if (!parsed.ok) {
      // 2) Repair attempt
      const repairPrompt = this._buildRepairPrompt(raw);
      try {
        const raw2 = await chatCompletion({ prompt: repairPrompt, temperature: 0.0 });
        parsed = safeJsonParse(raw2);
        raw = raw2;
      } catch (e) {
        return {
          requiresApproval: true,
          action: {
            type: "ask_user",
            question: `Could not parse model output and repair failed (${String(
              e?.message || e
            )}). What should I do next?`,
          },
        };
      }
    }

    if (!parsed.ok) {
      this.badOutputCount++;
      return {
        requiresApproval: true,
        action: {
          type: "ask_user",
          question:
            "Model output was not valid JSON after repair. Please provide guidance or re-try.",
        },
      };
    }

    // Validate & normalize action (firewall)
    const v = validateAndNormalizeDecision(parsed.value, ctx);
    if (!v.ok) {
      this.badOutputCount++;
      return {
        requiresApproval: true,
        action: {
          type: "ask_user",
          question: `Model produced an invalid action (${v.error}). What should I do instead?`,
        },
      };
    }

    // Loop detection -> ask user
    if (this._loopDetect(v.decision.action)) {
      return {
        requiresApproval: true,
        action: {
          type: "ask_user",
          question:
            "I seem to be repeating the same action and may be stuck. What should I try next?",
        },
      };
    }

    // If too many bad outputs in a row, become more conservative
    if (this.badOutputCount >= 3) {
      return {
        requiresApproval: true,
        action:
          v.decision.action.type === "ask_user"
            ? v.decision.action
            : {
                type: "ask_user",
                question:
                  "I’ve had multiple invalid outputs recently. Can you confirm the next step you want?",
              },
      };
    }

    return v.decision;
  }
}
