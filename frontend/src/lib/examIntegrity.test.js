import { isBrowserFullscreen, isPageFocused } from "./examIntegrity";

const windowed = (overrides = {}) => ({
  screen: { width: 1920, height: 1080 },
  outerWidth: 1920,
  outerHeight: 1040,
  matchMedia: () => ({ matches: false }),
  ...overrides,
});

describe("isBrowserFullscreen", () => {
  it("accepts HTML element fullscreen", () => {
    expect(isBrowserFullscreen(windowed(), { fullscreenElement: {} })).toBe(true);
  });

  it("accepts extension-managed window fullscreen via display-mode", () => {
    const win = windowed({ matchMedia: () => ({ matches: true }) });
    expect(isBrowserFullscreen(win, { fullscreenElement: null })).toBe(true);
  });

  it("accepts a window that covers the whole screen", () => {
    const win = windowed({ outerHeight: 1080 });
    expect(isBrowserFullscreen(win, { fullscreenElement: null })).toBe(true);
  });

  it("rejects a normal maximized window", () => {
    expect(isBrowserFullscreen(windowed(), { fullscreenElement: null })).toBe(false);
  });
});

describe("isPageFocused", () => {
  it("is false when the document is hidden", () => {
    expect(isPageFocused({ hidden: true, hasFocus: () => true })).toBe(false);
  });

  it("follows document focus when visible", () => {
    expect(isPageFocused({ hidden: false, hasFocus: () => false })).toBe(false);
    expect(isPageFocused({ hidden: false, hasFocus: () => true })).toBe(true);
  });
});
