import React from "react";
import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders home page with invigilator and student selection", () => {
  render(<App />);

  const invigilatorButton = screen.getByTestId("invigilator-cta");
  const studentButton = screen.getByTestId("student-cta");
  const heading = screen.getByRole("heading", { name: /AccessGuard/i });

  expect(heading).toBeInTheDocument();
  expect(invigilatorButton).toBeInTheDocument();
  expect(studentButton).toBeInTheDocument();
});