// src/services/sessionLifecycle.js (ESM)
import WebSocket from "ws";
import { chromium } from "playwright";

import { sessions } from "./sessionStore.js";
import { fetchFn } from "./fetch.js";
import {
  AGENT_OBS_MIN_INTERVAL_MS,
  WORKER_HTTP,
  AUTO_START_AGENT,
  AUTO_GOAL,
} from "../config/env.js";

import { extractClickableElements, broadcastToViewers } from "./pageHelpers.js";
import { ensureWorkerStream } from "./workerStream.js";

export async function closeSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  // stop streaming interval
  try {
    clearInterval(sess.interval);
  } catch {}

  // stop worker reconnect timer
  try {
    if (sess.workerReconnectTimer) clearTimeout(sess.workerReconnectTimer);
  } catch {}

  // close worker ws
  try {
    if (sess.workerWs && sess.workerWs.readyState === WebSocket.OPEN) sess.workerWs.close();
  } catch {}

  // close all client viewers
  try {
    for (const ws of sess.clients) {
      try {
        ws.close();
      } catch {}
    }
  } catch {}

  // close browser resources
  try {
    await sess.context?.close();
  } catch {}
  try {
    await sess.browser?.close();
  } catch {}

  sessions.delete(sessionId);
}

export async function createSession({ sessionId, startUrl }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const viewport = { width: 1280, height: 720, deviceScaleFactor: 1 };

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
  });

  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const clients = new Set();

  // Store session before interval starts (so interval can find it safely)
  sessions.set(sessionId, {
    browser,
    context,
    page,
    viewport,
    clients,
    interval: null,
    agent: null,
    workerWs: null,
    workerConnecting: null,
    workerReconnectTimer: null,
    workerBackoffMs: 500,
  });

  // AUTO-START AGENT (MVP) — identical to your original behavior
  if (AUTO_START_AGENT) {
    const sess = sessions.get(sessionId);
    sess.agent = {
      running: true,
      goal: AUTO_GOAL,
      model: "default",
      lastObsAt: 0,
      pendingApprovals: new Map(),
    };

    // best effort: connect worker ws
    ensureWorkerStream(sessionId).catch(() => {});

    // start worker session
    fetchFn(`${WORKER_HTTP}/agent/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, goal: AUTO_GOAL, model: "default" }),
    }).catch(() => {});
  }

  // Stream screenshots at ~2 fps (and agent observations at 1Hz)
  const interval = setInterval(async () => {
    const sess = sessions.get(sessionId);
    if (!sess) return;

    // Agent observation tick (small payload)
    try {
      if (sess.agent?.running) {
        const now = Date.now();
        if (!sess.agent.lastObsAt || now - sess.agent.lastObsAt > AGENT_OBS_MIN_INTERVAL_MS) {
          sess.agent.lastObsAt = now;

          const elements = await extractClickableElements(page);

          broadcastToViewers(sess, {
            type: "agent_elements",
            sessionId,
            elements,
            ts: now,
          });

          fetchFn(`${WORKER_HTTP}/agent/observe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              obsId: `obs-${now}`,
              url: page.url(),
              viewport: sess.viewport,
              elements,
              ts: now,
            }),
          }).catch(() => {});
        }
      }
    } catch {
      // ignore observe errors
    }

    // Frame streaming tick
    try {
      const jpeg = await page.screenshot({ type: "jpeg", quality: 60 });
      const img = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

      const payload = JSON.stringify({
        type: "frame",
        sessionId,
        img,
        viewport: sess.viewport,
        url: page.url(),
        ts: Date.now(),
      });

      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    } catch {
      // ignore streaming errors (page might be navigating/closing)
    }
  }, 500);

  sessions.get(sessionId).interval = interval;

  return { viewport };
}
