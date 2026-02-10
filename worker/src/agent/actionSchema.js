// worker-agent/src/agent/actionSchema.js
import { MAX_TEXT_LEN } from "../config/env.js";

const ALLOWED_TYPES = new Set([
  "click",
  "type",
  "goto",
  "wait",
  "ask_user",
  "scroll",
  "press_key",
  "select",
  "hover",
  "type_in_selector",
  "screenshot_region",
]);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeStr(s, maxLen) {
  const t = String(s ?? "");
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

function sanitizeUrl(rawUrl) {
  let u = String(rawUrl ?? "").trim();
  if (!u) return "";

  // Strip wrapping quotes
  if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
    u = u.slice(1, -1).trim();
  }

  // Strip common trailing punctuation that models often include
  // e.g. https://x.com/",  https://x.com).  https://x.com,
  u = u.replace(/[)\],.;"'”]+$/g, "");

  return u.trim();
}

/**
 * Convert to a clamped integer, falling back to a default when NaN/Infinity/etc.
 */
function safeInt(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return clamp(def, min, max);
  return clamp(Math.round(n), min, max);
}

export function validateAndNormalizeDecision(raw, ctx) {
  const viewport = ctx?.viewport || { width: 1280, height: 720 };
  const W = Number(viewport.width || 1280);
  const H = Number(viewport.height || 720);

  const decision = typeof raw === "object" && raw ? raw : {};
  const action = typeof decision.action === "object" && decision.action ? decision.action : null;
  if (!action) return { ok: false, error: "missing action object" };

  const type = String(action.type || "");
  if (!ALLOWED_TYPES.has(type)) return { ok: false, error: `unsupported action.type "${type}"` };

  // only screenshot_region forces approval; everything else defaults false
  const requiresApproval = type === "screenshot_region";

  const normXY = () => {
    const xRaw = Number(action.x);
    const yRaw = Number(action.y);
    if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) {
      return { ok: false, error: "requires numeric x,y" };
    }
    const x = clamp(Math.round(xRaw), 0, W - 1);
    const y = clamp(Math.round(yRaw), 0, H - 1);
    return { ok: true, x, y };
  };

  if (type === "click") {
    const xy = normXY();
    if (!xy.ok) return { ok: false, error: xy.error };
    const { x, y } = xy;
    const button = action.button === "right" ? "right" : "left";
    return { ok: true, decision: { requiresApproval, action: { type, x, y, button } } };
  }

  if (type === "hover") {
    if (action.selector) {
      const selector = safeStr(action.selector, 500).trim();
      if (!selector) return { ok: false, error: "hover.selector empty" };
      return { ok: true, decision: { requiresApproval, action: { type, selector } } };
    }
    const xy = normXY();
    if (!xy.ok) return { ok: false, error: xy.error };
    const { x, y } = xy;
    return { ok: true, decision: { requiresApproval, action: { type, x, y } } };
  }

  if (type === "type") {
    const text = safeStr(action.text, MAX_TEXT_LEN);
    return { ok: true, decision: { requiresApproval, action: { type, text } } };
  }

  if (type === "type_in_selector") {
    const selector = safeStr(action.selector, 500).trim();
    if (!selector) return { ok: false, error: "type_in_selector requires selector" };
    const text = safeStr(action.text, MAX_TEXT_LEN);
    const clearFirst = !!action.clearFirst;
    return { ok: true, decision: { requiresApproval, action: { type, selector, text, clearFirst } } };
  }

  if (type === "select") {
    const selector = safeStr(action.selector, 500).trim();
    if (!selector) return { ok: false, error: "select requires selector" };

    const out = { type, selector };

    if (action.value != null) out.value = safeStr(action.value, 500);
    else if (action.label != null) out.label = safeStr(action.label, 500);
    else if (action.index != null) {
      // FIX: avoid NaN index
      out.index = safeInt(action.index, 0, 0, 200);
    } else {
      return { ok: false, error: "select requires value|label|index" };
    }

    return { ok: true, decision: { requiresApproval, action: out } };
  }

  if (type === "goto") {
    const url = sanitizeUrl(safeStr(action.url, 2000));
    if (!isHttpUrl(url)) return { ok: false, error: "goto.url must start with http(s)://" };
    return { ok: true, decision: { requiresApproval, action: { type, url } } };
  }

  if (type === "wait") {
    // FIX: avoid NaN ms
    const ms = safeInt(action.ms ?? 500, 500, 0, 60_000);
    return { ok: true, decision: { requiresApproval, action: { type, ms } } };
  }

  if (type === "scroll") {
    // FIX: avoid NaN dx/dy
    const dx = safeInt(action.dx ?? 0, 0, -2000, 2000);
    const dy = safeInt(action.dy ?? 500, 500, -4000, 4000);
    return { ok: true, decision: { requiresApproval, action: { type, dx, dy } } };
  }

  if (type === "press_key") {
    const key = safeStr(action.key, 64).trim();
    if (!key) return { ok: false, error: "press_key requires key" };
    return { ok: true, decision: { requiresApproval, action: { type, key } } };
  }

  if (type === "screenshot_region") {
    // FIX: validate numbers; avoid NaN -> NaN propagation
    const x = safeInt(action.x, 0, 0, W - 1);
    const y = safeInt(action.y, 0, 0, H - 1);

    const maxW = Math.max(1, W - x);
    const maxH = Math.max(1, H - y);

    const w = safeInt(action.w ?? 200, 200, 1, maxW);
    const h = safeInt(action.h ?? 200, 200, 1, maxH);

    const format = action.format === "jpeg" ? "jpeg" : "png";
    const quality = format === "jpeg" ? safeInt(action.quality ?? 70, 70, 1, 100) : undefined;

    return {
      ok: true,
      decision: {
        requiresApproval: true,
        action: { type, x, y, w, h, format, ...(format === "jpeg" ? { quality } : {}) },
        explanation: "screenshot_region requires approval by policy",
      },
    };
  }

  if (type === "ask_user") {
    const question = safeStr(action.question, 400).trim() || "What should I do next?";
    return { ok: true, decision: { requiresApproval: false, action: { type, question } } };
  }

  return { ok: false, error: "unreachable" };
}
