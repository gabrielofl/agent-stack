import { chatCompletion } from "./llamaClient.js";

export class AgentSession {
  constructor({ sessionId, goal, model }) {
    this.sessionId = sessionId;
    this.goal = goal;
    this.model = model || "default";
    this.lastObs = null;
    this.corrections = [];
    this.step = 0;
  }

  setObservation(obs) { this.lastObs = obs; }

  addCorrection(c) { this.corrections.push(c); }

  async decideNextAction() {
    if (!this.lastObs) {
  return { requiresApproval: true, action: { type: "ask_user", question: "No observation yet. Start the session stream first." } };
}


    const { url, elements = [] } = this.lastObs;

    const corrText = this.corrections.slice(-3).map(c => `- (${c.mode}) ${c.text}`).join("\n");

    const elementLines = elements.slice(0, 40).map((e, i) =>
      `${i+1}. ${e.tag} "${e.text}" @ (${e.x},${e.y}) [${e.w}x${e.h}]`
    ).join("\n");

    const prompt = `
GOAL:
${this.goal}

CURRENT URL:
${url}

RECENT CORRECTIONS (if any):
${corrText || "none"}

CLICKABLE ELEMENTS (choose ONE):
${elementLines || "none"}

TASK:
Pick the best next action to move toward the goal.
Return ONLY valid JSON with this shape:

{
  "requiresApproval": false,
  "action": { "type": "click", "x": 123, "y": 456 }
}

Allowed action.type: click, type, goto, wait, ask_user.
If you are uncertain, return ask_user with a question.
`.trim();

    const raw = await chatCompletion({ prompt });

    // Try parse JSON safely
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      // If model outputs extra text, fall back
      return { requiresApproval: true, action: { type: "ask_user", question: "Model output was not JSON. Please re-try or correct." } };
    }

    return obj;
  }
}
