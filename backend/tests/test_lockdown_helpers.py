"""Mongo-free tests for AccessGuard lockdown policy and candidate credentials."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import server

from server import (
    StudentJoinIn,
    build_extension_policy,
    candidate_join,
    extension_heartbeat_is_recent,
    extension_policy_state,
    make_candidate_token,
    normalize_allowed_url,
    normalize_allowlist,
    normalize_origin,
    seconds_remaining,
    sign_candidate,
    validate_extension_app_origin,
    verify_candidate_access_token,
    version_at_least,
)


def _candidate(**overrides):
    value = {
        "id": "candidate-1",
        "session_id": "session-1",
        "status": "approved",
        "joined_at": "2026-08-03T08:00:00+00:00",
        "approved_at": "2026-08-03T08:01:00+00:00",
    }
    value.update(overrides)
    return value


def _session(**overrides):
    value = {
        "id": "session-1",
        "session_code": "DEFAULT-SESSION-CODE",
        "exam_name": "Test Exam",
        "exam_code": "TEST001",
        "status": "live",
        "created_at": "2026-08-03T07:00:00+00:00",
        "started_at": "2026-08-03T08:00:00+00:00",
        "ended_at": None,
        "duration_minutes": 60,
        "heartbeat_interval_sec": 10,
        "lockdown_mode": "extension_required",
        "require_fullscreen": True,
        "extension_min_version": "1.2.0",
        "policy_version": 3,
        "whitelisted_urls": ["docs.python.org", "https://EXAMPLE.com:443/reference#part"],
        "quiz_mode": False,
    }
    value.update(overrides)
    return value


def test_url_normalization_accepts_bare_hosts_and_deduplicates():
    assert normalize_allowed_url("Docs.Python.org") == "https://docs.python.org/"
    assert normalize_allowed_url("https://EXAMPLE.com:443/reference#part") == "https://example.com/reference"
    assert normalize_origin("http://Example.com:80/path") == "http://example.com"

    origins, urls = normalize_allowlist([
        "docs.python.org",
        "https://docs.python.org/",
        "https://docs.python.org/library/",
    ])
    assert origins == ["https://docs.python.org"]
    assert urls == ["https://docs.python.org/", "https://docs.python.org/library/"]


@pytest.mark.parametrize(
    "value",
    ["", "file:///tmp/answer.txt", "javascript:alert(1)", "https://user:pw@example.com"],
)
def test_url_normalization_rejects_unsafe_values(value):
    with pytest.raises(ValueError):
        normalize_allowed_url(value)


def test_candidate_jwt_is_bound_to_candidate_and_session_and_legacy_remains_valid():
    token = make_candidate_token("candidate-1", "session-1")
    assert verify_candidate_access_token(token, "candidate-1", "session-1")
    assert not verify_candidate_access_token(token, "candidate-2", "session-1")
    assert not verify_candidate_access_token(token, "candidate-1", "session-2")
    assert not verify_candidate_access_token(token + "tampered", "candidate-1", "session-1")

    legacy = sign_candidate("candidate-1")
    assert verify_candidate_access_token(legacy, "candidate-1", "session-1")
    assert not verify_candidate_access_token(legacy, "candidate-2", "session-1")
    assert not verify_candidate_access_token(legacy, "candidate-1", "session-1", allow_legacy=False)


@pytest.mark.parametrize(
    ("candidate_status", "session_status", "expected"),
    [
        ("pending", "scheduled", "armed"),
        ("pending", "live", "armed"),
        ("approved", "live", "enforced"),
        ("locked", "live", "locked"),
        ("finished", "live", "finished"),
        ("kicked", "live", "kicked"),
        ("rejected", "live", "rejected"),
        ("exited", "live", "released"),
        ("approved", "ended", "ended"),
    ],
)
def test_extension_policy_state_machine(candidate_status, session_status, expected):
    assert extension_policy_state(candidate_status, session_status) == expected


def test_policy_shape_is_canonical_and_enforced(monkeypatch):
    monkeypatch.setenv("APP_ORIGINS", "https://exam.example.edu, https://exam.example.edu/")
    monkeypatch.delenv("EXAM_APP_URL", raising=False)
    policy = build_extension_policy(
        _candidate(),
        _session(),
        api_origin="https://api.example.edu/api/",
        generated_at="2026-08-03T08:05:00+00:00",
    )

    assert policy["candidate_id"] == "candidate-1"
    assert policy["session_id"] == "session-1"
    assert policy["state"] == "enforced"
    assert policy["enforcement"] is True
    assert policy["policy_version"] == 3
    assert policy["app_origins"] == ["https://exam.example.edu"]
    assert "https://docs.python.org" in policy["allowed_origins"]
    assert "https://api.example.edu" in policy["allowed_origins"]
    assert policy["exam_url"] == "https://exam.example.edu/student/exam"
    assert policy["timestamps"]["generated_at"] == "2026-08-03T08:05:00+00:00"


def test_hosted_extension_origin_must_exactly_match_configuration():
    configured = ["https://exam.example.edu"]
    assert validate_extension_app_origin(
        "https://exam.example.edu/",
        configured_origins=configured,
        environment="production",
    ) == "https://exam.example.edu"

    for origin in (
        "https://exam.example.edu:8443",
        "https://student.exam.example.edu",
        "http://exam.example.edu",
    ):
        with pytest.raises(ValueError, match="not configured"):
            validate_extension_app_origin(
                origin,
                configured_origins=configured,
                environment="production",
            )

    with pytest.raises(ValueError, match=r"exact HTTP\(S\) origin"):
        validate_extension_app_origin(
            "https://exam.example.edu/student/exam",
            configured_origins=configured,
            environment="production",
        )


def test_development_origin_allows_only_same_scheme_loopback_aliases_and_ports():
    configured = ["http://localhost:3000"]
    assert validate_extension_app_origin(
        "http://127.0.0.1:5173",
        configured_origins=configured,
        environment="development",
    ) == "http://127.0.0.1:5173"
    assert validate_extension_app_origin(
        "http://[::1]:8080",
        configured_origins=configured,
        environment="development",
    ) == "http://[::1]:8080"

    for origin in (
        "https://127.0.0.1:5173",
        "http://192.168.1.25:3000",
        "http://evil.localhost:3000",
    ):
        with pytest.raises(ValueError, match="not configured"):
            validate_extension_app_origin(
                origin,
                configured_origins=configured,
                environment="development",
            )


def test_validated_origin_becomes_policy_exam_origin(monkeypatch):
    monkeypatch.setenv("APP_ORIGINS", "http://localhost:3000")
    monkeypatch.setenv("EXAM_APP_URL", "http://localhost:3000/")
    policy = build_extension_policy(
        _candidate(),
        _session(),
        validated_app_origin="http://127.0.0.1:5173",
        generated_at="2026-08-03T08:05:00+00:00",
    )

    assert policy["app_origins"] == [
        "http://127.0.0.1:5173",
        "http://localhost:3000",
    ]
    assert policy["exam_url"] == "http://127.0.0.1:5173/student/exam"
    assert "http://127.0.0.1:5173" in policy["allowed_origins"]


def test_monitor_only_policy_never_requests_browser_enforcement(monkeypatch):
    monkeypatch.setenv("APP_ORIGINS", "https://exam.example.edu")
    policy = build_extension_policy(
        _candidate(status="approved"),
        _session(lockdown_mode="monitor_only"),
        generated_at="2026-08-03T08:05:00+00:00",
    )
    assert policy["state"] == "enforced"
    assert policy["lockdown_mode"] == "monitor_only"
    assert policy["extension_required"] is False
    assert policy["enforcement"] is False


def test_extension_heartbeat_freshness_and_minimum_version():
    current = datetime(2026, 8, 3, 8, 5, tzinfo=timezone.utc)
    candidate = _candidate(
        last_extension_heartbeat_at=(current - timedelta(seconds=20)).isoformat(),
        extension_version="1.2.1",
        extension_enforcement_active=True,
        extension_policy_version=3,
    )
    assert extension_heartbeat_is_recent(candidate, _session(), now=current)

    candidate["extension_version"] = "1.1.9"
    assert not extension_heartbeat_is_recent(candidate, _session(), now=current)

    candidate["extension_version"] = "1.2.1"
    candidate["last_extension_heartbeat_at"] = (current - timedelta(minutes=5)).isoformat()
    assert not extension_heartbeat_is_recent(candidate, _session(), now=current)
    assert version_at_least("2.0", "1.9.9")


def test_extension_heartbeat_must_report_active_current_policy():
    current = datetime(2026, 8, 3, 8, 5, tzinfo=timezone.utc)
    candidate = _candidate(
        last_extension_heartbeat_at=current.isoformat(),
        extension_version="1.2.1",
        extension_enforcement_active=False,
        extension_policy_version=3,
    )
    assert not extension_heartbeat_is_recent(candidate, _session(), now=current)

    candidate["extension_enforcement_active"] = True
    candidate["extension_policy_version"] = 2
    assert not extension_heartbeat_is_recent(candidate, _session(), now=current)

    candidate["extension_policy_version"] = 3
    assert extension_heartbeat_is_recent(candidate, _session(), now=current)


def test_seconds_remaining_uses_server_start_time():
    now = datetime(2026, 8, 3, 8, 30, tzinfo=timezone.utc)
    assert seconds_remaining(_session(), now=now) == 30 * 60
    assert seconds_remaining(_session(), now=now + timedelta(hours=2)) == 0


def test_by_code_exposes_identity_verification_flag(monkeypatch):
    session = _session(session_code="QUIK-ABCD-EFGH", require_identity_verification=False)

    class FakeSessions:
        async def find_one(self, query, projection=None):
            return session

    class FakeDatabase:
        sessions = FakeSessions()

    monkeypatch.setattr(server, "db", FakeDatabase())

    result = asyncio.run(server.session_by_code(session["session_code"]))
    assert result["require_identity_verification"] is False

    del session["require_identity_verification"]
    default_result = asyncio.run(server.session_by_code(session["session_code"]))
    assert default_result["require_identity_verification"] is True


def test_kicked_candidate_does_not_block_capacity_or_clean_rejoin(monkeypatch):
    session = _session(
        session_code="ABCD-EFGH-IJKL",
        max_students=1,
        status="scheduled",
    )

    class FakeSessions:
        async def find_one(self, query, projection=None):
            return session

    class FakeCandidates:
        def __init__(self):
            self.count_query = None
            self.existing_query = None
            self.inserted = None

        async def count_documents(self, query):
            self.count_query = query
            excluded = set(query["status"]["$nin"])
            return 0 if "kicked" in excluded else 1

        async def find_one(self, query, projection=None):
            self.existing_query = query
            excluded = set(query["status"]["$nin"])
            return None if "kicked" in excluded else {"id": "kicked-candidate"}

        async def insert_one(self, document):
            self.inserted = document.copy()

    fake_candidates = FakeCandidates()

    class FakeDatabase:
        sessions = FakeSessions()
        candidates = fake_candidates

    async def ignore_broadcast(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", FakeDatabase())
    monkeypatch.setattr(server, "ws_broadcast", ignore_broadcast)
    monkeypatch.setattr(server, "make_candidate_token", lambda candidate_id, session_id: "test-candidate-token")

    result = asyncio.run(candidate_join(StudentJoinIn(
        session_code=session["session_code"],
        student_id="STUDENT-1",
        full_name="Rejoining Student",
        id_front_b64="",
        id_back_b64="",
        selfie_b64="",
    )))

    assert result["status"] == "pending"
    assert fake_candidates.inserted["student_id"] == "STUDENT-1"
    assert "kicked" in fake_candidates.count_query["status"]["$nin"]
    assert "kicked" in fake_candidates.existing_query["status"]["$nin"]


def test_repeated_violation_of_same_kind_is_recorded_once(monkeypatch):
    candidate = {"id": "cand-1", "session_id": "sess-1", "status": "approved"}
    session = _session(status="live")
    stored = []

    class FakeViolations:
        async def find_one(self, query, projection=None):
            for row in stored:
                if (
                    row["candidate_id"] == query["candidate_id"]
                    and row["kind"] == query["kind"]
                    and row["ts"] >= query["ts"]["$gte"]
                ):
                    return row
            return None

        async def insert_one(self, document):
            stored.append(document.copy())

    class FakeCandidates:
        async def update_one(self, query, update):
            return None

    class FakeDatabase:
        violations = FakeViolations()
        candidates = FakeCandidates()

    async def fake_authenticated_candidate(request, candidate_id, **kwargs):
        return candidate

    async def fake_candidate_session(_candidate):
        return session

    async def ignore_broadcast(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", FakeDatabase())
    monkeypatch.setattr(server, "authenticated_candidate", fake_authenticated_candidate)
    monkeypatch.setattr(server, "candidate_session", fake_candidate_session)
    monkeypatch.setattr(server, "ws_broadcast", ignore_broadcast)

    def report(kind):
        return asyncio.run(server.violation(
            server.ViolationIn(candidate_id="cand-1", kind=kind, detail=""),
            None,
        ))

    first = report("focus_lost")
    second = report("focus_lost")
    other_kind = report("fullscreen_exit")

    assert "duplicate" not in first
    assert second["duplicate"] is True
    assert "duplicate" not in other_kind
    assert [row["kind"] for row in stored] == ["focus_lost", "fullscreen_exit"]

    # Locking kinds are never de-duplicated away.
    assert report("prohibited_url")["locked"] is True
    assert report("prohibited_url")["locked"] is True


def test_lockdown_bypass_locks_candidate_like_prohibited_url(monkeypatch):
    """The exam page reports lockdown_bypass (no extension involved) after
    repeated confirmed exits from browser-only lockdown; it must lock the
    candidate exactly like the extension's prohibited_url report does."""
    candidate = {"id": "cand-2", "session_id": "sess-1", "status": "approved"}
    session = _session(status="live")
    stored = []
    lock_updates = []

    class FakeViolations:
        async def find_one(self, query, projection=None):
            return None

        async def insert_one(self, document):
            stored.append(document.copy())

    class FakeCandidates:
        async def update_one(self, query, update):
            lock_updates.append((query, update))
            return None

    class FakeDatabase:
        violations = FakeViolations()
        candidates = FakeCandidates()

    async def fake_authenticated_candidate(request, candidate_id, **kwargs):
        return candidate

    async def fake_candidate_session(_candidate):
        return session

    async def ignore_broadcast(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", FakeDatabase())
    monkeypatch.setattr(server, "authenticated_candidate", fake_authenticated_candidate)
    monkeypatch.setattr(server, "candidate_session", fake_candidate_session)
    monkeypatch.setattr(server, "ws_broadcast", ignore_broadcast)

    result = asyncio.run(server.violation(
        server.ViolationIn(
            candidate_id="cand-2",
            kind="lockdown_bypass",
            detail="Left the required browser lockdown 3 times without the extension.",
        ),
        None,
    ))

    assert result["locked"] is True
    assert lock_updates[0][1]["$set"]["status"] == "locked"
    assert stored[0]["kind"] == "lockdown_bypass"
