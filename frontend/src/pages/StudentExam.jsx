import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import {
  api,
  candidateAuthConfig,
  getCandidateToken,
  getPublicBackendOrigin,
} from "../lib/api";
import {
  armLockdownExtension,
  discoverLockdownExtension,
  refreshLockdownPolicy,
  subscribeToLockdownStatus,
} from "../lib/lockdownBridge";
import {
  clearStoredAnswers,
  clearStoredBreachCount,
  clearStudentAttempt,
  getStoredAnswers,
  getStoredBreachCount,
  getStoredCandidateId,
  getStoredJoinSession,
  saveStoredAnswers,
  saveStoredBreachCount,
  saveStoredJoinSession,
} from "../lib/studentSession";
import {
  EXAM_START_GRACE_MS,
  EXTENSION_TRANSITION_GRACE_MS,
  FOCUS_LOSS_CONFIRM_MS,
  FULLSCREEN_EXIT_CONFIRM_MS,
  isBrowserFullscreen,
  isPageFocused,
} from "../lib/examIntegrity";
import { AlertTriangle, Clock, Lock, Puzzle, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const ENFORCED_EXTENSION_STATES = new Set(["armed", "enforced", "locked"]);
const RELEASED_CANDIDATE_STATES = new Set(["kicked", "rejected", "exited"]);
const READINESS_MESSAGES = {
  candidate_not_approved: "Your identity is waiting for invigilator approval.",
  candidate_pending: "Your identity is waiting for invigilator approval.",
  candidate_locked: "Your attempt is paused. Wait for the invigilator to resume it.",
  session_scheduled: "You are approved. The invigilator has not started the exam yet.",
  session_ended: "This exam session has ended.",
  extension_heartbeat_required: "The browser extension must confirm that the current lockdown policy is active.",
  time_expired: "The assessment time has expired.",
};

// Local escape hatch for developers testing both lockdown modes on one
// machine. It never ships in a production build (see Login.jsx for the same
// pattern) and it only pauses monitoring — it does not touch server state.
const IS_DEV_BUILD = process.env.NODE_ENV !== "production";

// Browser-only lockdown (no extension) has no DNR-level navigation blocking,
// so repeated confirmed exits from fullscreen/focus escalate to a real
// server-side lock — the same "locked" state the extension's prohibited_url
// report triggers — instead of only logging an event forever.
const BROWSER_LOCKDOWN_BREACH_LIMIT = 3;

function requestKeyboardLock() {
  // Best-effort Chromium-only hardening: while fullscreen, keep Escape (and
  // the shortcuts below) routed to the page instead of the browser, so
  // exiting lockdown takes a deliberate act rather than one key press. No-op
  // everywhere else.
  try {
    navigator.keyboard?.lock?.([
      "Escape", "Tab", "AltLeft", "AltRight", "MetaLeft", "MetaRight",
    ])?.catch(() => {});
  } catch {
    // Feature not supported; fullscreen + monitoring still apply.
  }
}

function releaseKeyboardLock() {
  try {
    navigator.keyboard?.unlock?.();
  } catch {
    // Nothing to release.
  }
}

function extensionIsEnforcing(value) {
  return Boolean(
    value?.enforcement ||
    value?.enforcementActive ||
    value?.enforced ||
    value?.active ||
    value?.mode === "enforced" ||
    value?.mode === "locked" ||
    value?.mode === "fail_closed" ||
    ENFORCED_EXTENSION_STATES.has(value?.state) ||
    ENFORCED_EXTENSION_STATES.has(value?.backendState)
  );
}

export default function StudentExam() {
  const nav = useNavigate();
  const [candidateId] = useState(() => getStoredCandidateId());
  const [session, setSession] = useState(() => getStoredJoinSession());
  const [status, setStatus] = useState("pending");
  const [sessionStatus, setSessionStatus] = useState(session.status || "scheduled");
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState(() => getStoredAnswers(getStoredCandidateId()));
  const [timeLeft, setTimeLeft] = useState((session.duration_minutes || 60) * 60);
  const [violations, setViolations] = useState(0);
  const [locked, setLocked] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [assessmentReady, setAssessmentReady] = useState(false);
  const [readinessReason, setReadinessReason] = useState("Awaiting invigilator approval.");
  const [extension, setExtension] = useState({ installed: null, enforcing: false, state: "detecting" });
  const [arming, setArming] = useState(false);
  const videoRef = useRef(null);
  const frameCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() => isBrowserFullscreen());
  // Integrity monitoring is paused while the student is legitimately leaving
  // (submitting / released) and during short grace windows around transitions
  // the page or extension causes itself.
  const leavingRef = useRef(false);
  const graceUntilRef = useRef(0);
  const cameraPromptRef = useRef(false);
  const extensionModeRef = useRef(null);

  const lockdownMode = session.lockdown_mode || "extension_required";
  const extensionRequired = lockdownMode === "extension_required";
  const extensionReady = !extensionRequired || extension.enforcing;
  const examReady = assessmentReady && status === "approved" && sessionStatus === "live" && extensionReady;

  const startGrace = useCallback((ms) => {
    graceUntilRef.current = Math.max(graceUntilRef.current, Date.now() + ms);
  }, []);

  const graceRemaining = useCallback(() => {
    if (cameraPromptRef.current) return FOCUS_LOSS_CONFIRM_MS;
    return Math.max(0, graceUntilRef.current - Date.now());
  }, []);

  const updateExtensionStatus = useCallback((data = {}) => {
    // Extension mode changes move the window (fullscreen/normal, focus), so the
    // resulting blur/resize must not be counted against the student.
    if (data.mode && data.mode !== extensionModeRef.current) {
      extensionModeRef.current = data.mode;
      startGrace(EXTENSION_TRANSITION_GRACE_MS);
    }
    setExtension((current) => ({
      ...current,
      ...data,
      installed: data.installed ?? current.installed ?? true,
      enforcing: extensionIsEnforcing(data),
    }));
  }, [startGrace]);

  const connectExtension = useCallback(async () => {
    if (!extensionRequired) {
      setExtension({ installed: null, enforcing: false, state: "monitor_only" });
      return;
    }
    if (!candidateId || !getCandidateToken()) return;
    setArming(true);
    try {
      const discovered = await discoverLockdownExtension();
      setExtension((current) => ({ ...current, ...discovered, installed: true }));
      const armed = await armLockdownExtension({
        candidateId,
        candidateToken: getCandidateToken(),
        apiBase: getPublicBackendOrigin(),
      });
      updateExtensionStatus({ ...armed, installed: true });
    } catch (error) {
      setExtension({ installed: false, enforcing: false, state: "missing", error: error.message });
    } finally {
      setArming(false);
    }
  }, [candidateId, extensionRequired, updateExtensionStatus]);

  useEffect(() => subscribeToLockdownStatus(updateExtensionStatus), [updateExtensionStatus]);

  useEffect(() => {
    if (!candidateId || !getCandidateToken()) {
      clearStudentAttempt();
      nav("/student");
      return;
    }
    connectExtension();
  }, [candidateId, connectExtension, nav]);

  // The server remains authoritative for admission, session state, time, and question release.
  useEffect(() => {
    if (!candidateId || RELEASED_CANDIDATE_STATES.has(status)) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const { data: candidate } = await api.get(
          `/public/candidates/${candidateId}`,
          candidateAuthConfig()
        );
        if (cancelled) return;
        setStatus(candidate.status);
        setLocked(candidate.status === "locked");
        setKicked(candidate.status === "kicked");
        if (candidate.status === "finished") {
          nav("/student/receipt", { replace: true });
          return;
        }
        if (RELEASED_CANDIDATE_STATES.has(candidate.status)) return;

        const { data } = await api.get(
          `/public/candidates/${candidateId}/assessment`,
          candidateAuthConfig()
        );
        if (cancelled) return;
        setStatus(data.candidate_status || candidate.status);
        setSessionStatus(data.session_status || "scheduled");
        setAssessmentReady(Boolean(data.ready));
        setReadinessReason(READINESS_MESSAGES[data.reason] || data.reason || "Waiting for the secure assessment to become available.");
        setQuestions(data.questions || []);
        setSession((current) => ({
          ...current,
          exam_name: data.exam_name || current.exam_name,
          exam_code: data.exam_code || current.exam_code,
          duration_minutes: data.duration_minutes || current.duration_minutes,
          lockdown_mode: data.lockdown_mode || current.lockdown_mode,
          require_fullscreen: data.require_fullscreen ?? current.require_fullscreen,
          auto_record_webcam: data.auto_record_webcam ?? current.auto_record_webcam,
          heartbeat_interval_sec: data.heartbeat_interval_sec || current.heartbeat_interval_sec,
        }));
        if (Number.isFinite(data.seconds_remaining)) {
          setTimeLeft((current) => Math.abs(current - data.seconds_remaining) > 3 ? data.seconds_remaining : current);
        }
        if (data.extension_verified && extension.installed) {
          setExtension((current) => ({ ...current, enforcing: true }));
        }
      } catch (error) {
        if (!cancelled && [401, 403, 404].includes(error?.response?.status)) {
          clearStudentAttempt();
          toast.error("Your secure student session expired. Please join again.");
          nav("/student");
        }
      }
    };

    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [candidateId, extension.installed, nav, status]);

  useEffect(() => {
    if (!candidateId) return;
    saveStoredAnswers(candidateId, answers);
  }, [answers, candidateId]);

  useEffect(() => {
    if (session && Object.keys(session).length) saveStoredJoinSession(session);
  }, [session]);

  useEffect(() => {
    if (!RELEASED_CANDIDATE_STATES.has(status)) return;
    leavingRef.current = true;
    // Let the extension observe the terminal policy before removing web recovery data.
    refreshLockdownPolicy()
      .catch(() => {})
      .finally(() => clearStudentAttempt());
  }, [status]);

  // Camera monitoring starts only after the assessment is genuinely ready.
  useEffect(() => {
    if (!examReady || session.auto_record_webcam === false) return;
    let cancelled = false;
    (async () => {
      // The browser permission prompt takes focus from the page; that is not
      // a student leaving the exam.
      cameraPromptRef.current = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240 },
          audio: false,
        }).finally(() => {
          cameraPromptRef.current = false;
          startGrace(EXTENSION_TRANSITION_GRACE_MS);
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStreaming(true);
      } catch {
        toast.warning("Camera monitoring is unavailable. The invigilator has been notified through heartbeat status.");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStreaming(false);
    };
  }, [examReady, session.auto_record_webcam, startGrace]);

  useEffect(() => {
    if (!candidateId || !examReady || !streaming) return;
    const send = () => {
      const video = videoRef.current;
      const canvas = frameCanvasRef.current;
      if (!video?.videoWidth || !canvas) return;
      canvas.width = 320;
      canvas.height = 240;
      canvas.getContext("2d").drawImage(video, 0, 0, 320, 240);
      api.post("/public/frames", {
        candidate_id: candidateId,
        candidate_token: getCandidateToken(),
        image_b64: canvas.toDataURL("image/jpeg", 0.5),
      }, candidateAuthConfig()).catch(() => {});
    };
    send();
    const timer = window.setInterval(send, 3000);
    return () => window.clearInterval(timer);
  }, [candidateId, examReady, streaming]);

  useEffect(() => {
    if (!candidateId || status !== "approved") return;
    const send = () => api.post("/public/heartbeats", {
      candidate_id: candidateId,
      latency_ms: 0,
      bandwidth: navigator.connection?.effectiveType || "unknown",
      face_visible: streaming && !document.hidden,
      tab_active: !document.hidden,
      note: extensionReady ? "extension-enforced" : "extension-not-enforced",
    }, candidateAuthConfig()).catch(() => {});
    send();
    const timer = window.setInterval(send, Number(session.heartbeat_interval_sec || 10) * 1000);
    return () => window.clearInterval(timer);
  }, [candidateId, extensionReady, session.heartbeat_interval_sec, status, streaming]);

  const reportViolation = useCallback((kind, detail) => {
    if (!candidateId || !examReady || leavingRef.current) return;
    api.post("/public/violations", {
      candidate_id: candidateId,
      kind,
      detail,
    }, candidateAuthConfig()).then(({ data }) => {
      if (!data?.duplicate) setViolations((value) => value + 1);
    }).catch(() => {});
  }, [candidateId, examReady]);

  // Leaving the required fullscreen/focus state in browser-only lockdown is
  // logged like any other event, but it also counts toward a hard limit.
  // Reaching it reports lockdown_bypass, which the backend treats as a real
  // lock — the same enforcement the extension gets from blocking navigation
  // outright. Extension-required sessions already have that DNR-level block,
  // so they are not escalated here.
  const recordLockdownBreach = useCallback((kind, detail) => {
    reportViolation(kind, detail);
    if (extensionRequired || !candidateId) return;
    const count = getStoredBreachCount(candidateId) + 1;
    saveStoredBreachCount(candidateId, count);
    if (count >= BROWSER_LOCKDOWN_BREACH_LIMIT) {
      reportViolation(
        "lockdown_bypass",
        `Left the required browser lockdown ${count} times without the extension (latest: ${kind}).`
      );
    }
  }, [candidateId, extensionRequired, reportViolation]);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(isBrowserFullscreen());
    document.addEventListener("fullscreenchange", syncFullscreen);
    window.addEventListener("resize", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      window.removeEventListener("resize", syncFullscreen);
    };
  }, []);

  // Focus and fullscreen changes are only reported once they persist. Brief
  // transitions (extension focusing/fullscreening the window, permission
  // prompts, release after submit) are ignored, and each away period counts once.
  useEffect(() => {
    if (!examReady) return;
    startGrace(EXAM_START_GRACE_MS);
    const requireFullscreen = session.require_fullscreen !== false;
    let focusTimer = null;
    let fullscreenTimer = null;
    let focusReported = false;
    let fullscreenReported = false;

    const checkFocus = () => {
      focusTimer = null;
      if (leavingRef.current) return;
      if (isPageFocused()) {
        focusReported = false;
        return;
      }
      const wait = graceRemaining();
      if (wait > 0) {
        focusTimer = window.setTimeout(checkFocus, wait);
        return;
      }
      if (focusReported) return;
      focusReported = true;
      if (document.hidden) {
        recordLockdownBreach("tab_switch", "Exam tab was hidden");
      } else {
        recordLockdownBreach("focus_lost", "Exam window lost focus");
      }
    };
    const scheduleFocusCheck = () => {
      if (!focusTimer) focusTimer = window.setTimeout(checkFocus, FOCUS_LOSS_CONFIRM_MS);
    };

    const checkFullscreen = () => {
      fullscreenTimer = null;
      if (leavingRef.current || !requireFullscreen) return;
      if (isBrowserFullscreen()) {
        fullscreenReported = false;
        return;
      }
      const wait = graceRemaining();
      if (wait > 0) {
        fullscreenTimer = window.setTimeout(checkFullscreen, wait);
        return;
      }
      if (fullscreenReported) return;
      fullscreenReported = true;
      recordLockdownBreach("fullscreen_exit", "Exited fullscreen mode");
      toast.warning("Fullscreen exited. Return to fullscreen to continue the exam.");
    };
    const scheduleFullscreenCheck = () => {
      if (!fullscreenTimer) fullscreenTimer = window.setTimeout(checkFullscreen, FULLSCREEN_EXIT_CONFIRM_MS);
    };

    const onVisibilityChange = () => {
      if (document.hidden) scheduleFocusCheck();
    };
    const onKeyDown = (event) => {
      const key = event.key.toLowerCase();
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const devToolsShortcut =
        event.key === "F12" ||
        (ctrlOrMeta && event.shiftKey && ["i", "j", "c"].includes(key));
      const printSaveShortcut = ctrlOrMeta && ["p", "s", "u"].includes(key);
      // Chrome deliberately ignores preventDefault() for new-tab/window/close,
      // but the attempt is still worth blocking where possible and logging.
      const newSurfaceShortcut = ctrlOrMeta && ["t", "n", "w"].includes(key);
      const zoomShortcut = ctrlOrMeta && ["+", "-", "=", "0"].includes(event.key);
      const blocked = devToolsShortcut || printSaveShortcut || newSurfaceShortcut || zoomShortcut;
      if (blocked) {
        event.preventDefault();
        reportViolation("blocked_shortcut", `Blocked shortcut: ${event.key}`);
      }
    };
    const onWheel = (event) => {
      // Ctrl/Cmd + wheel is browser zoom.
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    const onGestureStart = (event) => event.preventDefault();
    const onCopy = (event) => {
      event.preventDefault();
      reportViolation("copy_attempt", "Copy attempt blocked in assessment page");
    };
    const onContextMenu = (event) => event.preventDefault();

    // Traps the browser/trackpad back-and-forward gesture inside this route
    // instead of letting it navigate the student away from the exam.
    let trapPopState = false;
    const armHistoryTrap = () => {
      trapPopState = true;
      window.history.pushState(null, "", window.location.href);
    };
    const onPopState = () => {
      if (!trapPopState) return;
      armHistoryTrap();
      recordLockdownBreach("tab_switch", "Browser back/forward navigation blocked");
    };
    armHistoryTrap();

    window.addEventListener("blur", scheduleFocusCheck);
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("fullscreenchange", scheduleFullscreenCheck);
    window.addEventListener("resize", scheduleFullscreenCheck);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("gesturestart", onGestureStart);
    document.addEventListener("copy", onCopy);
    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("popstate", onPopState);
    // Catch a window that was never fullscreen once the start grace ends.
    scheduleFullscreenCheck();
    return () => {
      trapPopState = false;
      window.clearTimeout(focusTimer);
      window.clearTimeout(fullscreenTimer);
      window.removeEventListener("blur", scheduleFocusCheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("fullscreenchange", scheduleFullscreenCheck);
      window.removeEventListener("resize", scheduleFullscreenCheck);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("gesturestart", onGestureStart);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("popstate", onPopState);
    };
  }, [examReady, graceRemaining, recordLockdownBreach, reportViolation, session.require_fullscreen, startGrace]);

  useEffect(() => {
    if (!examReady || locked) return;
    const timer = window.setInterval(() => setTimeLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [examReady, locked]);

  const submit = useCallback(async () => {
    if (!examReady || submitting) return;
    setSubmitting(true);
    // Submitting releases the extension, which restores the window from
    // fullscreen. That exit is the student leaving, not a violation.
    leavingRef.current = true;
    releaseKeyboardLock();
    try {
      await api.post("/public/answers", { candidate_id: candidateId, answers }, candidateAuthConfig());
      clearStoredAnswers(candidateId);
      await refreshLockdownPolicy().catch(() => {});
      toast.success("Your exam was submitted securely.");
      nav("/student/receipt", { replace: true });
    } catch (error) {
      leavingRef.current = false;
      startGrace(EXTENSION_TRANSITION_GRACE_MS);
      toast.error(error?.response?.data?.detail || "Submission failed. Your local draft is still saved.");
    } finally {
      setSubmitting(false);
    }
  }, [answers, candidateId, examReady, nav, startGrace, submitting]);

  useEffect(() => {
    if (timeLeft === 0 && examReady) submit();
  }, [examReady, submit, timeLeft]);

  const enterFullscreen = () => {
    startGrace(EXTENSION_TRANSITION_GRACE_MS);
    document.documentElement.requestFullscreen?.({ navigationUI: "hide" })
      .then(requestKeyboardLock)
      .catch(() => {
        toast.error("Fullscreen could not be started. Check your browser permissions.");
      });
  };

  // The browser-only lockdown path (no extension): fullscreen + best-effort
  // keyboard lock is the whole enforcement, so it must start from this direct
  // click (browsers refuse requestFullscreen() without a user gesture).
  const beginSecureLockdown = () => {
    startGrace(EXAM_START_GRACE_MS);
    document.documentElement.requestFullscreen?.({ navigationUI: "hide" })
      .then(requestKeyboardLock)
      .catch(() => {
        toast.error("Fullscreen could not be started. Allow fullscreen for this site and try again.");
      });
  };

  const exitLockdownForTesting = useCallback(() => {
    // Dev-build only (see IS_DEV_BUILD). Pauses violation reporting for 10
    // minutes and resets the breach counter so switching between extension
    // and browser-only lockdown on one laptop doesn't rack up fake events or
    // trip the real lockdown_bypass lock while testing, then resumes on its own.
    startGrace(10 * 60 * 1000);
    if (candidateId) clearStoredBreachCount(candidateId);
    releaseKeyboardLock();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    toast.info("Lockdown paused for local testing (10 min). Not available in production builds.");
  }, [candidateId, startGrace]);

  // A student who is locked, kicked, or otherwise released should not be left
  // stuck in fullscreen with the keyboard captured.
  useEffect(() => {
    if (examReady) return;
    releaseKeyboardLock();
  }, [examReady]);

  // Discourage closing or navigating away mid-exam. Browsers show their own
  // generic prompt; custom text is intentionally not shown by any browser.
  useEffect(() => {
    if (!examReady) return;
    const onBeforeUnload = (event) => {
      if (leavingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [examReady]);

  const fmt = (seconds) => `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  const requireFullscreen = session.require_fullscreen !== false;
  // Without the extension, fullscreen + keyboard lock is the entire browser
  // lockdown, so the exam content stays behind a gate until it is engaged.
  const needsLockdownGate = examReady && !extensionRequired && requireFullscreen && !isFullscreen;

  if (locked) {
    return (
      <StateScreen icon={Lock} title="EXAM LOCKED" testid="locked-screen">
        This attempt was automatically locked after a monitoring event, or paused by the invigilator. Stay on this screen until the invigilator reviews it and resumes your attempt.
      </StateScreen>
    );
  }

  if (kicked || RELEASED_CANDIDATE_STATES.has(status)) {
    return (
      <StateScreen icon={AlertTriangle} title="SESSION TERMINATED" testid="kicked-screen">
        Your access has been ended by the invigilator. The extension will release its browser policy after confirming this state with the server.
      </StateScreen>
    );
  }

  return (
    <div className="min-h-screen hud-bg p-6 select-none">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <Logo />
          <div className="flex items-center gap-3 flex-wrap justify-end">
            <LockdownBadge
              required={extensionRequired}
              extension={extension}
              isFullscreen={isFullscreen}
              requireFullscreen={requireFullscreen}
            />
            {examReady && extensionRequired && requireFullscreen && !isFullscreen && (
              <button onClick={enterFullscreen} className="btn-cyan text-xs px-3 py-1.5 rounded-lg font-mono">
                Enter Fullscreen
              </button>
            )}
            {IS_DEV_BUILD && examReady && (
              <button
                onClick={exitLockdownForTesting}
                data-testid="exit-lockdown-testing-btn"
                title="Local testing only. Pauses monitoring for 10 minutes; absent in production builds."
                className="btn-ghost-violet text-xs px-3 py-1.5 rounded-lg font-mono"
              >
                Exit Lockdown (test)
              </button>
            )}
            <div className="glass rounded-lg px-4 py-2 flex items-center gap-2 font-mono text-sm" data-testid="exam-timer">
              <Clock size={14} className="text-cyan" /> {fmt(timeLeft)}
            </div>
            <div className="glass rounded-lg px-3 py-2 font-mono text-xs">
              <span className="text-violation font-bold">{violations} Events</span>
            </div>
          </div>
        </div>

        {extensionRequired && extension.installed === false && (
          <div className="glass neon-red rounded-xl p-5 mb-5" data-testid="extension-required">
            <div className="flex gap-3 items-start">
              <Puzzle className="text-violation mt-0.5" size={22} />
              <div className="flex-1">
                <h2 className="font-display text-lg text-violation">AccessGuard extension required</h2>
                <p className="text-sm text-white/65 mt-1">
                  Install and enable the supplied Chrome extension, then retry. Questions are withheld until browser enforcement is confirmed.
                </p>
              </div>
              <button onClick={connectExtension} disabled={arming} className="btn-ghost-cyan rounded-lg px-3 py-2 text-xs flex gap-2 items-center">
                <RefreshCw size={14} className={arming ? "animate-spin" : ""} /> Retry
              </button>
            </div>
          </div>
        )}

        {!examReady && (
          <div className="glass rounded-2xl p-10 text-center" data-testid="awaiting-approval">
            <div className="font-display text-2xl text-cyan">
              {status === "rejected" ? "Access denied" : "Secure assessment is not ready yet"}
            </div>
            <p className="text-white/60 mt-2">{readinessReason}</p>
            <div className="mt-6 inline-block dot-pulse text-online font-mono text-sm">
              {status === "pending" ? "AWAITING INVIGILATOR" : sessionStatus !== "live" ? "AWAITING SESSION START" : "SECURITY PREFLIGHT"}
            </div>
          </div>
        )}

        {examReady && (
          <div className="space-y-6">
            {/* Always mounted once the exam is ready so the camera stream stays
                attached across the lockdown gate below; only its visibility changes. */}
            <div className="glass rounded-xl p-5 flex items-start gap-4">
              <div className="flex-1">
                <div className="label-mono">EXAM</div>
                <h1 className="font-display text-2xl">{session.exam_name}</h1>
                <p className="text-xs text-white/50 mt-2">
                  {extensionRequired
                    ? "Browser restrictions are enforced by the extension. On unmanaged devices, other applications and devices remain outside browser control."
                    : "This exam is locked to a fullscreen browser window with activity monitoring. It does not require an extension, and it cannot restrict other applications on unmanaged devices."}
                </p>
              </div>
              {session.auto_record_webcam !== false && (
                <div className="relative w-32 h-24 rounded-lg overflow-hidden border border-cyan/40 neon-cyan flex-shrink-0" data-testid="webcam-preview">
                  <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
                  <canvas ref={frameCanvasRef} className="hidden" />
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-void/80 text-[9px] font-mono text-online dot-pulse">REC</div>
                </div>
              )}
            </div>

            {needsLockdownGate ? (
              <div className="glass neon-cyan rounded-2xl p-10 text-center" data-testid="lockdown-gate">
                <ShieldCheck size={48} className="text-cyan mx-auto mb-4" />
                <div className="font-display text-2xl text-cyan">Secure browser lockdown required</div>
                <p className="text-white/60 mt-2 max-w-md mx-auto">
                  Questions unlock once this window is fullscreen and monitored. No extension is needed for this session,
                  but leaving fullscreen hides the questions again and is recorded as an event —
                  {" "}{BROWSER_LOCKDOWN_BREACH_LIMIT} events will lock the attempt for invigilator review.
                </p>
                <button
                  onClick={beginSecureLockdown}
                  data-testid="begin-lockdown-btn"
                  className="btn-cyan rounded-full px-6 py-2.5 mt-6 font-semibold"
                >
                  Begin Secure Exam
                </button>
              </div>
            ) : (
              <>
                {questions.map((question, index) => (
                  <QuestionCard
                    key={question.id}
                    question={question}
                    index={index}
                    value={answers[question.id] || ""}
                    onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))}
                  />
                ))}

                <div className="flex justify-end">
                  <button onClick={submit} disabled={submitting} data-testid="submit-exam-btn" className="btn-cyan rounded-full px-6 py-2.5 flex items-center gap-2 font-semibold disabled:opacity-50">
                    <Send size={16} /> {submitting ? "Submitting..." : "Submit Exam"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LockdownBadge({ required, extension, isFullscreen, requireFullscreen }) {
  if (!required) {
    const engaged = !requireFullscreen || isFullscreen;
    return (
      <div
        className={`glass px-3 py-1.5 rounded-lg border flex items-center gap-2 text-xs font-mono ${engaged ? "border-online/40 text-online" : "border-warning/40 text-warning"}`}
        data-testid="lockdown-status"
      >
        {engaged ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
        {engaged ? "BROWSER LOCKDOWN ENGAGED" : "LOCKDOWN PENDING"}
      </div>
    );
  }
  const active = extension.enforcing;
  return (
    <div className={`glass px-3 py-1.5 rounded-lg border flex items-center gap-2 text-xs font-mono ${active ? "border-online/40 text-online" : "border-warning/40 text-warning"}`} data-testid="lockdown-status">
      {active ? <ShieldCheck size={13} /> : <Puzzle size={13} />}
      {active ? "BROWSER LOCKDOWN ENFORCED" : "LOCKDOWN PREFLIGHT"}
    </div>
  );
}

function StateScreen({ icon: Icon, title, children, testid }) {
  return (
    <div className="min-h-screen hud-bg flex items-center justify-center p-6">
      <div className="glass neon-red rounded-2xl p-10 text-center max-w-md" data-testid={testid}>
        <Icon size={48} className="text-violation mx-auto mb-4" />
        <h1 className="font-display text-3xl text-violation">{title}</h1>
        <p className="text-white/70 mt-3">{children}</p>
      </div>
    </div>
  );
}

function QuestionCard({ question, index, value, onChange }) {
  return (
    <div className="glass rounded-xl p-5" data-testid={`question-${question.id}`}>
      <div className="label-mono">QUESTION {index + 1} • {question.marks || 10} MARKS</div>
      <div className="font-display text-lg mt-2">{question.text}</div>
      {question.type === "mcq" ? (
        <div className="mt-4 space-y-3">
          {["A", "B", "C", "D"].map((letter, optionIndex) => {
            const option = (question.options || [])[optionIndex] || "";
            if (!option) return null;
            return (
              <label key={letter} className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-violet/10 hover:bg-cyan/5 transition-colors">
                <input type="radio" name={`question-${question.id}`} value={letter} checked={value === letter} onChange={() => onChange(letter)} className="accent-cyan w-4 h-4" data-testid={`option-${question.id}-${letter}`} />
                <span className="font-mono text-cyan font-bold">{letter}.</span>
                <span className="text-sm">{option}</span>
              </label>
            );
          })}
        </div>
      ) : (
        <textarea data-testid={`answer-${question.id}`} className="input-hud mt-4 min-h-[140px] font-sans" placeholder="Type your answer here..." value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  );
}
