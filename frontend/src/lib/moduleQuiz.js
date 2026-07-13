export function buildQuizPromptUrl({ module, studentId, name, quiz }) {
  const params = new URLSearchParams();
  if (module) params.set("module", module.toUpperCase());
  if (studentId) params.set("student_id", studentId);
  if (name) params.set("name", name);
  if (quiz?.session_code) params.set("code", quiz.session_code.toUpperCase());
  return `/quiz/prompt?${params.toString()}`;
}

export function openQuizPromptInModuleContext({ module, studentId, name, quiz }) {
  const url = buildQuizPromptUrl({ module, studentId, name, quiz });
  if (typeof window === "undefined") return url;
  const target = window.location.origin + url;
  window.history.replaceState({}, "", url);
  return target;
}
