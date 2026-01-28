import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import cors from "cors";

const app = express();
app.use(cors({ origin: true })); // MVP: allow all origins (tighten later)
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
