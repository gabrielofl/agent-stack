// src/services/sessionLifecycle.js  (BACKEND - where you trigger /agent/observe)
// Fixes:
// - Do NOT keep sending observations while the worker is busy / backoffing
// - Add an inflight guard so you never have multiple /observe requests in flight
// - Use a slightly lower frequency for element extraction (it’s expensive)
// - Time out /observe fetch so a stuck worker doesn’t accumulate pending promises

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

function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(t) };
}

export async function closeSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  try { clearInterval(sess.interval); } catch {}
  try { if (sess.workerReconnectTimer) clearTimeout(sess.workerReconnectTimer); } catch {}
  try { if (sess.workerWs && sess.workerWs.readyState === WebSocket.OPEN) sess.workerWs.close(); } catch {}

  try {
    for (const ws of sess.clients) {
      try { ws.close(); } catch {}
    }
  } catch {}

  try { await sess.context?.close(); } catch {}
  try { await sess.browser?.close(); } catch {}

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

    // NEW: observe pacing / backpressure
    _observeInflight: false,
    _observeCooldownUntil: 0,
    _lastElementsAt: 0,
  });

  if (AUTO_START_AGENT) {
    const sess = sessions.get(sessionId);
    sess.agent = {
      running: true,
      goal: AUTO_GOAL,
      model: "default",
      lastObsAt: 0,
      pendingApprovals: new Map(),
    };

    ensureWorkerStream(sessionId).catch(() => {});

    fetchFn(`${WORKER_HTTP}/agent/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, goal: AUTO_GOAL, model: "default" }),
    }).catch(() => {});
  }

  const interval = setInterval(async () => {
    const sess = sessions.get(sessionId);
    if (!sess) return;

    // Agent observation tick
    try {
      if (sess.agent?.running) {
        const now = Date.now();

        // If we are cooling down due to worker slowness, skip
        if (now < (sess._observeCooldownUntil || 0)) {
          // still stream frames, just skip observe
        } else if (!sess._observeInflight && (!sess.agent.lastObsAt || now - sess.agent.lastObsAt > AGENT_OBS_MIN_INTERVAL_MS)) {
          sess.agent.lastObsAt = now;

          // Elements extraction is expensive; optionally cap it to e.g. >= 800ms
          const minElemInterval = Math.max(800, Number(AGENT_OBS_MIN_INTERVAL_MS || 1000));
          let elements = [];
          if (!sess._lastElementsAt || now - sess._lastElementsAt > minElemInterval) {
            sess._lastElementsAt = now;
            elements = await extractClickableElements(page);
          }

          broadcastToViewers(sess, {
            type: "agent_elements",
            sessionId,
            elements,
            ts: now,
          });

          // Mark inflight so we don't stack up observe requests
          sess._observeInflight = true;

          const { controller, done } = withTimeout(10_000); // if worker is overloaded, don't hang forever
          fetchFn(`${WORKER_HTTP}/agent/observe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              sessionId,
              obsId: `obs-${now}`,
              url: page.url(),
              viewport: sess.viewport,
              elements,
              ts: now,
            }),
          })
            .catch(() => {
              // if worker is timing out, cool down a bit so we don't keep hammering it
              sess._observeCooldownUntil = Date.now() + 3000;
            })
            .finally(() => {
              done();
              sess._observeInflight = false;
            });
        }
      }
    } catch {
      // ignore observe errors
      sess._observeInflight = false;
    }

    // Frame streaming tick (still every 500ms)
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
      // ignore streaming errors
    }
  }, 500);

  sessions.get(sessionId).interval = interval;
  return { viewport };
}
