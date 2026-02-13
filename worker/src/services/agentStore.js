// src/services/agentStore.js
// Worker-side in-memory store: sessionId -> AgentSession
export const sessions = new Map();

/**
 * Optional helper (safe + tiny):
 * - avoids repeated "if (!sess)" boilerplate in routes
 */
export function getAgentSession(sessionId) {
  return sessions.get(sessionId) || null;
}
