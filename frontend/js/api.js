import { state } from "./state.js";

export const api = {
  normalizeFqdn(raw) {
    let s = (raw || "").trim();
    s = s.replace(/^https?:\/\//i, "");
    s = s.replace(/^wss?:\/\//i, "");
    s = s.split("/")[0];
    return s;
  },

  base() {
    return `https://${state.backendFqdn}`;
  },

  async health() {
    const res = await fetch(`${this.base()}/health`, { cache: "no-store" });
    return { ok: res.ok, status: res.status };
  },

  async createSession(url) {
    const res = await fetch(`${this.base()}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`sessions ${res.status}: ${text.slice(0,200)}`);
    return JSON.parse(text);
  },

  // Admin auth (MVP)
  async adminLogin(password) {
    const res = await fetch(`${this.base()}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`admin login ${res.status}: ${text.slice(0,200)}`);
    return JSON.parse(text);
  },

  async adminMe() {
  const res = await fetch(`${this.base()}/admin/me`, {
    headers: { "authorization": `Bearer ${state.adminToken}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`admin/me ${res.status}: ${text.slice(0,200)}`);
  return JSON.parse(text);
  },
  
  async startAgent(sessionId, model = "default") {
  const res = await fetch(`${this.base()}/agent/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${state.adminToken}`,
    },
    body: JSON.stringify({ sessionId, model }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`agent/start ${res.status}: ${text.slice(0,200)}`);
  return JSON.parse(text);
},
  
  async correction(sessionId, text, mode = "override") {
  const res = await fetch(`${this.base()}/agent/correction`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${state.adminToken}`,
    },
    body: JSON.stringify({ sessionId, text, mode }),
  });
  const out = await res.text();
  if (!res.ok) throw new Error(`agent/correction ${res.status}: ${out.slice(0,200)}`);
  return JSON.parse(out);
},

async instruction(sessionId, text, model = "default") {
  const res = await fetch(`${this.base()}/agent/instruction`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${state.adminToken}`,
    },
    body: JSON.stringify({ sessionId, text, model }),
  });
  const out = await res.text();
  if (!res.ok) throw new Error(`agent/instruction ${res.status}: ${out.slice(0, 200)}`);
  return JSON.parse(out);
}

};
