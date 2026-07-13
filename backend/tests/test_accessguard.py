"""AccessGuard backend API tests."""
import os
import time
import uuid
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

# Load frontend .env to get the public URL
load_dotenv(Path("/app/frontend/.env"))
BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_ID = "EG/STAFF/0001"
ADMIN_PW = "AccessGuard2026!"


@pytest.fixture(scope="session")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="session")
def token(s):
    r = s.post(f"{API}/auth/login", json={"inv_id": ADMIN_ID, "password": ADMIN_PW, "two_factor": "123456"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---- Auth tests ----
def test_login_success(s):
    r = s.post(f"{API}/auth/login", json={"inv_id": ADMIN_ID, "password": ADMIN_PW, "two_factor": "123456"})
    assert r.status_code == 200
    d = r.json()
    assert d["inv_id"] == ADMIN_ID
    assert isinstance(d["token"], str) and len(d["token"]) > 20


def test_login_bad_password(s):
    r = s.post(f"{API}/auth/login", json={"inv_id": ADMIN_ID, "password": "wrong", "two_factor": "123456"})
    assert r.status_code == 401


def test_login_bad_2fa(s):
    r = s.post(f"{API}/auth/login", json={"inv_id": ADMIN_ID, "password": ADMIN_PW, "two_factor": "12"})
    assert r.status_code == 401
    r2 = s.post(f"{API}/auth/login", json={"inv_id": ADMIN_ID, "password": ADMIN_PW, "two_factor": "abcdef"})
    assert r2.status_code == 401


def test_auth_me(s, auth):
    r = s.get(f"{API}/auth/me", headers=auth)
    assert r.status_code == 200
    assert r.json()["inv_id"] == ADMIN_ID


# ---- Sessions ----
@pytest.fixture(scope="session")
def session_payload():
    # Iteration 3: per-question marks must be honored (q1=15, q2=5)
    return {
        "exam_name": "TEST_Math101",
        "exam_code": f"TEST{uuid.uuid4().hex[:6].upper()}",
        "duration_minutes": 60,
        "max_students": 10,
        "whitelisted_urls": ["https://docs.python.org"],
        "whitelisted_apps": ["chrome"],
        "questions": [
            {"id": "q1", "text": "What is 2+2?", "marks": 15},
            {"id": "q2", "text": "Define recursion.", "marks": 5},
        ],
        "model_answers": {"q1": "4", "q2": "A function that calls itself"},
    }


@pytest.fixture(scope="session")
def session_obj(s, auth, session_payload):
    r = s.post(f"{API}/sessions", json=session_payload, headers=auth)
    assert r.status_code == 200, r.text
    obj = r.json()
    assert obj["session_code"] and len(obj["session_code"].split("-")) == 3
    parts = obj["session_code"].split("-")
    assert all(len(p) == 4 for p in parts)
    return obj


def test_create_session(session_obj):
    assert session_obj["status"] == "scheduled"
    assert session_obj["exam_name"] == "TEST_Math101"


def test_list_sessions(s, auth, session_obj):
    r = s.get(f"{API}/sessions", headers=auth)
    assert r.status_code == 200
    ids = [x["id"] for x in r.json()]
    assert session_obj["id"] in ids


def test_get_session(s, auth, session_obj):
    r = s.get(f"{API}/sessions/{session_obj['id']}", headers=auth)
    assert r.status_code == 200
    assert r.json()["id"] == session_obj["id"]


def test_start_session(s, auth, session_obj):
    r = s.post(f"{API}/sessions/{session_obj['id']}/start", headers=auth)
    assert r.status_code == 200
    g = s.get(f"{API}/sessions/{session_obj['id']}", headers=auth)
    assert g.json()["status"] == "live"


# ---- Public session lookup ----
def test_public_session_by_code(s, session_obj):
    r = s.get(f"{API}/public/sessions/by-code/{session_obj['session_code']}")
    assert r.status_code == 200
    d = r.json()
    assert d["id"] == session_obj["id"]
    assert "model_answers" not in d


def test_public_quizzes_by_module(s, auth):
    payload = {
        "exam_name": "Module Quiz",
        "exam_code": f"MOD{uuid.uuid4().hex[:4].upper()}",
        "duration_minutes": 30,
        "max_students": 20,
        "questions": [{"id": "q1", "text": "What is 2+2?", "marks": 10, "type": "text"}],
        "model_answers": {"q1": "4"},
        "quiz_mode": True,
        "module_code": "EE5206",
        "quiz_prompt_title": "Module quiz ready",
        "quiz_prompt_body": "Join this quick assessment from your course page.",
        "published": True,
    }
    r = s.post(f"{API}/sessions", json=payload, headers=auth)
    assert r.status_code == 200, r.text
    r2 = s.get(f"{API}/public/quizzes/module/EE5206")
    assert r2.status_code == 200, r2.text
    data = r2.json()
    assert len(data) >= 1
    assert any(item["exam_name"] == "Module Quiz" for item in data)


def test_public_session_invalid_code(s):
    r = s.get(f"{API}/public/sessions/by-code/XXXX-XXXX-XXXX")
    assert r.status_code == 404


# ---- Candidates ----
@pytest.fixture(scope="session")
def candidate(s, session_obj):
    r = s.post(f"{API}/public/candidates/join", json={
        "session_code": session_obj["session_code"],
        "student_id": "STU001",
        "full_name": "TEST Student One",
        "id_front_b64": "ZmFrZQ==",
        "id_back_b64": "ZmFrZQ==",
        "selfie_b64": "ZmFrZQ==",
        "liveness_passed": True,
        "face_match_score": 0.95,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "pending"
    return d


def test_candidate_join(candidate):
    assert candidate["id"]


def test_candidate_status_public(s, candidate):
    r = s.get(f"{API}/public/candidates/{candidate['id']}")
    assert r.status_code == 200
    assert r.json()["id"] == candidate["id"]


def test_list_candidates(s, auth, session_obj, candidate):
    r = s.get(f"{API}/sessions/{session_obj['id']}/candidates", headers=auth)
    assert r.status_code == 200
    assert any(c["id"] == candidate["id"] for c in r.json())


def test_candidate_decision_approve(s, auth, session_obj, candidate):
    r = s.post(f"{API}/sessions/{session_obj['id']}/candidates/decision",
               json={"candidate_id": candidate["id"], "approve": True}, headers=auth)
    assert r.status_code == 200
    assert r.json()["status"] == "approved"


# ---- Heartbeats ----
def test_heartbeat(s, candidate):
    r = s.post(f"{API}/public/heartbeats", json={
        "candidate_id": candidate["id"], "latency_ms": 50, "bandwidth": "good",
        "face_visible": True, "tab_active": True,
    })
    assert r.status_code == 200


def test_get_heartbeats(s, auth, session_obj):
    r = s.get(f"{API}/sessions/{session_obj['id']}/heartbeats", headers=auth)
    assert r.status_code == 200
    assert len(r.json()) >= 1


# ---- Violations: use a SECOND candidate so locking doesn't disrupt main flow ----
@pytest.fixture(scope="session")
def candidate2(s, session_obj):
    r = s.post(f"{API}/public/candidates/join", json={
        "session_code": session_obj["session_code"],
        "student_id": "STU002",
        "full_name": "TEST Student Two",
        "id_front_b64": "ZmFrZQ==", "id_back_b64": "ZmFrZQ==", "selfie_b64": "ZmFrZQ==",
    })
    assert r.status_code == 200
    return r.json()


def test_violation_locks_candidate(s, candidate2):
    r = s.post(f"{API}/public/violations", json={
        "candidate_id": candidate2["id"], "kind": "prohibited_url", "detail": "facebook.com",
    })
    assert r.status_code == 200
    assert r.json()["locked"] is True
    g = s.get(f"{API}/public/candidates/{candidate2['id']}")
    assert g.json()["status"] == "locked"


def test_list_violations(s, auth, session_obj):
    r = s.get(f"{API}/sessions/{session_obj['id']}/violations", headers=auth)
    assert r.status_code == 200
    assert len(r.json()) >= 1


# ---- Answers + Receipt ----
def test_submit_answers(s, candidate):
    r = s.post(f"{API}/public/answers", json={
        "candidate_id": candidate["id"],
        "answers": {"q1": "4", "q2": "A function that calls itself recursively"},
    })
    assert r.status_code == 200
    assert r.json()["receipt_id"]


def test_receipt(s, candidate):
    r = s.get(f"{API}/public/receipt/{candidate['id']}")
    assert r.status_code == 200
    d = r.json()
    assert d["answer_count"] == 2
    assert d["submitted_at"]


# ---- Report ----
def test_session_report(s, auth, session_obj):
    r = s.get(f"{API}/sessions/{session_obj['id']}/report", headers=auth)
    assert r.status_code == 200
    d = r.json()
    assert d["totals"]["candidates"] >= 2
    assert d["totals"]["finished"] >= 1
    assert d["totals"]["violations"] >= 1


# ---- AI Grading (Iteration 3: per-question marks honored) ----
def test_ai_grade(s, auth, session_obj):
    r = s.post(f"{API}/sessions/{session_obj['id']}/grade", headers=auth, timeout=180)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["graded"] >= 1
    g = d["results"][0]
    assert "per_question" in g and "q1" in g["per_question"] and "q2" in g["per_question"]
    # Per-question max must reflect questions[].marks (15 / 5), not hardcoded 10
    assert g["per_question"]["q1"]["max"] == 15
    assert g["per_question"]["q2"]["max"] == 5
    # Each individual score must not exceed its max
    assert 0 <= g["per_question"]["q1"]["score"] <= 15
    assert 0 <= g["per_question"]["q2"]["score"] <= 5
    # Totals
    assert g["max_total"] == 20
    assert 0 <= g["total"] <= 20
    assert "feedback" in g["per_question"]["q1"]


# ---- End session (last) ----
def test_zzz_end_session(s, auth, session_obj):
    r = s.post(f"{API}/sessions/{session_obj['id']}/end", headers=auth)
    assert r.status_code == 200
    g = s.get(f"{API}/sessions/{session_obj['id']}", headers=auth)
    assert g.json()["status"] == "ended"


# ---- Iteration 3: Object Storage URL response shape ----
# Tiny valid 1x1 JPEG (base64) for upload tests
TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIs"
    "IxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAA"
    "AAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk"
    "M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKT"
    "lJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oA"
    "DAMBAAIRAxEAPwD3+iiigD//2Q=="
)


@pytest.fixture(scope="session")
def candidate_with_real_image(s, session_obj):
    """Candidate joined with a real (tiny) JPEG so storage upload can succeed."""
    r = s.post(f"{API}/public/candidates/join", json={
        "session_code": session_obj["session_code"],
        "student_id": "STU_IMG",
        "full_name": "TEST Image Candidate",
        "id_front_b64": TINY_JPEG_B64,
        "id_back_b64": TINY_JPEG_B64,
        "selfie_b64": TINY_JPEG_B64,
        "liveness_passed": True,
        "face_match_score": 0.88,
    })
    assert r.status_code == 200, r.text
    return r.json()


def test_candidate_join_returns_url_fields_not_b64(candidate_with_real_image):
    """Iter3: response must contain *_url fields, not the legacy *_b64 fields."""
    d = candidate_with_real_image
    for f in ("id_front_url", "id_back_url", "selfie_url"):
        assert f in d, f"Missing {f} in join response"
        assert d[f], f"{f} should not be empty"
        # Either object-storage path or fallback inline data URL
        assert d[f].startswith("/api/public/files/") or d[f].startswith("data:image/"), \
            f"Unexpected {f} value: {d[f][:60]}..."
    for legacy in ("id_front_b64", "id_back_b64", "selfie_b64"):
        assert legacy not in d, f"Legacy field {legacy} should NOT be in response"


def test_serve_uploaded_file(s, candidate_with_real_image):
    """Iter3: GET /api/public/files/{path} returns 200 + image content."""
    selfie = candidate_with_real_image["selfie_url"]
    if not selfie.startswith("/api/public/files/"):
        pytest.skip("Storage unavailable in this env (fallback inline data URL); cannot test file serving")
    url = f"{BASE_URL}{selfie}"
    r = requests.get(url, timeout=30)
    assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
    assert r.headers.get("content-type", "").startswith("image/"), r.headers.get("content-type")
    assert len(r.content) > 0


def test_public_candidate_status_excludes_image_urls(s, candidate_with_real_image):
    """Iter3: /api/public/candidates/{cid} must not leak image URLs."""
    r = s.get(f"{API}/public/candidates/{candidate_with_real_image['id']}")
    assert r.status_code == 200
    d = r.json()
    for f in ("id_front_url", "id_back_url", "selfie_url",
              "id_front_b64", "id_back_b64", "selfie_b64"):
        assert f not in d, f"Field {f} should be excluded from public candidate response"
    assert d["id"] == candidate_with_real_image["id"]


def test_list_candidates_includes_selfie_excludes_id(s, auth, session_obj, candidate_with_real_image):
    """Iter3: invigilator candidate listing INCLUDES selfie_url (for tile) but excludes id_front/back."""
    r = s.get(f"{API}/sessions/{session_obj['id']}/candidates", headers=auth)
    assert r.status_code == 200
    rows = r.json()
    target = next((c for c in rows if c["id"] == candidate_with_real_image["id"]), None)
    assert target is not None, "candidate not in list"
    assert "selfie_url" in target and target["selfie_url"], "selfie_url must be present for tile rendering"
    assert "id_front_url" not in target
    assert "id_back_url" not in target
    assert "id_front_b64" not in target
    assert "id_back_b64" not in target


# ---- Iteration 3: Live frames (WebRTC-style 3s frame upload) ----
def test_upload_frame_and_fetch(s, auth, session_obj, candidate_with_real_image):
    """Iter3: POST /api/public/frames upserts; GET /api/sessions/{sid}/frames returns map."""
    cid = candidate_with_real_image["id"]
    # Upload a frame as data URL
    data_url = f"data:image/jpeg;base64,{TINY_JPEG_B64}"
    r = s.post(f"{API}/public/frames", json={"candidate_id": cid, "image_b64": data_url})
    assert r.status_code == 200, r.text
    assert r.json().get("ok") is True

    # Upload again (should upsert/replace, not duplicate) with raw base64
    r2 = s.post(f"{API}/public/frames", json={"candidate_id": cid, "image_b64": TINY_JPEG_B64})
    assert r2.status_code == 200

    # Auth-protected fetch
    r3 = s.get(f"{API}/sessions/{session_obj['id']}/frames", headers=auth)
    assert r3.status_code == 200, r3.text
    frames = r3.json()
    assert isinstance(frames, dict)
    assert cid in frames, f"Candidate {cid} not in frames map: {list(frames.keys())}"
    entry = frames[cid]
    assert "image_b64" in entry and "ts" in entry
    assert entry["image_b64"].startswith("data:image/jpeg;base64,")


def test_frames_endpoint_requires_auth(s, session_obj):
    """Iter3: /api/sessions/{sid}/frames must require invigilator auth."""
    r = s.get(f"{API}/sessions/{session_obj['id']}/frames")
    assert r.status_code in (401, 403)
