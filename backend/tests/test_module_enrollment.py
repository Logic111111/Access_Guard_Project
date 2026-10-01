"""Integration tests for module enrollment: invigilator-owned modules, student
accounts, and enrollment-gated quiz visibility. Run against the local dev Mongo
(same convention as test_unit_features.py::test_login_endpoint_without_2fa).

Each test registers its own throwaway invigilator (random inv_id) rather than
using the shared INV0001/admin accounts real users log in with — modules
created here would otherwise show up directly in a real invigilator's own
popup module list, which is exactly what happened before this fix.
"""
import secrets

import pytest


@pytest.fixture
def client(live_client):
    return live_client


def _fresh_invigilator_token(client):
    inv_id = f"TEST-MODULE-INV-{secrets.token_hex(4)}"
    resp = client.post("/api/auth/register", json={
        "inv_id": inv_id, "name": "Test Module Invigilator", "password": "TestPass123!",
    })
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


def test_module_lifecycle_and_enrollment_flow(client):
    token = _fresh_invigilator_token(client)
    headers = {"Authorization": f"Bearer {token}"}

    # Create a module.
    resp = client.post("/api/modules", json={"code": "e2etest01", "name": "Power Electronics"}, headers=headers)
    assert resp.status_code == 200, resp.text
    module = resp.json()
    assert module["code"] == "E2ETEST01"
    assert module["enroll_code"]

    # Duplicate code for the same owner is rejected.
    dup = client.post("/api/modules", json={"code": "E2ETEST01", "name": "Dup"}, headers=headers)
    assert dup.status_code == 409

    # Listing returns it with the enroll_code visible to the owner.
    listed = client.get("/api/modules", headers=headers)
    assert listed.status_code == 200
    assert any(m["id"] == module["id"] for m in listed.json())

    # A student self-registers using the enroll code.
    join = client.post("/api/student/auth/join", json={
        "enroll_code": module["enroll_code"],
        "student_id": f"EG/TEST/{secrets.token_hex(3)}",
        "full_name": "Jane Student",
        "password": "StudentPass1!",
    })
    assert join.status_code == 200, join.text
    student_id = join.json()["student_id"]
    student_token = join.json()["token"]
    student_headers = {"Authorization": f"Bearer {student_token}"}

    # The same account, re-used, verifies the password on a second join to the
    # same module (idempotent) rather than erroring.
    rejoin = client.post("/api/student/auth/join", json={
        "enroll_code": module["enroll_code"],
        "student_id": student_id,
        "full_name": "Ignored On Rejoin",
        "password": "StudentPass1!",
    })
    assert rejoin.status_code == 200

    # Wrong password for an existing student_id is rejected.
    bad_pw = client.post("/api/student/auth/join", json={
        "enroll_code": module["enroll_code"],
        "student_id": student_id,
        "full_name": "Jane Student",
        "password": "WrongPassword!",
    })
    assert bad_pw.status_code == 401

    # Plain login works too.
    login = client.post("/api/student/auth/login", json={
        "student_id": student_id, "password": "StudentPass1!",
    })
    assert login.status_code == 200

    # Profile lists the enrolled module.
    me = client.get("/api/student/me", headers=student_headers)
    assert me.status_code == 200
    assert any(m["code"] == "E2ETEST01" for m in me.json()["modules"])

    # Enrolled student can query that module's quizzes (empty list, none published).
    quizzes = client.get("/api/student/modules/E2ETEST01/quizzes", headers=student_headers)
    assert quizzes.status_code == 200
    assert quizzes.json() == []

    # A student not enrolled in a *different* module is forbidden, not 404'd.
    other = client.post("/api/modules", json={"code": "E2ETEST02", "name": "Other Module"}, headers=headers)
    assert other.status_code == 200
    forbidden = client.get("/api/student/modules/E2ETEST02/quizzes", headers=student_headers)
    assert forbidden.status_code == 403

    # Roster shows the enrolled student, never their password hash.
    roster = client.get(f"/api/modules/{module['id']}/students", headers=headers)
    assert roster.status_code == 200
    roster_row = next(r for r in roster.json() if r["student_id"] == student_id)
    assert "password_hash" not in roster_row

    # Invigilator can reset the student's password.
    reset = client.post(
        f"/api/modules/{module['id']}/students/reset-password",
        params={"student_id": student_id},
        headers=headers,
    )
    assert reset.status_code == 200
    new_password = reset.json()["temp_password"]
    assert new_password != "StudentPass1!"
    relogin = client.post("/api/student/auth/login", json={
        "student_id": student_id, "password": new_password,
    })
    assert relogin.status_code == 200

    # Invigilator can remove the enrollment.
    remove = client.delete(
        f"/api/modules/{module['id']}/students",
        params={"student_id": student_id},
        headers=headers,
    )
    assert remove.status_code == 200
    roster_after = client.get(f"/api/modules/{module['id']}/students", headers=headers)
    assert all(r["student_id"] != student_id for r in roster_after.json())


def test_invigilator_can_view_a_students_history_within_a_module(client):
    token = _fresh_invigilator_token(client)
    headers = {"Authorization": f"Bearer {token}"}
    module = client.post("/api/modules", json={"code": "HISTMOD01", "name": "History Test"}, headers=headers).json()

    student_id = f"HIST-{secrets.token_hex(3)}"
    join = client.post("/api/student/auth/join", json={
        "enroll_code": module["enroll_code"], "student_id": student_id,
        "full_name": "History Student", "password": "Pass1234!",
    })
    assert join.status_code == 200

    # No sessions attended yet.
    empty = client.get(
        f"/api/modules/{module['id']}/students/history", params={"student_id": student_id}, headers=headers
    )
    assert empty.status_code == 200
    assert empty.json() == []

    # Invigilator publishes and starts a quiz for this module.
    session_resp = client.post("/api/sessions", json={
        "exam_name": "History Quiz", "exam_code": "HISTQ01", "duration_minutes": 20, "max_students": 10,
        "questions": [{"id": "q1", "type": "text", "text": "2+2?", "marks": 10, "options": []}],
        "model_answers": {"q1": "4"},
        "quiz_mode": True, "published": True, "module_code": module["code"],
        "require_manual_approval": False, "require_identity_verification": False,
    }, headers=headers)
    assert session_resp.status_code == 200, session_resp.text
    session = session_resp.json()
    client.post(f"/api/sessions/{session['id']}/start", headers=headers)

    # Student joins and submits an answer.
    join_candidate = client.post("/api/public/candidates/join", json={
        "session_code": session["session_code"], "student_id": student_id, "full_name": "History Student",
        "id_front_b64": "", "id_back_b64": "", "selfie_b64": "", "liveness_passed": True, "face_match_score": 1,
    })
    assert join_candidate.status_code == 200, join_candidate.text
    candidate = join_candidate.json()
    submit = client.post(
        "/api/public/answers",
        json={"candidate_id": candidate["id"], "answers": {"q1": "4"}},
        headers={"X-Candidate-Token": candidate["candidate_token"]},
    )
    assert submit.status_code == 200
    client.post(f"/api/sessions/{session['id']}/grade", headers=headers)

    history = client.get(
        f"/api/modules/{module['id']}/students/history", params={"student_id": student_id}, headers=headers
    )
    assert history.status_code == 200
    rows = history.json()
    assert len(rows) == 1
    assert rows[0]["exam_name"] == "History Quiz"
    assert rows[0]["answers"]["q1"] == "4"
    assert rows[0]["grade"]["total"] == 10.0


def test_student_history_endpoint_requires_owning_the_module(client):
    token = _fresh_invigilator_token(client)
    other_token = _fresh_invigilator_token(client)
    headers = {"Authorization": f"Bearer {token}"}
    other_headers = {"Authorization": f"Bearer {other_token}"}
    module = client.post("/api/modules", json={"code": "HISTMOD03", "name": "Owner Module"}, headers=headers).json()

    forbidden = client.get(
        f"/api/modules/{module['id']}/students/history", params={"student_id": "nobody"}, headers=other_headers
    )
    assert forbidden.status_code == 404


def test_join_with_unknown_enroll_code_is_rejected(client):
    resp = client.post("/api/student/auth/join", json={
        "enroll_code": "not-a-real-code",
        "student_id": "X",
        "full_name": "X",
        "password": "Whatever1!",
    })
    assert resp.status_code == 404


def test_student_token_cannot_call_invigilator_endpoints(client):
    token = _fresh_invigilator_token(client)
    headers = {"Authorization": f"Bearer {token}"}
    module = client.post("/api/modules", json={"code": "E2ETEST03", "name": "M"}, headers=headers).json()
    join = client.post("/api/student/auth/join", json={
        "enroll_code": module["enroll_code"],
        "student_id": f"S-{secrets.token_hex(3)}",
        "full_name": "S One",
        "password": "Pass1234!",
    })
    student_token = join.json()["token"]

    resp = client.post(
        "/api/modules",
        json={"code": "E2ETEST04", "name": "Should fail"},
        headers={"Authorization": f"Bearer {student_token}"},
    )
    assert resp.status_code == 403


def test_invigilator_token_cannot_call_student_endpoints(client):
    token = _fresh_invigilator_token(client)
    resp = client.get("/api/student/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
