// src/services/pageHelpers.js
import WebSocket from "ws";
import crypto from "crypto";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeStr(v, maxLen = 2000) {
  const s = String(v ?? "");
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function broadcastToViewers(sess, obj) {
  const payload = JSON.stringify(obj);
  for (const ws of sess.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/**
 * Hash elements list to avoid resending identical payloads (optional).
 */
export function hashElements(elements) {
  try {
    const s = JSON.stringify(elements || []);
    return crypto.createHash("sha1").update(s).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Extract clickable + interactive elements in a generic way.
 * NOTE: Keep it cheap. Do not try to be perfect: just enough to steer the agent.
 */
export async function extractClickableElements(page) {
  return page.evaluate(() => {
    const sel = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[role='link']",
      "[onclick]",
      "[contenteditable='true']",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const nodes = Array.from(document.querySelectorAll(sel));
    const out = [];

    const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");

    for (const el of nodes.slice(0, 70)) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const href = el.getAttribute("href") || "";
      const title = el.getAttribute("title") || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const value = (el.value != null ? String(el.value) : "") || "";

      const text = norm(el.innerText || ariaLabel || title || placeholder || value || "");

      out.push({
        tag,
        role: norm(role).slice(0, 24),
        text: text.slice(0, 100),
        ariaLabel: norm(ariaLabel).slice(0, 100),
        title: norm(title).slice(0, 80),
        placeholder: norm(placeholder).slice(0, 80),
        value: norm(value).slice(0, 80),
        href: norm(href).slice(0, 160),

        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return out;
  });
}

/**
 * Executes a single agent action against the Playwright page.
 * Returns optional result data (e.g., screenshot_region image, extracted text).
 */
export async function executeAgentAction(sess, action) {
  if (!action || !action.type) throw new Error("bad action");
  if (!sess?.page) throw new Error("session page not available");

  const page = sess.page;
  const viewport = sess.viewport || { width: 1280, height: 720, deviceScaleFactor: 1 };
  const W = Number(viewport.width || 1280);
  const H = Number(viewport.height || 720);

  const result = { data: null };

  // Helper: get element by elementNumber (1-based) from cached elements.
  const resolveElementXY = (elementNumber) => {
    const els = Array.isArray(sess._cachedElements) ? sess._cachedElements : [];
    const idx = Number(elementNumber) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= els.length) return null;
    const e = els[idx];
    if (!e) return null;
    return {
      x: clamp(Math.round(Number(e.x)), 0, W - 1),
      y: clamp(Math.round(Number(e.y)), 0, H - 1),
    };
  };

  switch (action.type) {
    // -----------------------
    // POINTER: click/hover
    // -----------------------
    case "click": {
      const x = clamp(Math.round(Number(action.x)), 0, W - 1);
      const y = clamp(Math.round(Number(action.y)), 0, H - 1);
      await page.mouse.click(x, y, { button: action.button === "right" ? "right" : "left" });
      return result;
    }

    case "click_selector": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("click_selector requires selector");
      const button = action.button === "right" ? "right" : "left";
      await page.locator(selector).first().click({ button, timeout: 10_000 });
      return result;
    }

    case "click_element": {
      const xy = resolveElementXY(action.elementNumber);
      if (!xy) throw new Error("click_element: invalid elementNumber");
      await page.mouse.click(xy.x, xy.y, { button: action.button === "right" ? "right" : "left" });
      return result;
    }

    case "hover": {
      const x = clamp(Math.round(Number(action.x)), 0, W - 1);
      const y = clamp(Math.round(Number(action.y)), 0, H - 1);
      await page.mouse.move(x, y);
      return result;
    }

    case "hover_selector": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("hover_selector requires selector");
      await page.locator(selector).first().hover({ timeout: 10_000 });
      return result;
    }

    // -----------------------
    // NAV / TIME
    // -----------------------
    case "goto": {
      const url = safeStr(action.url, 4000).trim();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return result;
    }

    case "wait": {
      const ms = clamp(Math.round(Number(action.ms || 0)), 0, 60_000);
      await new Promise((r) => setTimeout(r, ms));
      return result;
    }

    // -----------------------
    // SCROLL
    // -----------------------
    case "scroll": {
      const dx = clamp(Math.round(Number(action.dx || 0)), -2000, 2000);
      const dy = clamp(Math.round(Number(action.dy || 500)), -4000, 4000);
      await page.mouse.wheel(dx, dy);
      return result;
    }

    // -----------------------
    // KEYBOARD
    // -----------------------
    case "press_key": {
      const key = safeStr(action.key, 64).trim();
      if (!key) throw new Error("press_key requires key");
      await page.keyboard.press(key);
      return result;
    }

    case "key_chord": {
      const keys = Array.isArray(action.keys) ? action.keys.map((k) => safeStr(k, 32).trim()).filter(Boolean) : [];
      if (!keys.length) throw new Error("key_chord requires keys[]");

      // normalize common names
      const norm = (k) => {
        const u = String(k).toUpperCase();
        if (u === "CTRL") return "Control";
        if (u === "CMD" || u === "COMMAND") return "Meta";
        if (u === "ALT") return "Alt";
        if (u === "SHIFT") return "Shift";
        return k;
      };

      // press chord as "Control+L" style if possible
      if (keys.length >= 2) {
        const combo = keys.map(norm).join("+");
        await page.keyboard.press(combo);
      } else {
        await page.keyboard.press(norm(keys[0]));
      }
      return result;
    }

    // -----------------------
    // INPUT
    // -----------------------
    case "type": {
      await page.keyboard.type(safeStr(action.text, 20000));
      return result;
    }

    case "focus_selector": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("focus_selector requires selector");
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });
      await loc.click({ timeout: 10_000 });
      return result;
    }

    case "clear_selector": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("clear_selector requires selector");
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });
      // fill("") is best for input/textarea
      try {
        await loc.fill("");
      } catch {
        await loc.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      }
      return result;
    }

    case "type_in_selector": {
      const selector = safeStr(action.selector, 800).trim();
      const text = safeStr(action.text, 20000);
      if (!selector) throw new Error("type_in_selector requires selector");

      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });

      if (action.clearFirst) {
        try {
          await loc.fill("");
        } catch {
          await loc.click();
          await page.keyboard.press("Control+A");
          await page.keyboard.press("Backspace");
        }
      }

      // Prefer fill; fallback click+type
      try {
        await loc.fill(text);
      } catch {
        await loc.click();
        await page.keyboard.type(text);
      }
      return result;
    }

    case "type_element": {
      const xy = resolveElementXY(action.elementNumber);
      if (!xy) throw new Error("type_element: invalid elementNumber");

      await page.mouse.click(xy.x, xy.y);
      if (action.clearFirst) {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.type(safeStr(action.text, 20000));
      return result;
    }

    // -----------------------
    // FORM CONTROLS
    // -----------------------
    case "select": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("select requires selector");

      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });

      if (action.value != null) {
        await loc.selectOption({ value: safeStr(action.value, 500) });
      } else if (action.label != null) {
        await loc.selectOption({ label: safeStr(action.label, 500) });
      } else if (action.index != null) {
        const idx = clamp(Math.round(Number(action.index)), 0, 200);
        await loc.selectOption({ index: idx });
      } else {
        throw new Error("select requires one of: value, label, index");
      }
      return result;
    }

    case "check_selector": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("check_selector requires selector");
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });
      try {
        await loc.check({ timeout: 10_000 });
      } catch {
        // fallback for non-input checkbox (role=checkbox etc.)
        await loc.click({ timeout: 10_000 });
      }
      return result;
    }

    case "uncheck_selector": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("uncheck_selector requires selector");
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });
      try {
        await loc.uncheck({ timeout: 10_000 });
      } catch {
        await loc.click({ timeout: 10_000 });
      }
      return result;
    }

    case "submit_selector": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("submit_selector requires selector");
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });

      // Prefer actual submit
      try {
        await loc.evaluate((el) => {
          if (typeof el.requestSubmit === "function") el.requestSubmit();
          else if (typeof el.submit === "function") el.submit();
          else el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
      } catch {
        // fallback: press Enter inside the form
        await loc.click({ timeout: 10_000 });
        await page.keyboard.press("Enter");
      }
      return result;
    }

    // -----------------------
    // SCREENSHOT
    // -----------------------
    case "screenshot_region": {
      const x = clamp(Math.round(Number(action.x)), 0, W - 1);
      const y = clamp(Math.round(Number(action.y)), 0, H - 1);
      const w = clamp(Math.round(Number(action.w)), 1, W - x);
      const h = clamp(Math.round(Number(action.h)), 1, H - y);

      const format = action.format === "jpeg" ? "jpeg" : "png";
      const quality = format === "jpeg" ? clamp(Math.round(Number(action.quality ?? 70)), 1, 100) : undefined;

      const buf = await page.screenshot({
        type: format,
        quality,
        clip: { x, y, width: w, height: h },
      });

      const mime = format === "jpeg" ? "image/jpeg" : "image/png";
      result.data = {
        type: "screenshot_region",
        mime,
        x,
        y,
        w,
        h,
        img: `data:${mime};base64,${buf.toString("base64")}`,
      };

      return result;
    }

    // -----------------------
    // EXTRACT / READ
    // -----------------------
    case "extract_text": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("extract_text requires selector");
      const maxLen = clamp(Math.round(Number(action.maxLen ?? 4000)), 64, 50_000);

      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });

      let txt = "";
      try {
        txt = await loc.innerText({ timeout: 10_000 });
      } catch {
        txt = await loc.textContent({ timeout: 10_000 });
      }

      result.data = {
        type: "extract_text",
        selector,
        text: safeStr(txt ?? "", maxLen),
      };
      return result;
    }

    case "extract_html": {
      const selector = safeStr(action.selector, 800).trim();
      if (!selector) throw new Error("extract_html requires selector");
      const maxLen = clamp(Math.round(Number(action.maxLen ?? 8000)), 64, 50_000);

      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 10_000 });

      const html = await loc.evaluate((el) => el.outerHTML);
      result.data = {
        type: "extract_html",
        selector,
        html: safeStr(html ?? "", maxLen),
      };
      return result;
    }

    case "ask_user": {
      // Backend should not execute; workerStream should forward to UI.
      return result;
    }

    default:
      throw new Error("unsupported action: " + action.type);
  }
}
