// src/auth/auth.storage.js
import { getLocal, removeLocal, setLocal } from "../services/chrome-api.js";

const AUTH_KEY = "authSession";

export async function saveSession(session) {
  await setLocal({ [AUTH_KEY]: session });
}

export async function loadSession() {
  const data = await getLocal(AUTH_KEY);
  return data?.[AUTH_KEY] || null;
}

export async function clearSession() {
  await removeLocal(AUTH_KEY);
}