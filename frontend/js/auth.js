// auth.js
import { state } from "./state.js";
import { ui } from "./ui.js";
import { api } from "./api.js";

export const auth = {
  init() {
    state.adminToken = localStorage.getItem("adminToken") || "";
    if (state.adminToken) {
      this.verify()
        .then(() => ui.setAdminMode(true))
        .catch(() => this.logout());
    }
  },

  openModal() {
    ui.modalHint.textContent = "";
    ui.adminPass.value = "";
    ui.modalBackdrop.hidden = false;
    ui.modalBackdrop.style.display = "flex";
    ui.modalBackdrop.style.pointerEvents = "auto";
    ui.adminPass.focus();
  },

  closeModal() {
    ui.modalBackdrop.hidden = true;
    ui.modalBackdrop.style.display = "none";
    ui.modalBackdrop.style.pointerEvents = "none";
  },

  async loginWithPassword(password) {
    ui.modalHint.textContent = "Logging in…";
    try {
      const { token } = await api.adminLogin((password || "").trim());

      state.adminToken = token;
      localStorage.setItem("adminToken", token);

      await this.verify();         // confirms token is actually valid
      ui.setAdminMode(true);

      ui.modalHint.textContent = "";
      this.closeModal();

      ui.pushUserFeed("System: admin login ok.");
      ui.adminLog("Admin login ok.");
    } catch (e) {
      ui.setAdminMode(false);
      ui.modalHint.textContent = (e?.message || "Login failed");
      ui.pushUserFeed(`System: admin login failed — ${String(e?.message || e)}`, "warn");
    }
  },

  async verify() {
    await api.adminMe(); // must send Authorization header internally
  },

  logout() {
    state.adminToken = "";
    localStorage.removeItem("adminToken");
    ui.setAdminMode(false);

    if (ui.modalHint) ui.modalHint.textContent = "";
    ui.pushUserFeed("System: admin logout.");
  }
};
