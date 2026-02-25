// src/auth/auth.controller.js
import { clearSession, loadSession, saveSession } from "./auth.storage.js";
import {
  loginUser,
  logoutUser,
  registerUser,
  validateSession
} from "./auth.service.js";

export async function bootstrapAuth({ ui }) {
  const existing = await loadSession();

  if (!existing?.token) {
    ui.showLoggedOut();
    return null;
  }

  ui.setAuthStatus("Validating session...");
  ui.setBusy(true);

  try {
    const validated = await validateSession(existing.token);
    const merged = { ...existing, ...validated };
    await saveSession(merged);
    ui.showLoggedIn(merged);
    return merged;
  } catch {
    await clearSession();
    ui.showLoggedOut();
    return null;
  } finally {
    ui.setBusy(false);
  }
}

export async function handleLogin({ ui }) {
  const { email, password } = ui.readLoginForm();
  if (!email || !password) throw new Error("Email and password are required.");

  ui.setBusy(true);
  ui.setAuthStatus("Signing in...");

  try {
    const session = await loginUser({ email, password });
    await saveSession(session);
    ui.clearAuthInputs();
    ui.showLoggedIn(session);
    return session;
  } finally {
    ui.setBusy(false);
  }
}

export async function handleRegister({ ui }) {
  const { name, email, password } = ui.readRegisterForm();
  if (!email || !password) throw new Error("Email and password are required.");

  ui.setBusy(true);
  ui.setAuthStatus("Creating account...");

  try {
    const session = await registerUser({ name, email, password });
    await saveSession(session);
    ui.clearAuthInputs();
    ui.showLoggedIn(session);
    return session;
  } finally {
    ui.setBusy(false);
  }
}

export async function handleLogout({ ui, currentSession }) {
  ui.setBusy(true);
  ui.setAuthStatus("Signing out...");

  try {
    if (currentSession?.token) {
      try {
        await logoutUser(currentSession.token);
      } catch {
        // Ignore backend logout failure; still clear local session.
      }
    }
    await clearSession();
    ui.showLoggedOut();
    return null;
  } finally {
    ui.setBusy(false);
  }
}