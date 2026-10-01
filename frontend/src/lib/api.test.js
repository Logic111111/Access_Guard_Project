import { shouldRedirectToLogin } from "./api";

function makeError({ status = 401, url = "/sessions/abc", hasAuthHeader = true } = {}) {
  return {
    response: { status },
    config: { url, headers: hasAuthHeader ? { Authorization: "Bearer stale-token" } : {} },
  };
}

describe("shouldRedirectToLogin", () => {
  it("redirects when an invigilator-authenticated request comes back 401", () => {
    expect(shouldRedirectToLogin(makeError(), "/sessions/abc/dashboard")).toBe(true);
  });

  it("does not redirect for non-401 errors", () => {
    expect(shouldRedirectToLogin(makeError({ status: 500 }), "/sessions/abc/dashboard")).toBe(false);
  });

  it("does not redirect when the request never carried an Authorization header", () => {
    // e.g. a public or candidate-token endpoint, not an invigilator session
    expect(shouldRedirectToLogin(makeError({ hasAuthHeader: false }), "/student/exam")).toBe(false);
  });

  it("does not redirect for a failed /auth/login attempt itself (Login.jsx shows its own error)", () => {
    expect(shouldRedirectToLogin(makeError({ url: "/auth/login" }), "/login")).toBe(false);
  });

  it("does not redirect if already on the login page", () => {
    expect(shouldRedirectToLogin(makeError(), "/login")).toBe(false);
  });
});
