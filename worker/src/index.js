// src/index.js
import { PORT, HOST } from "./config/env.js";
import { createServer } from "./server.js";

createServer({ port: PORT, host: HOST });