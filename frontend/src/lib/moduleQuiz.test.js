import { buildQuizPromptUrl } from "./moduleQuiz";

describe("buildQuizPromptUrl", () => {
  it("includes module and student context in the prompt route", () => {
    const url = buildQuizPromptUrl({
      module: "EE5203",
      studentId: "eg245295",
      name: "EG245295",
      quiz: { session_code: "7204-B782-2C35" },
    });

    expect(url).toBe("/quiz/prompt?module=EE5203&student_id=eg245295&name=EG245295&code=7204-B782-2C35");
  });
});
