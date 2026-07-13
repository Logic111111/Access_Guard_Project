import axios from "axios";

const BACKEND_PORT = process.env.REACT_APP_BACKEND_PORT || 8000;
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
export const API = "/api";

export const api = axios.create({ baseURL: API });

export { BACKEND_URL };

api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem("ag_token");
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  cfg.headers["ngrok-skip-browser-warning"] = "true";
  cfg.headers["Bypass-Tunnel-Reminder"] = "true";
  return cfg;
});

// Surface friendly guidance for network-gateway (511) issues
api.interceptors.response.use(
  (r) => r,
  (err) => {
    try {
      const st = err?.response?.status;
      if (st === 511) {
        // Emit an event so the UI can render a dedicated guidance panel instead of an alert.
        try {
          const ev = new CustomEvent("network-authentication-required", {
            detail: {
              message:
                "Network requires authentication (511). If you're using a tunnel, try restarting it or use a different provider (ngrok/localtunnel/Cloudflare). For remote access, select Remote Token login on the login screen.",
              status: 511,
            },
          });
          window.dispatchEvent(ev);
        } catch (e) {
          // Fallback to alert if CustomEvent fails in the environment
          alert(
            "Network requires authentication (511). If you're using a tunnel, try restarting it or use a different provider (ngrok/localtunnel/Cloudflare)."
          );
        }
      }
    } catch (e) {
      /* ignore */
    }
    return Promise.reject(err);
  }
);

export function setToken(t) {
  if (t) localStorage.setItem("ag_token", t);
  else localStorage.removeItem("ag_token");
}

export function getToken() {
  return localStorage.getItem("ag_token");
}

export function setUser(u) {
  if (u) localStorage.setItem("ag_user", JSON.stringify(u));
  else localStorage.removeItem("ag_user");
}

export function getUser() {
  try { return JSON.parse(localStorage.getItem("ag_user") || "null"); }
  catch { return null; }
}
