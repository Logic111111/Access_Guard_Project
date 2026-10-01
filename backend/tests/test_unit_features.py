"""Unit tests for new features: Tab Lockdown helper metrics, AI Grading Fallback, Statistical Engine, and 2FA-free Login."""
import pytest
from fastapi.testclient import TestClient
import server
from server import (
    app,
    fallback_semantic_score,
    build_grading_items,
    assemble_grade_docs,
    grading_config_warnings,
    resolve_admin_password,
    production_config_errors,
)

client = TestClient(app)

def test_fallback_semantic_score_exact_match():
    score, feedback = fallback_semantic_score("Photosynthesis converts light into chemical energy", "Photosynthesis converts light into chemical energy")
    assert score == 10.0
    assert "Exact match" in feedback

def test_fallback_semantic_score_partial_match():
    score, feedback = fallback_semantic_score("Photosynthesis converts light into energy", "Photosynthesis converts sunlight into chemical energy")
    assert 5.0 <= score <= 10.0
    assert "Automated evaluation score" in feedback

def test_fallback_semantic_score_empty():
    score, feedback = fallback_semantic_score("", "Model answer")
    assert score == 0.0
    assert "No response provided" in feedback

def test_build_grading_items_creates_one_item_per_answer_per_question():
    answers = [
        {"candidate_id": "c1", "answers": {"q1": "student answer 1"}},
        {"candidate_id": "c2", "answers": {"q1": "student answer 2"}},
    ]
    model_ans = {"q1": "model answer"}
    marks_map = {"q1": 5.0}
    type_map = {"q1": "text"}
    text_map = {"q1": "What is X?"}

    items, index_map = build_grading_items(answers, model_ans, marks_map, type_map, text_map)

    assert len(items) == 2
    assert items[0]["question_id"] == "q1"
    assert items[0]["student_answer"] == "student answer 1"
    assert items[0]["max_marks"] == 5.0
    assert index_map[0] == ("c1", "q1", 5.0)
    assert index_map[1] == ("c2", "q1", 5.0)


def test_build_grading_items_defaults_missing_student_answer_and_marks():
    answers = [{"candidate_id": "c1", "answers": {}}]
    items, index_map = build_grading_items(answers, {"q1": "model"}, {}, {}, {})
    assert items[0]["student_answer"] == ""
    assert items[0]["max_marks"] == 10.0
    assert index_map[0] == ("c1", "q1", 10.0)


def test_assemble_grade_docs_groups_by_candidate_and_sums_scores():
    index_map = [("c1", "q1", 5.0), ("c1", "q2", 5.0), ("c2", "q1", 5.0)]
    results = [
        {"score": 4.0, "method": "mcq_exact"},
        {"score": 3.0, "method": "vector_fallback"},
        {"score": 5.0, "method": "mcq_exact"},
    ]
    docs = assemble_grade_docs("sess1", index_map, results)
    by_candidate = {d["candidate_id"]: d for d in docs}
    assert by_candidate["c1"]["total"] == 7.0
    assert by_candidate["c1"]["max_total"] == 10.0
    assert set(by_candidate["c1"]["per_question"].keys()) == {"q1", "q2"}
    assert by_candidate["c2"]["total"] == 5.0
    assert all(d["session_id"] == "sess1" for d in docs)
    assert all(d["rag_graded"] is True for d in docs)


def test_grading_config_warnings_empty_outside_production(monkeypatch):
    monkeypatch.setattr(server, "IS_PRODUCTION", False)
    monkeypatch.setattr(server, "EMERGENT_LLM_KEY", "")
    monkeypatch.setattr(server, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(server, "OPENAI_API_KEY", "")
    monkeypatch.setattr(server, "GEMINI_API_KEY", "")
    assert grading_config_warnings() == []


def test_grading_config_warnings_flags_missing_keys_in_production(monkeypatch):
    monkeypatch.setattr(server, "IS_PRODUCTION", True)
    monkeypatch.setattr(server, "EMERGENT_LLM_KEY", "")
    monkeypatch.setattr(server, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(server, "OPENAI_API_KEY", "")
    monkeypatch.setattr(server, "GEMINI_API_KEY", "")
    warnings = grading_config_warnings()
    assert len(warnings) == 1
    assert "fallback" in warnings[0].lower()


def test_grading_config_warnings_silent_when_any_key_present_in_production(monkeypatch):
    monkeypatch.setattr(server, "IS_PRODUCTION", True)
    monkeypatch.setattr(server, "EMERGENT_LLM_KEY", "")
    monkeypatch.setattr(server, "ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(server, "OPENAI_API_KEY", "")
    monkeypatch.setattr(server, "GEMINI_API_KEY", "")
    assert grading_config_warnings() == []


def test_resolve_admin_password_uses_configured_value():
    password, generated = resolve_admin_password("MyConfiguredSecret1!")
    assert password == "MyConfiguredSecret1!"
    assert generated is False


def test_resolve_admin_password_generates_when_unconfigured():
    password, generated = resolve_admin_password("")
    assert generated is True
    assert password != "password"
    assert len(password) >= 12


def test_resolve_admin_password_generated_values_are_not_repeated():
    password_a, _ = resolve_admin_password("")
    password_b, _ = resolve_admin_password("")
    assert password_a != password_b


def test_production_config_errors_rejects_empty_admin_password(monkeypatch):
    monkeypatch.setattr(server, "IS_PRODUCTION", True)
    monkeypatch.setattr(server, "JWT_SECRET", "x" * 40)
    monkeypatch.setattr(server, "ADMIN_PASSWORD", "")
    monkeypatch.setattr(server, "REMOTE_LOGIN_SECRET", "not-the-default")
    monkeypatch.setenv("CORS_ORIGINS", "https://exam.example.edu")
    errors = production_config_errors()
    assert any("ADMIN_PASSWORD" in e for e in errors)


def test_login_endpoint_without_2fa(live_client):
    # Uses the explicit, dev-only /api/test/seed invigilator rather than a credential
    # baked into startup seeding, since AccessGuard no longer auto-seeds a fixed
    # test invigilator on every boot. Uses the shared session-scoped live_client
    # fixture (see conftest.py) rather than its own `with TestClient(app)`, since
    # opening more than one across the test session breaks the shared Motor client.
    live_client.post("/api/test/seed")
    response = live_client.post("/api/auth/login", json={
        "inv_id": "INV0001",
        "password": "Password123!",
        "login_method": "password"
    })
    assert response.status_code == 200
    data = response.json()
    assert "token" in data
    assert data["inv_id"] == "INV0001"
