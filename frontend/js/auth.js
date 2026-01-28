import { state } from "./state.js";
import { ui } from "./ui.js";
import { api } from "./api.js";

export const auth = {
  init() {
    // If token exists, try to validate and enable admin
    if (state.adminToken) {
      this.validate().catch(() => this.logout());
    }
  },

  openModal() {
    ui.modalHint.textContent = "";
    ui.adminPass.value = "";
    ui.modalBackdrop.hidden = false;
    ui.adminPass.focus();
  },

  closeModal() {
    ui.modalBackdrop.hidden = true;
  },

  async loginWithPassword(password) {
    ui.modalHint.textContent = "";
    try {
      const data = await api.adminLogin(password);
      state.adminToken = data.token;
      localStorage.setItem("adminToken", state.adminToken);
      ui.setAdminMode(true);
      ui.log("Admin login success.");
      this.closeModal();
    } catch (e) {
      ui.modalHint.textContent = "Login failed. Check password.";
      ui.log(`Admin login failed: ${String(e.message || e)}`, "warn");
    }
  },

  async validate() {
    if (!state.adminToken) return;
    await api.adminMe(); // throws if invalid
    ui.setAdminMode(true);
    ui.log("Admin token validated.");
  },

  logout() {
    state.adminToken = "";
    localStorage.removeItem("adminToken");
    ui.setAdminMode(false);
    ui.log("Logged out of admin.");
  }
};
