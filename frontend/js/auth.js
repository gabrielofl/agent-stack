// auth.js
import { state } from "./state.js";
import { ui } from "./ui.js";
import { api } from "./api.js";

export const auth = {
  init() {
    // restore token
    state.adminToken = localStorage.getItem("adminToken") || "";
    if (state.adminToken) {
      // verify token silently
      this.verify().catch(() => this.logout());
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

      // IMPORTANT: save it
      state.adminToken = token;
      localStorage.setItem("adminToken", token);

      // OPTIONAL but recommended: verify /admin/me so you can show a real error
      await this.verify();

      ui.setAdminMode(true);
      ui.modalHint.textContent = "";
      this.closeModal();
      ui.log("Admin login ok.");
    } catch (e) {
      ui.setAdminMode(false);
      ui.modalHint.textContent = (e?.message || "Login failed");
      ui.log(`Admin login failed: ${String(e?.message || e)}`, "warn");
    }
  },

  async verify() {
    // Will throw if not ok
    await api.adminMe();
  },

  logout() {
    state.adminToken = "";
    localStorage.removeItem("adminToken");
    ui.setAdminMode(false);
    ui.modalHint.textContent = "";
    ui.log("Admin logout.");
  }
};
