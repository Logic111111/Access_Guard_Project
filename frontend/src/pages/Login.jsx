import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api, setToken, setUser } from "../lib/api";
import { Eye, EyeOff, ChevronRight } from "lucide-react";
import { toast } from "sonner";

// Secrets passed in the URL are development conveniences only; production
// builds never pre-fill them. No password is pre-filled even in dev: there is
// no fixed invigilator credential in this codebase anymore (see backend's
// resolve_admin_password / POST /api/test/seed) to safely hardcode here.
const IS_DEV_BUILD = process.env.NODE_ENV !== "production";
const DEV_DEFAULTS = IS_DEV_BUILD
  ? { invId: "INV0001", password: "", remoteToken: "" }
  : { invId: "", password: "", remoteToken: "" };
// Invigilator login page. Supports two auth methods: password-based login
// and remote token login (for accessing the app over a tunnel/remote connection).
export default function Login() {
  const nav = useNavigate();
  const location = useLocation();
  const [invId, setInvId] = useState(DEV_DEFAULTS.invId);
  const [pw, setPw] = useState(DEV_DEFAULTS.password);
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loginMethod, setLoginMethod] = useState("password");
  const [remoteToken, setRemoteToken] = useState(DEV_DEFAULTS.remoteToken);
  const [networkAuth, setNetworkAuth] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    
    const queryInvId = params.get("inv_id") || params.get("invId") || params.get("invigilator");
    const queryMethod = params.get("login_method") || params.get("method");

    if (queryInvId) setInvId(queryInvId);
    if (queryMethod) setLoginMethod(queryMethod);
    if (!IS_DEV_BUILD) return;
    const queryPassword = params.get("password");
    const queryRemoteToken = params.get("remote_token") || params.get("token");
    if (queryPassword) setPw(queryPassword);
    if (queryRemoteToken) setRemoteToken(queryRemoteToken);
  }, [location.search]);
// Shows a toast if the user was redirected here due to an expired session.
  useEffect(() => {
    if (sessionStorage.getItem("ag_session_expired")) {
      sessionStorage.removeItem("ag_session_expired");
      toast.error("Your session expired. Please sign in again.");
    }
  }, []);

  useEffect(() => {
    const onNetAuth = (e) => {
      try { setNetworkAuth(e.detail?.message || 'Network authentication required'); }
      catch { setNetworkAuth('Network authentication required'); }
    };
    window.addEventListener('network-authentication-required', onNetAuth);
    return () => window.removeEventListener('network-authentication-required', onNetAuth);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        inv_id: invId,
        login_method: loginMethod,
      };
      if (loginMethod === "password") {
        payload.password = pw;
      } else if (loginMethod === "remote_token") {
        payload.remote_token = remoteToken;
      }
      const { data } = await api.post("/auth/login", payload);
      setToken(data.token);
      setUser({ inv_id: data.inv_id, name: data.name });
      toast.success("Authenticated. Welcome back.");
      nav("/sessions");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Login failed");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen hud-bg hex-bg flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none opacity-30 bg-gradient-to-tr from-violet/20 via-transparent to-cyan/20" />
      <form onSubmit={submit} className="glass w-full max-w-md rounded-2xl p-8 z-10" data-testid="login-form">
        {networkAuth ? (
          <div className="mb-4 rounded-md p-3 bg-amber-900/40 border border-amber-700">
            <div className="font-semibold">Network Authentication Required</div>
            <div className="text-sm mt-1">{networkAuth}</div>
            <div className="text-xs mt-2 space-y-1">
              <p>1. Open your backend tunnel URL in a browser and complete any portal/gateway login.</p>
              <p>2. If this is a remote test, switch to <strong>Remote Token</strong> login and use the shared secret.</p>
              <p>3. If the tunnel still returns 511, use a different tunnel provider such as ngrok, localtunnel, or Cloudflare Tunnel.</p>
            </div>
            <button type="button" className="mt-3 btn-ghost" onClick={() => setNetworkAuth(null)}>Dismiss</button>
          </div>
        ) : null}
        <div className="flex flex-col items-center gap-2 mb-6">
          <Logo size={56} showText={false} />
          <h1 className="font-display text-3xl mt-2">AccessGuard</h1>
          <p className="text-violet text-sm">Secure Exam Monitoring System</p>
        </div>
        <div className="space-y-4">
          <div>
            <label className="label-mono">Invigilator ID</label>
            <input
              data-testid="login-id-input"
              className="input-hud mt-1"
              value={invId} onChange={(e) => setInvId(e.target.value)}
              placeholder="EG/STAFF/####"
            />
          </div>
          <div className="space-y-3">
            <label className="label-mono">Login Method</label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                type="button"
                className={`btn-outline py-2 rounded ${loginMethod === "password" ? "border-cyan text-cyan" : "text-white/70"}`}
                onClick={() => setLoginMethod("password")}
              >
                Password
              </button>
              <button
                type="button"
                className={`btn-outline py-2 rounded ${loginMethod === "remote_token" ? "border-violet text-violet" : "text-white/70"}`}
                onClick={() => setLoginMethod("remote_token")}
              >
                Remote Token
              </button>
            </div>
            <div className="text-xs text-white/40 font-mono">
              Use remote token login when accessing the app over a tunnel or remote connection.
            </div>
          </div>
          {loginMethod === "remote_token" ? (
            <div>
              <label className="label-mono">Remote Token</label>
              <input
                className="input-hud mt-1"
                value={remoteToken}
                onChange={(e) => setRemoteToken(e.target.value)}
              />
              <div className="text-xs text-white/40 mt-1 font-mono">
                Use the shared remote login token for trusted remote access.
              </div>
            </div>
          ) : null}
          {loginMethod === "password" ? (
            <div>
              <label className="label-mono">Password</label>
              <div className="relative">
                <input
                  data-testid="login-password-input"
                  className="input-hud mt-1 pr-10"
                  type={show ? "text" : "password"}
                  value={pw} onChange={(e) => setPw(e.target.value)}
                />
                <button type="button" onClick={() => setShow(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-cyan/70 hover:text-cyan"
                  data-testid="toggle-password-btn">
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          ) : null}
          <button
            type="submit"
            data-testid="login-submit-btn"
            disabled={loading}
            className="btn-cyan w-full rounded-lg py-3 flex items-center justify-center gap-2 mt-2"
          >
            {loading ? "Authenticating..." : "Authenticate & Connect"} <ChevronRight size={18} />
          </button>
          <div className="text-center label-mono mt-3">
            Server: ag-edu-server-01 • LATENCY 12ms
          </div>
        </div>
      </form>
    </div>
  );
}
