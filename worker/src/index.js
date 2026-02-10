// src/index.js
import { PORT, HOST } from "./config/env.js";
import { createServer } from "./server.js";
import { initLlmStatusBroadcaster } from "./services/llmStatus.js";

initLlmStatusBroadcaster();
createServer({ port: PORT, host: HOST });