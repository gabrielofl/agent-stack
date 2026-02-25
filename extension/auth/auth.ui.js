// src/auth/auth.ui.js

export function createAuthUI(els, panelUI) {
  const {
    authContainerEl,
    authLoggedOutEl,
    authLoggedInEl,
    authEmailEl,
    authPasswordEl,
    authNameEl,
    loginBtnEl,
    registerBtnEl,
    logoutBtnEl,
    authUserLabelEl,
    authStatusEl
  } = els;

  function showAuthScreen() {
    els.authScreenEl?.classList.remove("hidden");
    els.appScreenEl?.classList.add("hidden");
  }

  function showAppScreen() {
    els.authScreenEl?.classList.add("hidden");
    els.appScreenEl?.classList.remove("hidden");
  }

  function setAuthStatus(msg, isError = false) {
    if (!authStatusEl) return;
    authStatusEl.textContent = msg || "";
    authStatusEl.classList.toggle("error", Boolean(isError));
  }

  function showLoggedOut() {
    if (!authContainerEl) return;

    showAuthScreen();
    authLoggedOutEl?.classList.remove("hidden");
    authLoggedInEl?.classList.add("hidden");

    if (authUserLabelEl) authUserLabelEl.textContent = "—";
    setAuthStatus("Not signed in");
  }

  function showLoggedIn(session) {
    if (!authContainerEl) return;

    const label =
      session?.user?.email ||
      session?.email ||
      session?.user?.name ||
      session?.name ||
      "Signed in";

    if (authUserLabelEl) authUserLabelEl.textContent = label;

    // If you want to skip the "logged-in auth card" and go straight to app:
    authLoggedOutEl?.classList.add("hidden");
    authLoggedInEl?.classList.remove("hidden"); // optional, harmless even if auth screen is hidden
    setAuthStatus("Session valid");
    panelUI.setStatusTitle("Ready.");
    showAppScreen();
  }

  function readLoginForm() {
    return {
      email: authEmailEl?.value?.trim() || "",
      password: authPasswordEl?.value || ""
    };
  }

  function readRegisterForm() {
    return {
      name: authNameEl?.value?.trim() || "",
      email: authEmailEl?.value?.trim() || "",
      password: authPasswordEl?.value || ""
    };
  }

  function clearAuthInputs() {
    if (authPasswordEl) authPasswordEl.value = "";
  }

  function setBusy(isBusy) {
    if (loginBtnEl) loginBtnEl.disabled = isBusy;
    if (registerBtnEl) registerBtnEl.disabled = isBusy;
    if (logoutBtnEl) logoutBtnEl.disabled = isBusy;
    if (els.appLogoutBtnEl) els.appLogoutBtnEl.disabled = isBusy;
  }

  return {
    showLoggedOut,
    showLoggedIn,
    showAuthScreen,
    showAppScreen,
    setAuthStatus,
    readLoginForm,
    readRegisterForm,
    clearAuthInputs,
    setBusy
  };
}