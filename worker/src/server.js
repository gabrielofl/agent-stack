// src/server.js
import { createApp } from "./app.js";
import { attachAgentStreamWs } from "./ws/agentStreamWs.js";

export function createServer({ port, host }) {
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`worker-agent listening on ${host}:${port}`);
  });

  attachAgentStreamWs(server);
  return server;
}
