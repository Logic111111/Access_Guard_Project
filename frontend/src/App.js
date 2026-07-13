import React from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";

import Home from "./pages/Home";
import Login from "./pages/Login";
import Sessions from "./pages/Sessions";
import CreateSession from "./pages/CreateSession";
import SessionDashboard from "./pages/SessionDashboard";
import SessionReport from "./pages/SessionReport";
import StudentEntry from "./pages/StudentEntry";
import StudentVerify from "./pages/StudentVerify";
import StudentExam from "./pages/StudentExam";
import StudentReceipt from "./pages/StudentReceipt";
import QuizPrompt from "./pages/QuizPrompt";
import LockdownQuiz from "./pages/LockdownQuiz";
import { getToken } from "./lib/api";

const Private = ({ children }) => getToken() ? children : <Navigate to="/login" replace />;

export default function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <Toaster position="top-right" theme="dark" richColors />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/sessions" element={<Private><Sessions /></Private>} />
          <Route path="/sessions/new" element={<Private><CreateSession /></Private>} />
          <Route path="/sessions/:sid/dashboard" element={<Private><SessionDashboard /></Private>} />
          <Route path="/sessions/:sid/report" element={<Private><SessionReport /></Private>} />
          <Route path="/dashboard" element={<Navigate to="/sessions" replace />} />
          <Route path="/students" element={<Navigate to="/sessions" replace />} />
          <Route path="/reports" element={<Navigate to="/sessions" replace />} />
          <Route path="/settings" element={<Navigate to="/sessions" replace />} />
          <Route path="/student" element={<StudentEntry />} />
          <Route path="/student/verify" element={<StudentVerify />} />
          <Route path="/student/exam" element={<StudentExam />} />
          <Route path="/student/receipt" element={<StudentReceipt />} />
          <Route path="/quiz/prompt" element={<QuizPrompt />} />
          <Route path="/quiz/secure" element={<LockdownQuiz />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}
