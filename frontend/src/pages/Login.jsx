import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api, setToken, setUser } from "../lib/api";
import { Eye, EyeOff, ChevronRight } from "lucide-react";
import { toast } from "sonner";

export default function Login() {
  const nav = useNavigate();
  const location = useLocation();
  const [invId, setInvId] = useState("EG/STAFF/0001");
  const [pw, setPw] = useState("AccessGuard2026!");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loginMethod, setLoginMethod] = useState("password");
  const [remoteToken, setRemoteToken] = useState("remote-access-2026");
  const [networkAuth, setNetworkAuth] = useState(null);
  const [requesting2fa, setRequesting2fa] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const queryInvId = params.get("inv_id") || params.get("invId") || params.get("invigilator") || invId;
    const queryMethod = params.get("login_method") || params.get("method") || loginMethod;
    const queryPassword = params.get("password") || "";
    const queryRemoteToken = params.get("remote_token") || params.get("token") || remoteToken;

    setInvId(queryInvId);
    setLoginMethod(queryMethod);
    if (queryPassword) setPw(queryPassword);
    if (queryRemoteToken) setRemoteToken(queryRemoteToken);
  }, [location.search]);

  useEffect(() => {
    const onNetAuth = (e) => {
      try { setNetworkAuth(e.detail?.message || 'Network authentication required'); }
      catch { setNetworkAuth('Network authentication required'); }
    };
    window.addEventListener('network-authentication-required', onNetAuth);
    return () => window.removeEventListener('network-authentication-required', onNetAuth);
  }, []);

  const setOtpAt = (i, v) => {
    if (!/^[0-9]?$/.test(v)) return;
    const arr = [...otp]; arr[i] = v; setOtp(arr);
    if (v && i < 5) document.getElementById(`otp-${i + 1}`)?.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const code = otp.join("");
      const payload = {
        inv_id: invId,
        login_method: loginMethod,
      };
      if (loginMethod === "password") {
        payload.password = pw;
        payload.two_factor = code.length === 6 ? code : "000000";
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

  const request2fa = async () => {
    setRequesting2fa(true);
    try {
      const { data } = await api.post("/auth/request-2fa", { inv_id: invId });
      toast.success(`2FA code (test): ${data.code}`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to request 2FA");
    } finally { setRequesting2fa(false); }
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
                Password + 2FA
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
                Use the shared remote login token. This bypasses password/2FA for trusted remote access.
              </div>
            </div>
          ) : null}
          {loginMethod === "password" ? (
            <>
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
              <div>
                <label className="label-mono">Two-Factor Code</label>
                <div className="flex gap-2 mt-1">
                  {otp.map((v, i) => (
                    <input
                      key={i}
                      id={`otp-${i}`}
                      data-testid={`otp-input-${i}`}
                      value={v}
                      onChange={(e) => setOtpAt(i, e.target.value)}
                      maxLength={1}
                      className="input-hud text-center text-lg w-12 px-0"
                    />
                  ))}
                </div>
                <div className="text-xs text-white/40 mt-1 font-mono">Demo: any 6 digits</div>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" onClick={request2fa} disabled={requesting2fa}
                    className="btn-outline px-3 py-1 rounded">
                    {requesting2fa ? "Requesting…" : "Request 2FA Code"}
                  </button>
                  <div className="text-xs text-white/50">The code is returned in the response for testing purposes.</div>
                </div>
              </div>
            </>
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
