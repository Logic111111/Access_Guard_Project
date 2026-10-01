// Timing used to separate real student behaviour from transient focus and
// fullscreen changes caused by the browser, permission prompts, or the
// AccessGuard extension itself (window focus/fullscreen and release on submit).
export const FOCUS_LOSS_CONFIRM_MS = 1500;
export const FULLSCREEN_EXIT_CONFIRM_MS = 2000;
export const EXAM_START_GRACE_MS = 5000;
export const EXTENSION_TRANSITION_GRACE_MS = 2500;

// The extension enforces fullscreen at the browser-window level (F11-style),
// which does not set document.fullscreenElement. Treat either form as
// fullscreen so extension-managed windows are not reported as violations.
export function isBrowserFullscreen(win = window, doc = document) {
  if (doc?.fullscreenElement) return true;
  try {
    if (win?.matchMedia?.("(display-mode: fullscreen)")?.matches) return true;
  } catch {
    // matchMedia is unavailable in some embedded/test environments.
  }
  const screen = win?.screen;
  if (!screen?.width || !screen?.height) return false;
  return win.outerWidth >= screen.width && win.outerHeight >= screen.height;
}

export function isPageFocused(doc = document) {
  if (doc?.hidden) return false;
  return typeof doc?.hasFocus === "function" ? doc.hasFocus() : true;
}
