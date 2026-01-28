export const state = {
  backendFqdn: "",
  ws: null,
  session: null,
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },

  frames: 0,
  bytes: 0,
  lastFrameAt: 0,
  lastFrameUrl: "",
  lastHttp: "",
  lastError: "",
  fpsWindow: [],
  wsReconnectAttempt: 0,
  wsReconnectTimer: null,

  isAdmin: false,
  adminToken: localStorage.getItem("adminToken") || "",
};
