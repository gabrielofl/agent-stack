// src/index.js (ESM)
import { createServer } from "./server.js";
import { HOST, PORT, ADMIN_TOKEN } from "./config/env.js";

const server = createServer();

server.listen(PORT, HOST, () => {
  console.log(`Backend listening on ${HOST}:${PORT}`);
  console.log(`Admin token (server): ${ADMIN_TOKEN}`);
});
