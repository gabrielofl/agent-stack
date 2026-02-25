// src/panel/index.js
import { getPanelEls } from "./panel.dom.js";
import { createPanelState } from "./panel.state.js";
import { createPanelUI } from "./panel.ui.js";
import { bootstrapPanel } from "./panel.controller.js";

document.addEventListener("DOMContentLoaded", async () => {
  const els = getPanelEls();
  const state = createPanelState();
  const ui = createPanelUI(els);

  try {
    await bootstrapPanel({ state, ui, els });
  } catch (e) {
    ui.setStatusTitle("Config error");
    ui.setStatus(e?.message || String(e));
  }
});