// worker-agent/src/agent/actionSchema.js
import { MAX_TEXT_LEN } from "../config/env.js";

const ALLOWED_TYPES = new Set([
  // navigation + time
  "goto",
  "wait",

  // user comms
  "ask_user",

  // pointer / keyboard
  "click",
  "click_selector",
  "click_element",
  "hover",
  "hover_selector",
  "press_key",
  "key_chord",

  // scrolling
  "scroll",

  // input
  "type",
  "type_in_selector",
  "type_element",
  "focus_selector",
  "clear_selector",

  // form controls
  "select",
  "check_selector",
  "uncheck_selector",
  "submit_selector",

  // capture / read
  "screenshot_region",
  "extract_text",
  "extract_html",
]);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeStr(s, maxLen) {
  const t = String(s ?? "");
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function safeBool(v) {
  return !!v;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

function sanitizeUrl(rawUrl) {
  let u = String(rawUrl ?? "").trim();
  if (!u) return "";

  if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
    u = u.slice(1, -1).trim();
  }

  // Strip trailing punctuation models often include
  u = u.replace(/[)\],.;"'”]+$/g, "");
  return u.trim();
}

function safeInt(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return clamp(def, min, max);
  return clamp(Math.round(n), min, max);
}

function normViewport(ctx) {
  const viewport = ctx?.viewport || { width: 1280, height: 720 };
  const W = Number(viewport.width || 1280);
  const H = Number(viewport.height || 720);
  return { W, H };
}

function normXY(action, ctx) {
  const { W, H } = normViewport(ctx);
  const xRaw = Number(action.x);
  const yRaw = Number(action.y);
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) {
    return { ok: false, error: "requires numeric x,y" };
  }
  const x = clamp(Math.round(xRaw), 0, W - 1);
  const y = clamp(Math.round(yRaw), 0, H - 1);
  return { ok: true, x, y };
}

function normSelector(sel, maxLen = 500) {
  return safeStr(sel, maxLen).trim();
}

function normElementIndex(n, ctx) {
  const els = Array.isArray(ctx?.elements) ? ctx.elements : [];
  const max = Math.max(els.length, 1);
  const idx0 = safeInt(n, -1, 1, max) - 1; // input is 1-based
  if (idx0 < 0 || idx0 >= els.length) return { ok: false, error: "elementNumber out of range" };
  return { ok: true, elementNumber: idx0 + 1 };
}

// ---- normalize common alias action types LLMs produce ----
function normalizeTypeAlias(typeRaw) {
  const t = String(typeRaw || "").trim();

  // exact pass-through first
  if (ALLOWED_TYPES.has(t)) return t;

  // common aliases (kept short + explicit)
  const map = {
    hover_sel: "hover_selector",
    type_sel: "type_in_selector",
    click_sel: "click_selector",
    // allow slight naming variants
    press: "press_key",
    keycombo: "key_chord",
  };

  return map[t] || t;
}

/**
 * validateAndNormalizeDecision:
 * - ensures action type supported
 * - clamps numbers
 * - trims strings
 * - computes requiresApproval policy
 */
export function validateAndNormalizeDecision(raw, ctx) {
  const decision = typeof raw === "object" && raw ? raw : {};
  const actionIn = typeof decision.action === "object" && decision.action ? decision.action : null;
  if (!actionIn) return { ok: false, error: "missing action object" };

  const type = normalizeTypeAlias(actionIn.type);
  if (!ALLOWED_TYPES.has(type)) return { ok: false, error: `unsupported action.type "${type}"` };

  // policy: only screenshot_region requires approval
  const requiresApproval = type === "screenshot_region";

  // clone (so we don't mutate caller)
  const action = { ...actionIn, type };

  // -------------------------
  // NAVIGATION + TIME
  // -------------------------
  if (type === "goto") {
    const url = sanitizeUrl(safeStr(action.url, 2000));
    if (!isHttpUrl(url)) return { ok: false, error: "goto.url must start with http(s)://" };
    return { ok: true, decision: { requiresApproval, action: { type, url } } };
  }

  if (type === "wait") {
    const ms = safeInt(action.ms ?? 500, 500, 0, 60_000);
    return { ok: true, decision: { requiresApproval, action: { type, ms } } };
  }

  // -------------------------
  // USER COMMS
  // -------------------------
  if (type === "ask_user") {
    const question = safeStr(action.question, 400).trim() || "What should I do next?";
    return { ok: true, decision: { requiresApproval: false, action: { type, question } } };
  }

  // -------------------------
  // SCROLL
  // -------------------------
  if (type === "scroll") {
    const dx = safeInt(action.dx ?? 0, 0, -2000, 2000);
    const dy = safeInt(action.dy ?? 500, 500, -4000, 4000);
    return { ok: true, decision: { requiresApproval, action: { type, dx, dy } } };
  }

  // -------------------------
  // KEYS
  // -------------------------
  if (type === "press_key") {
    const key = safeStr(action.key, 64).trim();
    if (!key) return { ok: false, error: "press_key requires key" };
    return { ok: true, decision: { requiresApproval, action: { type, key } } };
  }

  if (type === "key_chord") {
    const rawKeys = Array.isArray(action.keys) ? action.keys : [];
    const keys = [...new Set(rawKeys.map((k) => safeStr(k, 32).trim()).filter(Boolean))];
    if (!keys.length) return { ok: false, error: "key_chord requires keys[]" };
    // safety cap
    if (keys.length > 6) keys.length = 6;
    return { ok: true, decision: { requiresApproval, action: { type, keys } } };
  }

  // -------------------------
  // POINTER: CLICK / HOVER
  // -------------------------
  if (type === "click") {
    const xy = normXY(action, ctx);
    if (!xy.ok) return { ok: false, error: xy.error };
    const button = action.button === "right" ? "right" : "left";
    return { ok: true, decision: { requiresApproval, action: { type, x: xy.x, y: xy.y, button } } };
  }

  if (type === "click_selector") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: "click_selector requires selector" };
    const button = action.button === "right" ? "right" : "left";
    return { ok: true, decision: { requiresApproval, action: { type, selector, button } } };
  }

  if (type === "click_element") {
    const el = normElementIndex(action.elementNumber, ctx);
    if (!el.ok) return { ok: false, error: el.error };
    const button = action.button === "right" ? "right" : "left";
    return { ok: true, decision: { requiresApproval, action: { type, elementNumber: el.elementNumber, button } } };
  }

  if (type === "hover") {
    const xy = normXY(action, ctx);
    if (!xy.ok) return { ok: false, error: xy.error };
    return { ok: true, decision: { requiresApproval, action: { type, x: xy.x, y: xy.y } } };
  }

  if (type === "hover_selector") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: "hover_selector requires selector" };
    return { ok: true, decision: { requiresApproval, action: { type, selector } } };
  }

  // -------------------------
  // INPUT
  // -------------------------
  if (type === "type") {
    const text = safeStr(action.text, MAX_TEXT_LEN);
    return { ok: true, decision: { requiresApproval, action: { type, text } } };
  }

  if (type === "focus_selector") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: "focus_selector requires selector" };
    return { ok: true, decision: { requiresApproval, action: { type, selector } } };
  }

  if (type === "clear_selector") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: "clear_selector requires selector" };
    return { ok: true, decision: { requiresApproval, action: { type, selector } } };
  }

  if (type === "type_in_selector") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: "type_in_selector requires selector" };
    const text = safeStr(action.text, MAX_TEXT_LEN);
    const clearFirst = safeBool(action.clearFirst);
    return { ok: true, decision: { requiresApproval, action: { type, selector, text, clearFirst } } };
  }

  if (type === "type_element") {
    const el = normElementIndex(action.elementNumber, ctx);
    if (!el.ok) return { ok: false, error: el.error };
    const text = safeStr(action.text, MAX_TEXT_LEN);
    const clearFirst = safeBool(action.clearFirst);
    return {
      ok: true,
      decision: { requiresApproval, action: { type, elementNumber: el.elementNumber, text, clearFirst } },
    };
  }

  // -------------------------
  // FORM CONTROLS
  // -------------------------
  if (type === "select") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: "select requires selector" };

    const out = { type, selector };
    if (action.value != null) out.value = safeStr(action.value, 500);
    else if (action.label != null) out.label = safeStr(action.label, 500);
    else if (action.index != null) out.index = safeInt(action.index, 0, 0, 200);
    else return { ok: false, error: "select requires value|label|index" };

    return { ok: true, decision: { requiresApproval, action: out } };
  }

  if (type === "check_selector" || type === "uncheck_selector") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: `${type} requires selector` };
    return { ok: true, decision: { requiresApproval, action: { type, selector } } };
  }

  if (type === "submit_selector") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: "submit_selector requires selector" };
    return { ok: true, decision: { requiresApproval, action: { type, selector } } };
  }

  // -------------------------
  // SCREENSHOT
  // -------------------------
  if (type === "screenshot_region") {
    const { W, H } = normViewport(ctx);

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

  // -------------------------
  // EXTRACT / READ (for when agent is unsure)
  // -------------------------
  if (type === "extract_text" || type === "extract_html") {
    const selector = normSelector(action.selector);
    if (!selector) return { ok: false, error: `${type} requires selector` };

    // Let the worker constrain how much it asks backend to return
    const maxLen = safeInt(action.maxLen ?? 4000, 4000, 64, 50_000);

    // Optional: future proof (href/value/etc). Backend can ignore safely for now.
    const attribute = action.attribute != null ? safeStr(action.attribute, 64).trim() : undefined;

    return {
      ok: true,
      decision: {
        requiresApproval,
        action: { type, selector, maxLen, ...(attribute ? { attribute } : {}) },
      },
    };
  }

  return { ok: false, error: "unreachable" };
}
