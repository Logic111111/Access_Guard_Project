import axios from "axios";
import { getStoredCandidateToken } from "./studentSession";

const trimTrailingSlashes = (value = "") => value.replace(/\/+$/, "");
const BACKEND_URL = trimTrailingSlashes(process.env.REACT_APP_BACKEND_URL || "");
export const API = BACKEND_URL ? `${BACKEND_URL}/api` : "/api";

export const api = axios.create({ baseURL: API });

export { BACKEND_URL };

export function getCandidateToken() {
  return getStoredCandidateToken();
}

export function candidateAuthConfig(config = {}) {
  const token = getCandidateToken();
  return {
    ...config,
    headers: {
      ...(config.headers || {}),
      ...(token ? { "X-Candidate-Token": token } : {}),
    },
  };
}

export function getPublicBackendOrigin() {
  return BACKEND_URL || window.location.origin;
}

export function getWebSocketUrl(path) {
  const base = new URL(BACKEND_URL || window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = path.startsWith("/") ? path : `/${path}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem("ag_token");
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  cfg.headers["ngrok-skip-browser-warning"] = "true";
  cfg.headers["Bypass-Tunnel-Reminder"] = "true";
  return cfg;
});

// An invigilator-authenticated request (carried an Authorization header we set)
// that comes back 401 means that token is stale/expired/revoked — not a
// candidate-token or public-endpoint 401, and not a failed login attempt
// itself, which Login.jsx already surfaces with its own error toast.
export function shouldRedirectToLogin(error, currentPath = "") {
  if (error?.response?.status !== 401) return false;
  if (!error?.config?.headers?.Authorization) return false;
  if (String(error?.config?.url || "").includes("/auth/login")) return false;
  if (currentPath === "/login") return false;
  return true;
}

// Surface friendly guidance for network-gateway (511) issues
api.interceptors.response.use(
  (r) => r,
  (err) => {
    try {
      if (shouldRedirectToLogin(err, window.location.pathname)) {
        setToken(null);
        setUser(null);
        sessionStorage.setItem("ag_session_expired", "1");
        window.location.assign("/login");
        return Promise.reject(err);
      }
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
