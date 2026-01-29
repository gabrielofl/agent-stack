// src/services/pageHelpers.js (backend)
import WebSocket from "ws";

export async function extractClickableElements(page) {
  // unchanged (your existing code)
  return page.evaluate(() => {
    const sel = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[onclick]",
    ].join(",");

    const nodes = Array.from(document.querySelectorAll(sel));
    const out = [];

    for (const el of nodes.slice(0, 60)) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;

      const text = (
        el.innerText ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        ""
      ).trim();

      out.push({
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 80),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return out;
  });
}

export function broadcastToViewers(sess, obj) {
  const payload = JSON.stringify(obj);
  for (const ws of sess.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeStr(v, maxLen = 2000) {
  const s = String(v ?? "");
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * Executes a single agent action against the Playwright page.
 * Returns optional result data (e.g., screenshot_region image).
 */
export async function executeAgentAction(sess, action) {
  if (!action || !action.type) throw new Error("bad action");
  if (!sess?.page) throw new Error("session page not available");

  const page = sess.page;
  const viewport = sess.viewport || { width: 1280, height: 720, deviceScaleFactor: 1 };
  const W = Number(viewport.width || 1280);
  const H = Number(viewport.height || 720);

  // Keep a consistent place to attach results:
  const result = { data: null };

  switch (action.type) {
    // --- existing ---
    case "click": {
      const x = clamp(Math.round(Number(action.x)), 0, W - 1);
      const y = clamp(Math.round(Number(action.y)), 0, H - 1);
      await page.mouse.click(x, y, { button: action.button === "right" ? "right" : "left" });
      return result;
    }

    case "type": {
      await page.keyboard.type(safeStr(action.text, 20000));
      return result;
    }

    case "goto": {
      const url = safeStr(action.url, 4000).trim();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return result;
    }

    case "wait": {
      const ms = clamp(Math.round(Number(action.ms || 0)), 0, 60000);
      await new Promise((r) => setTimeout(r, ms));
      return result;
    }

    // --- new actions ---
    case "scroll": {
      // Uses wheel scrolling; works well with the same coordinate viewport model
      const dx = clamp(Math.round(Number(action.dx || 0)), -2000, 2000);
      const dy = clamp(Math.round(Number(action.dy || 500)), -4000, 4000);
      await page.mouse.wheel(dx, dy);
      return result;
    }

    case "press_key": {
      const key = safeStr(action.key, 64).trim();
      if (!key) throw new Error("press_key requires key");
      // Examples: "Enter", "Tab", "ArrowDown", "Control+A"
      await page.keyboard.press(key);
      return result;
    }

    case "hover": {
      if (action.selector) {
        const selector = safeStr(action.selector, 500).trim();
        await page.locator(selector).first().hover({ timeout: 5000 });
      } else {
        const x = clamp(Math.round(Number(action.x)), 0, W - 1);
        const y = clamp(Math.round(Number(action.y)), 0, H - 1);
        await page.mouse.move(x, y);
      }
      return result;
    }

    case "type_in_selector": {
      const selector = safeStr(action.selector, 500).trim();
      const text = safeStr(action.text, 20000);
      if (!selector) throw new Error("type_in_selector requires selector");

      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 5000 });

      if (action.clearFirst) {
        // Works for input/textarea
        try {
          await loc.fill("");
        } catch {
          // fallback if not fillable
          await loc.click();
          await page.keyboard.press("Control+A");
          await page.keyboard.type("");
        }
      }

      // Prefer fill when possible (fast/clean); fallback to click+type
      try {
        await loc.fill(text);
      } catch {
        await loc.click();
        await page.keyboard.type(text);
      }
      return result;
    }

    case "select": {
      const selector = safeStr(action.selector, 500).trim();
      if (!selector) throw new Error("select requires selector");

      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout: 5000 });

      // value takes priority, then label, then index
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

    case "screenshot_region": {
      // Clip screenshot inside viewport bounds
      const x = clamp(Math.round(Number(action.x)), 0, W - 1);
      const y = clamp(Math.round(Number(action.y)), 0, H - 1);
      const w = clamp(Math.round(Number(action.w)), 1, W - x);
      const h = clamp(Math.round(Number(action.h)), 1, H - y);

      const format = action.format === "jpeg" ? "jpeg" : "png";
      const quality =
        format === "jpeg"
          ? clamp(Math.round(Number(action.quality ?? 70)), 1, 100)
          : undefined;

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

    case "ask_user": {
      // Backend should not execute; workerStream already handles ask_user by forwarding.
      return result;
    }

    default:
      throw new Error("unsupported action: " + action.type);
  }
}
