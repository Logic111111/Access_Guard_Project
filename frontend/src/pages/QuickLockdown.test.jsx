import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import QuickLockdown from "./QuickLockdown";
import { api } from "../lib/api";

jest.mock("../lib/api", () => ({
  api: { post: jest.fn() },
  getUser: jest.fn(() => ({ name: "Test Invigilator", inv_id: "EG/STAFF/0001" })),
  setToken: jest.fn(),
  setUser: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/sessions/quick"]}>
      <Routes>
        <Route path="/sessions/quick" element={<QuickLockdown />} />
        <Route path="/sessions/:sid/dashboard" element={<div>Dashboard route</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("QuickLockdown", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("requires a question before launching", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("quick-launch-btn"));
    expect(api.post).not.toHaveBeenCalled();
  });

  test("creates and starts a session, then shows the join code", async () => {
    api.post.mockResolvedValueOnce({ data: { id: "session-9", session_code: "QUIK-ABCD-EFGH" } });
    api.post.mockResolvedValueOnce({ data: { ok: true } });

    renderPage();
    await userEvent.type(screen.getByTestId("quick-question-input"), "Summarize the reading.");
    await userEvent.click(screen.getByTestId("quick-launch-btn"));

    expect(await screen.findByTestId("quick-session-code-display")).toHaveTextContent("QUIK-ABCD-EFGH");
    expect(api.post).toHaveBeenNthCalledWith(1, "/sessions", expect.objectContaining({
      require_identity_verification: false,
      require_manual_approval: false,
    }));
    expect(api.post).toHaveBeenNthCalledWith(2, "/sessions/session-9/start");
  });
});
