// src/auth/auth.service.js
import { apiFetch } from "../services/api-client.js";

// Adjust these paths to match your Azure backend routes.
export async function registerUser(payload) {
  return apiFetch("/api/auth/register", {
    method: "POST",
    body: payload
  });
}

export async function loginUser(payload) {
  return apiFetch("/api/auth/login", {
    method: "POST",
    body: payload
  });
}

export async function validateSession(token) {
  return apiFetch("/api/auth/session", {
    method: "GET",
    token
  });
}

export async function logoutUser(token) {
  return apiFetch("/api/auth/logout", {
    method: "POST",
    token
  });
}