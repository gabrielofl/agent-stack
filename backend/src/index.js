import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import cors from "cors";
import crypto from "crypto";

const app = express();

const ALLOWED_ORIGINS = new Set([
  "https://purple-smoke-02e25d403.1.azurestaticapps.net",
]);

app.use(cors({
  origin: (origin, cb) => {
    // allow same-origin / server-to-server / curl (no Origin header)
    if (!origin) return cb(null, true);
    return cb(null, ALLOWED_ORIGINS.has(origin));
  }
}));

app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// In-memory session store (MVP). One container replica = OK.
const sessions = new Map(); // sessionId -> { browser, context, page, viewport, clients:Set, interval, lastFrame }

function newId() {
  return Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

app.post("/sessions", async (req, res) => {
  const sessionId = newId();
  const startUrl = req.body?.url || "https://example.com";

  // Launch a real browser (headless) + page
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const clients = new Set();
  const viewport = { width: 1280, height: 720, deviceScaleFactor: 1 };

  // Stream screenshots at ~2 fps (tune later)
  const interval = setInterval(async () => {
    try {
      const jpeg = await page.screenshot({ type: "jpeg", quality: 60 });
      const img = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

      const payload = JSON.stringify({
        type: "frame",
        sessionId,
        img,
        viewport,
        url: page.url(),
        ts: Date.now(),
      });

      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(payload);
      }
    } catch (e) {
      // If page is closed during shutdown etc.
      // Avoid crashing the process due to a streaming tick.
    }
  }, 500);

  sessions.set(sessionId, { browser, context, page, viewport, clients, interval });

  res.json({
    sessionId,
    wsPath: `/ws?sessionId=${sessionId}`,
    url: startUrl,
    viewport,
  });
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString("hex");

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.post("/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: "ADMIN_PASSWORD not set" });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "invalid_password" });
  res.json({ token: ADMIN_TOKEN });
});

app.get("/admin/me", requireAdmin, (req, res) => {
  res.json({ ok: true, role: "admin" });
});


const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId || !sessions.has(sessionId)) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid sessionId" }));
    ws.close();
    return;
  }

  const sess = sessions.get(sessionId);
  sess.clients.add(ws);

  ws.send(JSON.stringify({ type: "hello", sessionId, message: "Connected. Streaming frames." }));

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    try {
      if (msg.type === "user_click") {
        const { x, y, button } = msg;
        await sess.page.mouse.click(x, y, { button: button || "left" });
        ws.send(JSON.stringify({ type: "ack", action: "user_click", x, y }));
      } else if (msg.type === "user_type") {
        // send keys to the page (types wherever focus is)
        await sess.page.keyboard.type(msg.text || "");
        ws.send(JSON.stringify({ type: "ack", action: "user_type" }));
      } else if (msg.type === "goto") {
        await sess.page.goto(msg.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        ws.send(JSON.stringify({ type: "ack", action: "goto", url: msg.url }));
      } else if (msg.type === "close_session") {
        await closeSession(sessionId);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: String(e?.message || e) }));
    }
  });

  ws.on("close", async () => {
    sess.clients.delete(ws);
    // Optional: if nobody watching, you could auto-close after N mins.
  });
});

async function closeSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  clearInterval(sess.interval);
  try { await sess.context.close(); } catch {}
  try { await sess.browser.close(); } catch {}
  sessions.delete(sessionId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend listening on 0.0.0.0:${PORT}`);
});
