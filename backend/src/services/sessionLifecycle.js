// src/services/sessionLifecycle.js
// BACKEND - where you trigger /agent/observe
//
// Goals:
// - Never spam observations while worker is busy / failing
// - Never have multiple /observe in flight
// - Reduce element extraction frequency (expensive)
// - Add timeout to /observe fetch
// - Keep frame streaming independent (still smooth UX)

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

import {
  extractClickableElements,
  broadcastToViewers,
  hashElements,
} from "./pageHelpers.js";
import { ensureWorkerStream } from "./workerStream.js";
import { loadStorageState, saveStorageState } from "./storageStateBlob.js";

function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(t) };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export async function closeSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  try { clearInterval(sess.interval); } catch {}
  try { clearInterval(sess._frameInterval); } catch {}
  try { if (sess.workerReconnectTimer) clearTimeout(sess.workerReconnectTimer); } catch {}
  try { if (sess.workerWs && sess.workerWs.readyState === WebSocket.OPEN) sess.workerWs.close(); } catch {}
  try { if (sess._persistTimer) clearInterval(sess._persistTimer); } catch {}
  try { await saveStorageState(sessionId, sess.context); } catch {}
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
	const storageState = await loadStorageState(sessionId);

  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const viewport = { width: 1280, height: 720, deviceScaleFactor: 1 };

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
	deviceScaleFactor: viewport.deviceScaleFactor,
	storageState: storageState || undefined,
  });

  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

	const persistTimer = setInterval(() => {
    saveStorageState(sessionId, context).catch(() => {});
	}, 100_000);
	
  const clients = new Set();

  sessions.set(sessionId, {
    browser,
    context,
    page,
    viewport,
    clients,

    interval: null,
	_frameInterval: null,
	_persistTimer: persistTimer,

    agent: null,
    workerWs: null,
    workerConnecting: null,
    workerReconnectTimer: null,

    // observe pacing / backpressure
    _observeInflight: false,
    _observeCooldownUntil: 0,
	_observeBackoffMs: 0, // adaptive
	
	_lastFrameImg: "",
	_lastFrameAt: 0,

    // elements caching
    _lastElementsAt: 0,
    _cachedElements: [],
    _cachedElementsHash: "",
  });

  // Auto agent start
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

  /**
   * Separate frame streaming (fast) from agent observe (slower & backpressured).
   */

  // 1) Frame stream @ 500ms
  const frameInterval = setInterval(async () => {
  const sess = sessions.get(sessionId);
  if (!sess) return;

  try {
    const jpeg = await sess.page.screenshot({ type: "jpeg", quality: 60 });
    const img = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

    // ✅ cache for agent observe to reuse (no extra screenshot cost)
    sess._lastFrameImg = img;
    sess._lastFrameAt = Date.now();

    const payload = JSON.stringify({
      type: "frame",
      sessionId,
      img,
      viewport: sess.viewport,
      url: sess.page.url(),
      ts: Date.now(),
    });

    for (const ws of sess.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  } catch {
    // ignore streaming errors
  }
}, 500);

  sessions.get(sessionId)._frameInterval = frameInterval;

  // 2) Observe tick (paced)
  const interval = setInterval(async () => {
    const sess = sessions.get(sessionId);
    if (!sess) return;
    if (!sess.agent?.running) return;

    const now = Date.now();

    // cooldown/backoff gate
    if (now < (sess._observeCooldownUntil || 0)) return;

    // inflight guard
    if (sess._observeInflight) return;

    // minimum interval gate (agent side)
    const minObs = Math.max(250, Number(AGENT_OBS_MIN_INTERVAL_MS || 1000));
    if (sess.agent.lastObsAt && now - sess.agent.lastObsAt < minObs) return;

    sess.agent.lastObsAt = now;

    // Element extraction is expensive: throttle separately (>= 800ms)
    const minElemInterval = Math.max(800, minObs);
    let elements = sess._cachedElements || [];

    try {
      if (!sess._lastElementsAt || now - sess._lastElementsAt >= minElemInterval) {
        sess._lastElementsAt = now;

        // extract elements (limit inside helper)
        elements = await extractClickableElements(sess.page);
        sess._cachedElements = elements;

        const h = hashElements(elements);
        sess._cachedElementsHash = h;

        broadcastToViewers(sess, {
          type: "agent_elements",
          sessionId,
          elements,
          ts: now,
        });
      } else {
        // optionally still tell viewers "tick" without elements
        // (keeps UI responsive if you want)
      }
    } catch {
      // if extraction fails, keep last cached
      elements = sess._cachedElements || [];
    }

    // send /observe (with timeout)
    sess._observeInflight = true;

    // If worker has been failing, gradually increase timeout a bit but cap it
    const baseTimeout = 10_000;
    const extra = clamp(sess._observeBackoffMs || 0, 0, 10_000);
    const timeoutMs = baseTimeout + extra;

    const { controller, done } = withTimeout(timeoutMs);

    const img = sess._lastFrameImg || "";
const imgTs = sess._lastFrameAt || 0;

	fetchFn(`${WORKER_HTTP}/agent/observe`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	signal: controller.signal,
	body: JSON.stringify({
		sessionId,
		obsId: `obs-${now}`,
		url: sess.page.url(),
		viewport: sess.viewport,

		// ✅ include if you want (worker can ignore)
		img,
		imgTs,

		elements,
		elementsHash: sess._cachedElementsHash,
		ts: now,
	}),
	})
      .then(() => {
        // success => reduce backoff
        sess._observeBackoffMs = Math.max(0, (sess._observeBackoffMs || 0) - 1000);
      })
      .catch(() => {
        // worker slow/unreachable => back off observe to avoid hammering
        const b = sess._observeBackoffMs || 0;
        const next = Math.min(15_000, b ? Math.round(b * 1.5) : 2000);
        sess._observeBackoffMs = next;
        sess._observeCooldownUntil = Date.now() + Math.min(5000, 1500 + next);
      })
      .finally(() => {
        done();
        sess._observeInflight = false;
      });
  }, 250); // short poll; minObs gate controls actual send rate

  sessions.get(sessionId).interval = interval;
  return { viewport };
}
