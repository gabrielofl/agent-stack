// src/panel/panel.controller.js
import { getSync, setSync } from "../services/chrome-api.js";
import { createPanelActions } from "./panel.actions.js";
import { attachRuntimeListeners } from "./panel.listeners.js";
import {
  bootstrapAuth,
  handleLogin,
  handleLogout,
  handleRegister
} from "../auth/auth.controller.js";

export async function bootstrapPanel({ state, ui, els }) {
  ui.initDefaultsFromConfig();
  ui.setStatusTitle("Ready.");
  ui.setStatus("Tip: Use “Pick image” for a single image or “Screenshot area” to crop.");

  // Restore panel UI state
  const { advOpen = false, panelMin = false } = await getSync(["advOpen", "panelMin"]);
  if (els.advancedDetails) {
    els.advancedDetails.open = Boolean(advOpen);
    els.advancedDetails.addEventListener("toggle", async () => {
      await setSync({ advOpen: els.advancedDetails.open });
    });
  }

  state.minimized = Boolean(panelMin);
  document.body.classList.toggle("is-min", state.minimized);

  // Auth bootstrap (this will show auth screen or app screen depending on session)
  state.session = await bootstrapAuth({ ui: ui.auth });

  // Actions
  const actions = createPanelActions({ state, ui, els });

  // Wire main buttons
  els.clearBtn?.addEventListener("click", actions.handleClear);
  els.closeBtn?.addEventListener("click", actions.handleClose);
  els.minBtn?.addEventListener("click", actions.handleToggleMinimize);
  els.scrapeBtn?.addEventListener("click", actions.handleScrape);
  els.pickBtn?.addEventListener("click", actions.handlePick);
  els.shotBtn?.addEventListener("click", actions.handleScreenshot);

  // Login
  els.loginBtnEl?.addEventListener("click", async () => {
    try {
      // Optional UX: hide "name" field when doing login
      els.authNameFieldEl?.classList.add("hidden");

      state.session = await handleLogin({ ui: ui.auth });

      ui.setStatusTitle("Signed in");
      ui.setStatus("You can now use scrape/pick/screenshot.");
    } catch (e) {
      ui.auth.setAuthStatus(e?.message || String(e), true);
    }
  });

  // Register
  els.registerBtnEl?.addEventListener("click", async () => {
    try {
      // Optional UX: ensure register name field is visible if you use it
      // If you don't want this behavior, remove the next line.
      els.authNameFieldEl?.classList.remove("hidden");

      state.session = await handleRegister({ ui: ui.auth });

      ui.setStatusTitle("Account created");
      ui.setStatus("Registration successful. You are now signed in.");
    } catch (e) {
      ui.auth.setAuthStatus(e?.message || String(e), true);
    }
  });

  // Optional: Continue button if you keep an intermediate "logged-in" auth screen
  els.continueBtnEl?.addEventListener("click", () => {
    ui.auth.showAppScreen?.();
    ui.setStatusTitle("Ready.");
    ui.setStatus("Tip: Use “Pick image” for a single image or “Screenshot area” to crop.");
  });

  // Shared logout handler (works from auth screen and app screen)
  const onLogout = async () => {
    try {
      state.session = await handleLogout({
        ui: ui.auth,
        currentSession: state.session
      });

      // Clean UI after logout
      ui.clearPreviews();
      ui.setStatusTitle("Signed out");
      ui.setStatus("Session cleared. Please sign in again.");
    } catch (e) {
      ui.auth.setAuthStatus(e?.message || String(e), true);
    }
  };

  els.logoutBtnEl?.addEventListener("click", onLogout);      // auth screen logout
  els.appLogoutBtnEl?.addEventListener("click", onLogout);   // app screen logout chip/button

  // Background result listeners
  attachRuntimeListeners({ ui });
}