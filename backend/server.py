"""AccessGuard - Secure Exam Monitoring System Backend."""
import os
import sys
import uuid
import hashlib
import hmac
import logging
import secrets
import base64
import asyncio
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional, Dict, Any, Set, Literal
from urllib.parse import urlsplit, urlunsplit

import httpx
import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import (
    FastAPI, APIRouter, HTTPException, Depends, Response,
    Request, WebSocket, WebSocketDisconnect, Query,
)
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from emergentintegrations.llm.chat import LlmChat
from rag_grader import RAGGrader

load_dotenv(ROOT_DIR / ".env")

# ---- Config ----
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "accessguard")
JWT_SECRET = os.environ.get("JWT_SECRET", "accessguard-secret")
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
ADMIN_INV_ID = os.environ.get("ADMIN_INV_ID", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "password")
REMOTE_LOGIN_SECRET = os.environ.get("REMOTE_LOGIN_SECRET", "remote-access-2026")
LOGIN_AUDIT_COLLECTION = "invigilator_login_audit"
ENVIRONMENT = os.environ.get("ENVIRONMENT", os.environ.get("APP_ENV", "development")).strip().lower()
IS_PRODUCTION = ENVIRONMENT in {"production", "prod"}
LOCAL_DEVELOPMENT_ENVIRONMENTS = {"development", "dev", "local", "test"}
LOOPBACK_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}
CANDIDATE_TOKEN_TTL_HOURS = int(os.environ.get("CANDIDATE_TOKEN_TTL_HOURS", "12"))
EXTENSION_HEARTBEAT_GRACE_SEC = int(os.environ.get("EXTENSION_HEARTBEAT_GRACE_SEC", "45"))
# Repeated reports of the same event kind inside this window are one incident.
VIOLATION_DEDUPE_SEC = int(os.environ.get("VIOLATION_DEDUPE_SEC", "5"))
# lockdown_bypass is reported by the exam page itself (not the extension) after
# repeated confirmed exits from the required browser-only lockdown state
# (fullscreen/focus). It locks the candidate the same way the extension's
# prohibited_url report does, giving "monitor_only" sessions real enforcement
# teeth without requiring the extension.
LOCKING_VIOLATION_KINDS = {"prohibited_url", "unauthorized_person", "lockdown_bypass"}
ALLOW_LEGACY_CANDIDATE_TOKENS = os.environ.get(
    "ALLOW_LEGACY_CANDIDATE_TOKENS",
    "0" if IS_PRODUCTION else "1",
) == "1"

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# ---- Object Storage (async via httpx) ----
STORAGE_URL = "https://integrations.emergentagent.com/objstore/api/v1/storage"
APP_NAME = "accessguard"
storage_key: Optional[str] = None
http_client: Optional[httpx.AsyncClient] = None


async def init_storage_async() -> Optional[str]:
    global storage_key
    if storage_key:
        return storage_key
    if not http_client or not EMERGENT_LLM_KEY:
        return None
    try:
        r = await http_client.post(
            f"{STORAGE_URL}/init",
            json={"emergent_key": EMERGENT_LLM_KEY},
            timeout=20,
        )
        r.raise_for_status()
        storage_key = r.json()["storage_key"]
        return storage_key
    except Exception as e:
        logging.getLogger("accessguard").warning(f"Storage init failed: {e}")
        return None


async def put_b64_image(path: str, b64: str) -> Optional[str]:
    if not b64 or not http_client or not EMERGENT_LLM_KEY:
        return None
    try:
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        data = base64.b64decode(b64)
        key = await init_storage_async()
        if not key:
            return None
        r = await http_client.put(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key, "Content-Type": "image/jpeg"},
            content=data,
            timeout=30,
        )
        r.raise_for_status()
        return r.json().get("path", path)
    except Exception as e:
        logging.getLogger("accessguard").warning(f"Upload failed for {path}: {e}")
        return None


async def get_object_bytes(path: str) -> tuple[bytes, str]:
    key = await init_storage_async()
    if not key or not http_client:
        raise HTTPException(503, "Storage unavailable")
    r = await http_client.get(
        f"{STORAGE_URL}/objects/{path}",
        headers={"X-Storage-Key": key},
        timeout=30,
    )
    if r.status_code == 404:
        raise HTTPException(404, "File not found")
    r.raise_for_status()
    return r.content, r.headers.get("Content-Type", "image/jpeg")


# ---- HMAC candidate token (hardens public endpoints against spoofing) ----
def sign_candidate(cid: str) -> str:
    return hmac.new(JWT_SECRET.encode(), cid.encode(), hashlib.sha256).hexdigest()


def verify_candidate_token(cid: str, token: Optional[str]) -> bool:
    if not token:
        return False
    return hmac.compare_digest(sign_candidate(cid), token)


def make_candidate_token(cid: str, sid: str) -> str:
    """Issue a bounded candidate credential for page and extension API calls."""
    issued_at = datetime.now(timezone.utc)
    payload = {
        "sub": cid,
        "cid": cid,
        "sid": sid,
        "role": "candidate",
        "iat": issued_at,
        "exp": issued_at + timedelta(hours=max(1, CANDIDATE_TOKEN_TTL_HOURS)),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_candidate_access_token(
    token: Optional[str],
    candidate_id: str,
    session_id: str,
    *,
    allow_legacy: bool = True,
) -> bool:
    """Verify a signed candidate JWT, with legacy HMAC support during migration."""
    if not token:
        return False
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        token_cid = payload.get("cid") or payload.get("sub")
        return (
            payload.get("role") == "candidate"
            and hmac.compare_digest(str(token_cid or ""), candidate_id)
            and hmac.compare_digest(str(payload.get("sid") or ""), session_id)
        )
    except jwt.PyJWTError:
        return allow_legacy and verify_candidate_token(candidate_id, token)


def extract_candidate_token(request: Request, body_token: Optional[str] = None) -> Optional[str]:
    """Read candidate credentials from the extension header, bearer auth, or legacy body."""
    header_token = request.headers.get("X-Candidate-Token")
    if header_token:
        return header_token.strip()
    authorization = request.headers.get("Authorization", "")
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() == "bearer" and value.strip():
        return value.strip()
    return body_token


def normalize_allowed_url(value: str) -> str:
    """Canonicalize a configured HTTP(S) URL; bare hostnames default to HTTPS."""
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("URL is required")
    if "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError("Only http and https URLs are allowed")
    if not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("URL must contain a valid hostname and no credentials")
    try:
        host = parsed.hostname.encode("idna").decode("ascii").lower()
        port = parsed.port
    except (UnicodeError, ValueError) as exc:
        raise ValueError("URL contains an invalid hostname or port") from exc
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    default_port = (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
    netloc = host if port is None or default_port else f"{host}:{port}"
    path = parsed.path or "/"
    return urlunsplit((scheme, netloc, path, parsed.query, ""))


def normalize_origin(value: str) -> str:
    normalized = normalize_allowed_url(value)
    parsed = urlsplit(normalized)
    return f"{parsed.scheme}://{parsed.netloc}"


def normalize_allowlist(values: List[str]) -> tuple[List[str], List[str]]:
    """Return deterministic, de-duplicated (origins, URLs)."""
    origins: List[str] = []
    urls: List[str] = []
    for value in values or []:
        normalized = normalize_allowed_url(value)
        origin = normalize_origin(normalized)
        if normalized not in urls:
            urls.append(normalized)
        if origin not in origins:
            origins.append(origin)
    return origins, urls


ENFORCING_EXTENSION_STATES = {"armed", "enforced", "locked"}
TERMINAL_CANDIDATE_STATES = {"finished", "kicked", "rejected", "exited"}
REJOINABLE_CANDIDATE_STATES = ("rejected", "exited", "kicked")


def extension_policy_state(candidate_status: str, session_status: str) -> str:
    """Map internal lifecycle fields to the stable extension state machine."""
    if session_status == "ended":
        return "ended"
    status_value = (candidate_status or "").lower()
    if status_value in {"finished", "kicked", "rejected"}:
        return status_value
    if status_value == "exited":
        return "released"
    if status_value == "locked":
        return "locked"
    if status_value in {"approved", "active"} and session_status == "live":
        return "enforced"
    if status_value in {"pending", "approved", "active"}:
        return "armed"
    return "released"


def parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def version_at_least(actual: Optional[str], minimum: Optional[str]) -> bool:
    """Small numeric semver comparison suitable for extension version gates."""
    if not minimum:
        return True
    if not actual:
        return False
    try:
        actual_parts = tuple(int(x) for x in re.findall(r"\d+", actual)[:3])
        minimum_parts = tuple(int(x) for x in re.findall(r"\d+", minimum)[:3])
        size = max(len(actual_parts), len(minimum_parts), 3)
        return actual_parts + (0,) * (size - len(actual_parts)) >= minimum_parts + (0,) * (size - len(minimum_parts))
    except (TypeError, ValueError):
        return False

app = FastAPI(title="AccessGuard API")  # lifespan attached after seed_admin defined
api = APIRouter(prefix="/api")
bearer = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("accessguard")

# ---- CORS ----
# Allow origins configured via the CORS_ORIGINS env var (comma-separated),
# or '*' to allow all origins. Defaults to '*' for development convenience.
cors_env = os.environ.get("CORS_ORIGINS", "*")
if cors_env.strip() == "*":
    _allow_origins = ["*"]
else:
    _allow_origins = [o.strip() for o in cors_env.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- WebSocket subscriber registry ----
ws_subscribers: Dict[str, Set[WebSocket]] = {}


async def ws_broadcast(sid: str, event: Dict[str, Any]) -> None:
    subs = list(ws_subscribers.get(sid, set()))
    for ws in subs:
        try:
            await ws.send_json(event)
        except Exception:
            ws_subscribers.get(sid, set()).discard(ws)


# ---- Helpers ----
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


def make_token(sub: str, role: str) -> str:
    payload = {
        "sub": sub,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=12),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def make_session_code(exam_code: str) -> str:
    raw = f"{exam_code}-{secrets.token_hex(4)}-{datetime.now(timezone.utc).timestamp()}"
    h = hashlib.sha256(raw.encode()).hexdigest().upper()
    # Format: XXXX-XXXX-XXXX
    return f"{h[0:4]}-{h[4:8]}-{h[8:12]}"


def configured_app_origins() -> List[str]:
    raw = os.environ.get("APP_ORIGINS") or os.environ.get("FRONTEND_URL")
    if not raw:
        cors_value = os.environ.get("CORS_ORIGINS", "")
        raw = cors_value if cors_value.strip() not in {"", "*"} else "http://localhost:3000"
    origins: List[str] = []
    for item in raw.split(","):
        try:
            origin = normalize_origin(item)
        except ValueError:
            continue
        if origin not in origins:
            origins.append(origin)
    return origins or ["http://localhost:3000"]


def validate_extension_app_origin(
    value: Optional[str],
    *,
    configured_origins: Optional[List[str]] = None,
    environment: Optional[str] = None,
) -> Optional[str]:
    """Validate the exact app origin reported by the browser extension.

    Hosted environments accept only an explicitly configured origin. Local
    development additionally treats localhost, IPv4 loopback, and IPv6 loopback
    as aliases and permits their ports to differ, while keeping the scheme exact.
    """
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        raise ValueError("App origin header is empty")

    parsed_raw = urlsplit(raw)
    if (
        parsed_raw.scheme.lower() not in {"http", "https"}
        or not parsed_raw.netloc
        or parsed_raw.path not in {"", "/"}
        or parsed_raw.query
        or parsed_raw.fragment
    ):
        raise ValueError("App origin must be an exact HTTP(S) origin without a path, query, or fragment")

    origin = normalize_origin(raw)
    configured: List[str] = []
    for configured_value in configured_origins or configured_app_origins():
        try:
            configured_origin = normalize_origin(configured_value)
        except ValueError:
            continue
        if configured_origin not in configured:
            configured.append(configured_origin)

    if origin in configured:
        return origin

    current_environment = str(environment or ENVIRONMENT).strip().lower()
    if current_environment in LOCAL_DEVELOPMENT_ENVIRONMENTS:
        requested = urlsplit(origin)
        for configured_origin in configured:
            expected = urlsplit(configured_origin)
            if (
                requested.scheme == expected.scheme
                and requested.hostname in LOOPBACK_HOSTNAMES
                and expected.hostname in LOOPBACK_HOSTNAMES
            ):
                return origin

    raise ValueError("App origin is not configured for this deployment")


def extension_app_origin_from_request(request: Request) -> Optional[str]:
    raw = request.headers.get("X-AccessGuard-App-Origin")
    try:
        return validate_extension_app_origin(raw)
    except ValueError as exc:
        raise HTTPException(403, f"Invalid X-AccessGuard-App-Origin: {exc}") from exc


def build_extension_policy(
    candidate: Dict[str, Any],
    session: Dict[str, Any],
    *,
    api_origin: Optional[str] = None,
    validated_app_origin: Optional[str] = None,
    generated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Build the canonical policy document consumed by the browser extension."""
    configured_origins = configured_app_origins()
    primary_app_origin = (
        normalize_origin(validated_app_origin)
        if validated_app_origin
        else configured_origins[0]
    )
    app_origins = [primary_app_origin] + [
        origin for origin in configured_origins if origin != primary_app_origin
    ]
    route = "/quiz/secure" if session.get("quiz_mode") else "/student/exam"
    configured_exam_url = os.environ.get("EXAM_APP_URL")
    if configured_exam_url and validated_app_origin:
        configured_exam = urlsplit(normalize_allowed_url(configured_exam_url))
        target_origin = urlsplit(primary_app_origin)
        exam_path = configured_exam.path
        if exam_path == "/" and not configured_exam.query:
            exam_path = route
        exam_url = urlunsplit((
            target_origin.scheme,
            target_origin.netloc,
            exam_path,
            configured_exam.query,
            "",
        ))
    else:
        exam_url = normalize_allowed_url(
            configured_exam_url or f"{primary_app_origin}{route}"
        )

    allowed_urls: List[str] = []
    allowed_origins: List[str] = []
    raw_urls = list(session.get("whitelisted_urls", []) or []) + [exam_url]
    for raw in raw_urls:
        try:
            normalized = normalize_allowed_url(raw)
            origin = normalize_origin(normalized)
        except ValueError:
            continue
        if normalized not in allowed_urls:
            allowed_urls.append(normalized)
        if origin not in allowed_origins:
            allowed_origins.append(origin)
    for origin in app_origins:
        if origin not in allowed_origins:
            allowed_origins.append(origin)
    if api_origin:
        try:
            normalized_api_origin = normalize_origin(api_origin)
            if normalized_api_origin not in allowed_origins:
                allowed_origins.append(normalized_api_origin)
        except ValueError:
            pass

    state = extension_policy_state(candidate.get("status", ""), session.get("status", ""))
    lockdown_mode = session.get("lockdown_mode", "extension_required")
    enforcement = state in ENFORCING_EXTENSION_STATES and lockdown_mode == "extension_required"
    now_value = generated_at or now_iso()
    return {
        "candidate_id": candidate["id"],
        "session_id": session["id"],
        "state": state,
        "enforcement": enforcement,
        "policy_version": int(session.get("policy_version", 1) or 1),
        "lockdown_mode": lockdown_mode,
        "extension_required": lockdown_mode == "extension_required",
        "require_fullscreen": bool(session.get("require_fullscreen", True)),
        "extension_min_version": session.get("extension_min_version", "1.0.0"),
        "app_origins": app_origins,
        "allowed_origins": allowed_origins,
        "allowed_urls": allowed_urls,
        "exam_url": exam_url,
        "timestamps": {
            "generated_at": now_value,
            "policy_updated_at": session.get("policy_updated_at") or session.get("created_at"),
            "session_started_at": session.get("started_at"),
            "session_ended_at": session.get("ended_at"),
            "candidate_joined_at": candidate.get("joined_at"),
            "candidate_approved_at": candidate.get("approved_at"),
            "candidate_locked_at": candidate.get("locked_at"),
            "candidate_submitted_at": candidate.get("submitted_at"),
            "candidate_exited_at": candidate.get("exited_at"),
            "last_extension_heartbeat_at": candidate.get("last_extension_heartbeat_at"),
        },
    }


def extension_heartbeat_is_recent(
    candidate: Dict[str, Any],
    session: Dict[str, Any],
    *,
    now: Optional[datetime] = None,
) -> bool:
    if candidate.get("extension_enforcement_active") is not True:
        return False
    try:
        if int(candidate.get("extension_policy_version", -1)) < int(session.get("policy_version", 1) or 1):
            return False
    except (TypeError, ValueError):
        return False
    last_seen = parse_iso_datetime(candidate.get("last_extension_heartbeat_at"))
    if not last_seen:
        return False
    current = now or datetime.now(timezone.utc)
    interval = max(1, int(session.get("heartbeat_interval_sec", 10) or 10))
    grace = max(EXTENSION_HEARTBEAT_GRACE_SEC, interval * 3)
    if (current - last_seen).total_seconds() > grace:
        return False
    return version_at_least(
        candidate.get("extension_version"),
        session.get("extension_min_version", "1.0.0"),
    )


def seconds_remaining(session: Dict[str, Any], *, now: Optional[datetime] = None) -> int:
    duration_seconds = max(0, int(session.get("duration_minutes", 0) or 0) * 60)
    started = parse_iso_datetime(session.get("started_at"))
    if not started:
        return duration_seconds
    current = now or datetime.now(timezone.utc)
    return max(0, duration_seconds - int((current - started).total_seconds()))


def production_config_errors() -> List[str]:
    if not IS_PRODUCTION:
        return []
    errors: List[str] = []
    if JWT_SECRET == "accessguard-secret" or len(JWT_SECRET) < 32:
        errors.append("JWT_SECRET must be a non-default value of at least 32 characters")
    if ADMIN_PASSWORD == "password":
        errors.append("ADMIN_PASSWORD must not use the development default")
    if REMOTE_LOGIN_SECRET == "remote-access-2026":
        errors.append("REMOTE_LOGIN_SECRET must not use the development default")
    if os.environ.get("CORS_ORIGINS", "*").strip() == "*":
        errors.append("CORS_ORIGINS must be explicit in production")
    return errors


async def log_invigilator_login(
    inv_id: str,
    method: str,
    success: bool,
    request: Optional[Request] = None,
    detail: Optional[str] = None,
) -> None:
    record = {
        "inv_id": inv_id,
        "method": method,
        "success": success,
        "detail": detail or "",
        "created_at": now_iso(),
    }
    if request is not None:
        if request.client:
            record["remote_ip"] = request.client.host
        record["user_agent"] = request.headers.get("user-agent", "")
    await db[LOGIN_AUDIT_COLLECTION].insert_one(record)


async def current_invigilator(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> Dict[str, Any]:
    if not creds:
        raise HTTPException(401, "Missing token")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid token")
    if payload.get("role") != "invigilator":
        raise HTTPException(403, "Forbidden")
    user = await db.invigilators.find_one({"inv_id": payload["sub"]}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(401, "User not found")
    return user


async def owned_session(sid: str, user: Dict[str, Any]) -> Dict[str, Any]:
    session = await db.sessions.find_one(
        {"id": sid, "owner_inv_id": user["inv_id"]},
        {"_id": 0},
    )
    if not session:
        # Do not reveal another invigilator's session identifiers.
        raise HTTPException(404, "Session not found")
    return session


async def authenticated_candidate(
    request: Request,
    candidate_id: str,
    *,
    body_token: Optional[str] = None,
) -> Dict[str, Any]:
    token = extract_candidate_token(request, body_token)
    if not token:
        raise HTTPException(401, "Missing candidate token")
    candidate = await db.candidates.find_one({"id": candidate_id}, {"_id": 0})
    if not candidate or not verify_candidate_access_token(
        token,
        candidate_id,
        candidate.get("session_id", ""),
        allow_legacy=ALLOW_LEGACY_CANDIDATE_TOKENS,
    ):
        raise HTTPException(401, "Invalid candidate token")
    return candidate


async def candidate_session(candidate: Dict[str, Any]) -> Dict[str, Any]:
    session = await db.sessions.find_one({"id": candidate.get("session_id")}, {"_id": 0})
    if not session:
        raise HTTPException(404, "Session not found")
    return session


def require_candidate_state(
    candidate: Dict[str, Any],
    session: Dict[str, Any],
    *,
    allowed_statuses: Set[str],
    require_live: bool = True,
) -> None:
    if require_live and session.get("status") != "live":
        raise HTTPException(409, "Session is not live")
    if candidate.get("status") not in allowed_statuses:
        raise HTTPException(423, f"Candidate is {candidate.get('status', 'not eligible')}")


# ---- Models ----
class LoginIn(BaseModel):
    inv_id: str
    password: Optional[str] = None
    login_method: str = "password"
    remote_token: Optional[str] = None


class RegisterIn(BaseModel):
    inv_id: str
    name: str
    password: str


class Request2FAIn(BaseModel):
    inv_id: str


class TokenOut(BaseModel):
    token: str
    inv_id: str
    name: str


class SessionConfig(BaseModel):
    exam_name: str
    exam_code: str
    duration_minutes: int = 180
    max_students: int = 50
    heartbeat_interval_sec: int = 10
    allow_pause: bool = True
    auto_record_webcam: bool = True
    save_screen_share: bool = True
    whitelisted_urls: List[str] = Field(default_factory=list)
    whitelisted_apps: List[str] = Field(default_factory=list)
    questions: List[Dict[str, Any]] = Field(default_factory=list)
    model_answers: Dict[str, str] = Field(default_factory=dict)
    scheduled_for: Optional[str] = None
    quiz_mode: bool = False
    module_code: Optional[str] = None
    quiz_prompt_title: Optional[str] = None
    quiz_prompt_body: Optional[str] = None
    published: bool = False
    lockdown_mode: Literal["extension_required", "monitor_only", "disabled"] = "extension_required"
    require_manual_approval: bool = True
    require_identity_verification: bool = True
    require_fullscreen: bool = True
    extension_min_version: str = "1.0.0"
    policy_version: int = Field(default=1, ge=1)


class StudentJoinIn(BaseModel):
    session_code: str
    student_id: str
    full_name: str
    id_front_b64: str = ""
    id_back_b64: str = ""
    selfie_b64: str = ""
    liveness_passed: bool = True
    face_match_score: float = 0.0


class HeartbeatIn(BaseModel):
    candidate_id: str
    latency_ms: int = 0
    bandwidth: str = "good"
    face_visible: bool = True
    tab_active: bool = True
    note: Optional[str] = None


class ViolationIn(BaseModel):
    candidate_id: str
    kind: str  # prohibited_url | tab_switch | face_lost | unauthorized_person | audio_detected
    detail: str = ""


class AnswerIn(BaseModel):
    candidate_id: str
    answers: Dict[str, str]


class GradeIn(BaseModel):
    pass  # uses session-level model answers


class GradeOverrideIn(BaseModel):
    total: float
    invigilator_comment: Optional[str] = None


class ApprovalIn(BaseModel):
    candidate_id: str
    approve: bool


class CandidateCommandIn(BaseModel):
    reason: str = Field(default="", max_length=500)


class ExtensionHeartbeatIn(BaseModel):
    candidate_id: str
    extension_version: str = Field(min_length=1, max_length=50)
    policy_version: int = Field(default=0, ge=0)
    sequence: int = Field(default=0, ge=0)
    fullscreen: bool = False
    enforcement_active: bool = False
    active_url: Optional[str] = Field(default=None, max_length=2048)
    active_origin: Optional[str] = Field(default=None, max_length=512)
    open_tab_count: int = Field(default=1, ge=0, le=1000)


class ExtensionAccessRequestIn(BaseModel):
    candidate_id: str
    url: str = Field(min_length=1, max_length=2048)
    reason: str = Field(default="", max_length=500)


class AccessRequestDecisionIn(BaseModel):
    approve: bool
    reason: str = Field(default="", max_length=500)


# ---- Auth ----
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global http_client
    config_errors = production_config_errors()
    if config_errors:
        raise RuntimeError("Unsafe production configuration: " + "; ".join(config_errors))
    http_client = httpx.AsyncClient(timeout=30.0)
    # Log the actual module file path on startup to help debugging reloads
    try:
        log.info(f"Loaded server module: {__file__}")
        # Dump LoginIn schema at startup to help debug mismatched OpenAPI
        try:
            log.info("LoginIn schema loaded by process: %s", LoginIn.model_json_schema())
        except Exception:
            log.info("Failed to dump LoginIn schema at startup")
    except Exception:
        pass
    await init_storage_async()
    # Seed admin and example invigilators for testing
    existing = await db.invigilators.find_one({"inv_id": ADMIN_INV_ID})
    if not existing:
        await db.invigilators.insert_one({
            "inv_id": ADMIN_INV_ID,
            "name": "Alex Chen",
            "password_hash": hash_pw(ADMIN_PASSWORD),
            "created_at": now_iso(),
        })
        log.info(f"Seeded admin {ADMIN_INV_ID}")

    # Ensure we have a local test invigilator, but never seed it in production.
    if not IS_PRODUCTION and not await db.invigilators.find_one({"inv_id": "EG/STAFF/0001"}):
        await db.invigilators.insert_one({
            "inv_id": "EG/STAFF/0001",
            "name": "Test Invigilator",
            "password_hash": hash_pw("AccessGuard2026!"),
            "phone": "+15550101",
            "created_at": now_iso(),
        })
        log.info("Seeded invigilator EG/STAFF/0001")
    yield
    if http_client:
        await http_client.aclose()
    client.close()


app.router.lifespan_context = lifespan


@api.post("/auth/login", response_model=TokenOut)
async def login(body: LoginIn, request: Request):
    method = (body.login_method or "password").lower()
    user = await db.invigilators.find_one({"inv_id": body.inv_id})
    success = False
    detail = None
    try:
        if method == "remote_token":
            if IS_PRODUCTION and os.environ.get("ALLOW_REMOTE_LOGIN", "0") != "1":
                detail = "Remote login is disabled"
                raise HTTPException(403, "Remote login is disabled")
            if not body.remote_token or body.remote_token != REMOTE_LOGIN_SECRET:
                detail = "Invalid remote login token"
                raise HTTPException(401, "Invalid remote login token")
            if not user:
                detail = "Invigilator not found"
                raise HTTPException(404, "Invigilator not found")
        elif method == "password":
            if not user or not body.password or not verify_pw(body.password, user["password_hash"]):
                detail = "Invalid credentials"
                raise HTTPException(401, "Invalid credentials")
            # Two-factor authentication temporarily disabled to simplify login during testing.
            # Clear any stored 2FA state on successful password login.
            await db.invigilators.update_one({"inv_id": user["inv_id"]}, {"$unset": {"two_factor_code": 1, "two_factor_expiry": 1}})
        else:
            detail = f"Unsupported login method: {method}"
            raise HTTPException(400, "Unsupported login method")

        success = True
        return TokenOut(token=make_token(user["inv_id"], "invigilator"), inv_id=user["inv_id"], name=user["name"])
    finally:
        if user:
            await log_invigilator_login(
                inv_id=body.inv_id,
                method=method,
                success=success,
                request=request,
                detail=detail,
            )
        else:
            await log_invigilator_login(
                inv_id=body.inv_id,
                method=method,
                success=False,
                request=request,
                detail=detail or "User not found",
            )





@api.post("/auth/register", response_model=TokenOut)
async def register(body: RegisterIn):
    if IS_PRODUCTION and os.environ.get("ALLOW_SELF_REGISTRATION", "0") != "1":
        raise HTTPException(403, "Self-registration is disabled")
    if await db.invigilators.find_one({"inv_id": body.inv_id}):
        raise HTTPException(400, "Invigilator already exists")
    await db.invigilators.insert_one({
        "inv_id": body.inv_id,
        "name": body.name,
        "password_hash": hash_pw(body.password),
        "created_at": now_iso(),
    })
    return TokenOut(token=make_token(body.inv_id, "invigilator"), inv_id=body.inv_id, name=body.name)


@api.post("/auth/request-2fa")
async def request_2fa(body: Request2FAIn):
    if IS_PRODUCTION:
        raise HTTPException(503, "Demo 2FA is unavailable")
    user = await db.invigilators.find_one({"inv_id": body.inv_id})
    if not user:
        raise HTTPException(404, "Invigilator not found")
    return {"code": "123456"}


@api.get("/auth/me")
async def me(user=Depends(current_invigilator)):
    return user


@api.get("/health")
async def health():
    try:
        await asyncio.wait_for(db.command("ping"), timeout=2.0)
    except Exception as exc:
        log.warning("Health check database ping failed: %s", exc)
        raise HTTPException(503, "Database unavailable")
    return {"status": "ok", "database": "ok", "environment": ENVIRONMENT}


@api.get("/auth/logs")
async def get_login_logs(inv_id: Optional[str] = None, user=Depends(current_invigilator)):
    if inv_id and inv_id != user["inv_id"] and user["inv_id"] != ADMIN_INV_ID:
        raise HTTPException(403, "Forbidden")
    query = {"inv_id": inv_id or user["inv_id"]}
    rows = await db[LOGIN_AUDIT_COLLECTION].find(query, {"_id": 0}).sort("created_at", -1).to_list(100)
    return rows


# ---- Sessions ----
@api.post("/sessions")
async def create_session(cfg: SessionConfig, user=Depends(current_invigilator)):
    sid = str(uuid.uuid4())
    code = make_session_code(cfg.exam_code)
    cfg_data = cfg.model_dump()
    try:
        _, normalized_urls = normalize_allowlist(cfg.whitelisted_urls)
    except ValueError as exc:
        raise HTTPException(422, f"Invalid allowed URL: {exc}")
    cfg_data["whitelisted_urls"] = normalized_urls
    cfg_data["policy_version"] = 1
    created_at = now_iso()
    doc = {
        "id": sid,
        "session_code": code,
        "owner_inv_id": user["inv_id"],
        "status": "scheduled",  # scheduled | live | ended
        "created_at": created_at,
        "started_at": None,
        "ended_at": None,
        "policy_updated_at": created_at,
        **cfg_data,
    }
    await db.sessions.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.get("/sessions")
async def list_sessions(user=Depends(current_invigilator)):
    rows = await db.sessions.find(
        {"owner_inv_id": user["inv_id"]}, {"_id": 0}
    ).sort("created_at", -1).to_list(200)
    return rows


@api.get("/sessions/{sid}")
async def get_session(sid: str, user=Depends(current_invigilator)):
    s = await db.sessions.find_one({"id": sid, "owner_inv_id": user["inv_id"]}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Session not found")
    return s


@api.post("/sessions/{sid}/start")
async def start_session(sid: str, user=Depends(current_invigilator)):
    session = await owned_session(sid, user)
    if session.get("status") == "ended":
        raise HTTPException(409, "Ended sessions cannot be restarted")
    if session.get("status") == "live":
        return {"ok": True, "started_at": session.get("started_at")}
    started_at = now_iso()
    res = await db.sessions.update_one(
        {"id": sid, "owner_inv_id": user["inv_id"]},
        {"$set": {"status": "live", "started_at": started_at}},
    )
    if not res.matched_count:
        raise HTTPException(404, "Session not found")
    await ws_broadcast(sid, {"type": "session_started", "started_at": started_at})
    return {"ok": True, "started_at": started_at}


@api.post("/sessions/{sid}/end")
async def end_session(sid: str, user=Depends(current_invigilator)):
    session = await owned_session(sid, user)
    if session.get("status") == "ended":
        return {"ok": True, "ended_at": session.get("ended_at")}
    ended_at = now_iso()
    res = await db.sessions.update_one(
        {"id": sid, "owner_inv_id": user["inv_id"]},
        {"$set": {"status": "ended", "ended_at": ended_at}},
    )
    if not res.matched_count:
        raise HTTPException(404, "Session not found")
    await ws_broadcast(sid, {"type": "session_ended", "ended_at": ended_at})
    return {"ok": True, "ended_at": ended_at}


@api.delete("/sessions/{sid}")
async def delete_session(sid: str, user=Depends(current_invigilator)):
    await owned_session(sid, user)
    cands = await db.candidates.find({"session_id": sid}, {"_id": 0, "id": 1}).to_list(1000)
    cids = [c["id"] for c in cands]

    res = await db.sessions.delete_one({"id": sid, "owner_inv_id": user["inv_id"]})
    if not res.deleted_count:
        raise HTTPException(404, "Session not found")

    await db.candidates.delete_many({"session_id": sid})
    await db.grades.delete_many({"session_id": sid})
    await db.access_requests.delete_many({"session_id": sid})
    if cids:
        await db.answers.delete_many({"candidate_id": {"$in": cids}})
        await db.violations.delete_many({"candidate_id": {"$in": cids}})
        await db.heartbeats.delete_many({"candidate_id": {"$in": cids}})
        await db.live_frames.delete_many({"candidate_id": {"$in": cids}})

    return {"ok": True, "deleted_id": sid}


# ---- Public session lookup (for students) ----
@api.get("/public/sessions/by-code/{code}")
async def session_by_code(code: str):
    s = await db.sessions.find_one({"session_code": code}, {"_id": 0, "model_answers": 0})
    if not s:
        raise HTTPException(404, "Invalid session code")
    return {
        "id": s["id"],
        "session_code": s["session_code"],
        "exam_name": s["exam_name"],
        "exam_code": s["exam_code"],
        "duration_minutes": s["duration_minutes"],
        "status": s["status"],
        "lockdown_mode": s.get("lockdown_mode", "extension_required"),
        "extension_required": s.get("lockdown_mode", "extension_required") == "extension_required",
        "require_fullscreen": bool(s.get("require_fullscreen", True)),
        "require_identity_verification": bool(s.get("require_identity_verification", True)),
        "auto_record_webcam": bool(s.get("auto_record_webcam", True)),
        "heartbeat_interval_sec": int(s.get("heartbeat_interval_sec", 10) or 10),
        "extension_min_version": s.get("extension_min_version", "1.0.0"),
        "quiz_mode": s.get("quiz_mode", False),
        "module_code": s.get("module_code"),
        "quiz_prompt_title": s.get("quiz_prompt_title"),
        "quiz_prompt_body": s.get("quiz_prompt_body"),
        "published": s.get("published", False),
    }


@api.get("/public/quizzes/module/{module_code}")
async def public_quizzes_by_module(module_code: str):
    pattern = module_code.upper()
    rows = await db.sessions.find(
        {
            "quiz_mode": True,
            "published": True,
            "module_code": {"$regex": f"^{pattern}$", "$options": "i"},
        },
        {"_id": 0, "model_answers": 0, "questions": 0, "whitelisted_urls": 0},
    ).sort("created_at", -1).to_list(50)
    return rows


# ---- Candidates (students join requests) ----
@api.post("/public/candidates/join")
async def candidate_join(body: StudentJoinIn):
    s = await db.sessions.find_one({"session_code": body.session_code}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Invalid session code")
    if s.get("status") == "ended":
        raise HTTPException(409, "Session has ended")
    candidate_count = await db.candidates.count_documents(
        {"session_id": s["id"], "status": {"$nin": list(REJOINABLE_CANDIDATE_STATES)}}
    )
    if candidate_count >= int(s.get("max_students", 50) or 50):
        raise HTTPException(409, "Session is at capacity")
    existing = await db.candidates.find_one(
        {
            "session_id": s["id"],
            "student_id": body.student_id,
            "status": {"$nin": list(REJOINABLE_CANDIDATE_STATES)},
        },
        {"_id": 0, "id": 1},
    )
    if existing:
        raise HTTPException(409, "Student already joined this session")
    cid = str(uuid.uuid4())
    # Upload images concurrently to object storage
    upload_tasks = []
    fields = []
    for field, b64 in [
        ("id_front", body.id_front_b64),
        ("id_back", body.id_back_b64),
        ("selfie", body.selfie_b64),
    ]:
        fields.append((field, b64))
        if b64:
            upload_tasks.append(put_b64_image(f"{APP_NAME}/candidates/{cid}/{field}.jpg", b64))
        else:
            upload_tasks.append(asyncio.sleep(0, result=None))
    upload_results = await asyncio.gather(*upload_tasks)
    urls: Dict[str, Optional[str]] = {}
    for (field, b64), sp in zip(fields, upload_results):
        if not b64:
            urls[f"{field}_url"] = None
        elif sp:
            urls[f"{field}_url"] = f"/api/public/files/{sp}"
        else:
            urls[f"{field}_url"] = b64 if b64.startswith("data:") else f"data:image/jpeg;base64,{b64}"
    candidate_token = make_candidate_token(cid, s["id"])
    initial_status = "pending" if s.get("require_manual_approval", True) else "approved"
    approved_at = now_iso() if initial_status == "approved" else None
    doc = {
        "id": cid,
        "session_id": s["id"],
        "session_code": body.session_code,
        "student_id": body.student_id,
        "full_name": body.full_name,
        **urls,
        "liveness_passed": body.liveness_passed,
        "face_match_score": body.face_match_score,
        "status": initial_status,
        "joined_at": now_iso(),
        "approved_at": approved_at,
        "submitted_at": None,
    }
    await db.candidates.insert_one(doc)
    doc.pop("_id", None)
    # Push to invigilator dashboard
    await ws_broadcast(s["id"], {"type": "candidate_joined", "candidate": doc})
    return {**doc, "candidate_token": candidate_token}


@api.get("/public/files/{path:path}")
async def serve_file(path: str):
    data, ct = await get_object_bytes(path)
    return Response(content=data, media_type=ct)


@api.get("/public/candidates/{cid}")
async def candidate_status(cid: str, request: Request):
    await authenticated_candidate(request, cid)
    c = await db.candidates.find_one(
        {"id": cid},
        {"_id": 0, "id_front_url": 0, "id_back_url": 0, "selfie_url": 0,
         "id_front_b64": 0, "id_back_b64": 0, "selfie_b64": 0},
    )
    if not c:
        raise HTTPException(404, "Candidate not found")
    return c


@api.get("/sessions/{sid}/candidates")
async def list_candidates(sid: str, user=Depends(current_invigilator)):
    session = await owned_session(sid, user)
    rows = await db.candidates.find(
        {"session_id": sid},
        {"_id": 0, "id_front_url": 0, "id_back_url": 0,
         "id_front_b64": 0, "id_back_b64": 0},
    ).to_list(500)
    for row in rows:
        row["extension_last_seen_at"] = row.get("last_extension_heartbeat_at")
        row["extension_active"] = (
            row.get("status") in {"approved", "active", "locked"}
            and session.get("status") == "live"
            and extension_heartbeat_is_recent(row, session)
        )
        row["extension_version"] = row.get("extension_version")
    return rows


@api.get("/sessions/{sid}/access-requests")
async def list_access_requests(
    sid: str,
    request_status: Optional[str] = Query(default=None, alias="status"),
    user=Depends(current_invigilator),
):
    await owned_session(sid, user)
    query: Dict[str, Any] = {"session_id": sid}
    if request_status:
        if request_status not in {"pending", "approved", "denied"}:
            raise HTTPException(422, "Invalid access request status")
        query["status"] = request_status
    return await db.access_requests.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)


@api.post("/sessions/{sid}/access-requests/{request_id}/decision")
async def decide_access_request(
    sid: str,
    request_id: str,
    body: AccessRequestDecisionIn,
    user=Depends(current_invigilator),
):
    session = await owned_session(sid, user)
    if session.get("status") == "ended":
        raise HTTPException(409, "Ended sessions cannot grant access")
    access_request = await db.access_requests.find_one(
        {"id": request_id, "session_id": sid, "status": "pending"},
        {"_id": 0},
    )
    if not access_request:
        raise HTTPException(404, "Pending access request not found")
    try:
        approved_origin = normalize_origin(access_request["requested_origin"])
    except ValueError as exc:
        raise HTTPException(422, f"Stored access request URL is invalid: {exc}")

    decided_at = now_iso()
    new_status = "approved" if body.approve else "denied"
    result = await db.access_requests.update_one(
        {"id": request_id, "session_id": sid, "status": "pending"},
        {"$set": {
            "status": new_status,
            "decided_at": decided_at,
            "decided_by": user["inv_id"],
            "decision_reason": body.reason,
        }},
    )
    if not result.matched_count:
        raise HTTPException(409, "Access request was already decided")

    policy_version: Optional[int] = None
    if body.approve:
        policy_updated_at = now_iso()
        if "policy_version" not in session:
            await db.sessions.update_one(
                {"id": sid, "owner_inv_id": user["inv_id"], "policy_version": {"$exists": False}},
                {"$set": {"policy_version": 1}},
            )
        session_result = await db.sessions.update_one(
            {"id": sid, "owner_inv_id": user["inv_id"]},
            {
                "$addToSet": {"whitelisted_urls": approved_origin},
                "$inc": {"policy_version": 1},
                "$set": {"policy_updated_at": policy_updated_at},
            },
        )
        if not session_result.matched_count:
            raise HTTPException(404, "Session not found")
        updated_session = await db.sessions.find_one({"id": sid}, {"_id": 0, "policy_version": 1})
        policy_version = int((updated_session or {}).get("policy_version", 1))
        await ws_broadcast(sid, {
            "type": "policy_updated",
            "policy_version": policy_version,
            "allowed_origin": approved_origin,
            "updated_at": policy_updated_at,
        })

    access_request.update({
        "status": new_status,
        "decided_at": decided_at,
        "decided_by": user["inv_id"],
        "decision_reason": body.reason,
    })
    await ws_broadcast(sid, {
        "type": "access_request_decided",
        "access_request": access_request,
        "policy_version": policy_version,
    })
    return {
        "ok": True,
        "access_request": access_request,
        "policy_version": policy_version,
    }


@api.post("/sessions/{sid}/candidates/decision")
async def decide(sid: str, body: ApprovalIn, user=Depends(current_invigilator)):
    session = await owned_session(sid, user)
    if session.get("status") == "ended":
        raise HTTPException(409, "Ended sessions cannot admit candidates")
    new_status = "approved" if body.approve else "rejected"
    decision_at = now_iso()
    update_fields = {
        "status": new_status,
        "decision_at": decision_at,
        "decision_by": user["inv_id"],
    }
    if body.approve:
        update_fields["approved_at"] = decision_at
    res = await db.candidates.update_one(
        {"id": body.candidate_id, "session_id": sid, "status": "pending"},
        {"$set": update_fields},
    )
    if not res.matched_count:
        raise HTTPException(404, "Candidate not found")
    await ws_broadcast(sid, {
        "type": "candidate_decision",
        "candidate_id": body.candidate_id,
        "status": new_status,
    })
    return {"ok": True, "status": new_status}


@api.post("/sessions/{sid}/candidates/{candidate_id}/kick")
async def kick_candidate(sid: str, candidate_id: str, user=Depends(current_invigilator)):
    await owned_session(sid, user)
    kicked_at = now_iso()
    res = await db.candidates.update_one(
        {
            "id": candidate_id,
            "session_id": sid,
            "status": {"$in": ["pending", "approved", "active", "locked"]},
        },
        {"$set": {"status": "kicked", "kicked_at": kicked_at, "kicked_by": user["inv_id"]}},
    )
    if not res.matched_count:
        raise HTTPException(404, "Candidate not found")
    await ws_broadcast(sid, {
        "type": "candidate_decision",
        "candidate_id": candidate_id,
        "status": "kicked",
    })
    return {"ok": True, "status": "kicked"}


@api.post("/sessions/{sid}/candidates/{candidate_id}/lock")
async def lock_candidate(
    sid: str,
    candidate_id: str,
    body: Optional[CandidateCommandIn] = None,
    user=Depends(current_invigilator),
):
    await owned_session(sid, user)
    reason = body.reason if body else ""
    locked_at = now_iso()
    result = await db.candidates.update_one(
        {"id": candidate_id, "session_id": sid, "status": {"$in": ["approved", "active"]}},
        {"$set": {
            "status": "locked",
            "locked_at": locked_at,
            "locked_by": user["inv_id"],
            "lock_reason": reason,
        }},
    )
    if not result.matched_count:
        raise HTTPException(409, "Candidate cannot be locked from the current state")
    event = {
        "type": "candidate_locked",
        "candidate_id": candidate_id,
        "status": "locked",
        "reason": reason,
        "locked_at": locked_at,
    }
    await ws_broadcast(sid, event)
    return {"ok": True, **event}


@api.post("/sessions/{sid}/candidates/{candidate_id}/resume")
async def resume_candidate(
    sid: str,
    candidate_id: str,
    body: Optional[CandidateCommandIn] = None,
    user=Depends(current_invigilator),
):
    session = await owned_session(sid, user)
    reason = body.reason if body else ""
    if session.get("status") == "ended":
        raise HTTPException(409, "Ended sessions cannot be resumed")
    resumed_at = now_iso()
    result = await db.candidates.update_one(
        {"id": candidate_id, "session_id": sid, "status": "locked"},
        {"$set": {
            "status": "approved",
            "resumed_at": resumed_at,
            "resumed_by": user["inv_id"],
            "resume_reason": reason,
        }},
    )
    if not result.matched_count:
        raise HTTPException(409, "Candidate is not locked")
    event = {
        "type": "candidate_resumed",
        "candidate_id": candidate_id,
        "status": "approved",
        "reason": reason,
        "resumed_at": resumed_at,
    }
    await ws_broadcast(sid, event)
    return {"ok": True, **event}


@api.post("/public/candidates/{cid}/exit")
async def exit_candidate_session(cid: str, request: Request):
    c = await authenticated_candidate(request, cid)
    session = await candidate_session(c)
    require_candidate_state(
        c,
        session,
        allowed_statuses={"pending", "approved", "active", "locked"},
        require_live=False,
    )
    exited_at = now_iso()
    result = await db.candidates.update_one(
        {"id": cid, "status": {"$in": ["pending", "approved", "active", "locked"]}},
        {"$set": {"status": "exited", "exited_at": exited_at}},
    )
    if not result.matched_count:
        raise HTTPException(409, "Candidate cannot exit from the current state")
    await ws_broadcast(c["session_id"], {
        "type": "candidate_exited",
        "candidate_id": cid,
        "status": "exited",
        "exited_at": exited_at,
    })
    return {"ok": True, "status": "exited"}


# ---- Browser extension lockdown ----
@api.get("/public/extension/policy")
async def extension_policy(candidate_id: str, request: Request):
    candidate = await authenticated_candidate(request, candidate_id)
    session = await candidate_session(candidate)
    app_origin = extension_app_origin_from_request(request)
    return build_extension_policy(
        candidate,
        session,
        api_origin=str(request.base_url),
        validated_app_origin=app_origin,
    )


@api.post("/public/extension/heartbeat")
async def extension_heartbeat(body: ExtensionHeartbeatIn, request: Request):
    candidate = await authenticated_candidate(request, body.candidate_id)
    session = await candidate_session(candidate)
    app_origin = extension_app_origin_from_request(request)

    active_url = None
    active_origin = None
    try:
        if body.active_url:
            active_url = normalize_allowed_url(body.active_url)
            active_origin = normalize_origin(active_url)
        elif body.active_origin:
            active_origin = normalize_origin(body.active_origin)
    except ValueError as exc:
        raise HTTPException(422, f"Invalid active URL: {exc}")

    ts = now_iso()
    previous_sequence = int(candidate.get("extension_sequence", -1) or -1)
    accepted = body.sequence == 0 or body.sequence > previous_sequence
    if accepted:
        fields = {
            "last_extension_heartbeat_at": ts,
            "extension_version": body.extension_version,
            "extension_policy_version": body.policy_version,
            "extension_sequence": body.sequence,
            "extension_fullscreen": body.fullscreen,
            "extension_enforcement_active": body.enforcement_active,
            "extension_active_url": active_url,
            "extension_active_origin": active_origin,
            "extension_open_tab_count": body.open_tab_count,
        }
        await db.candidates.update_one({"id": body.candidate_id}, {"$set": fields})
        candidate.update(fields)
        await ws_broadcast(candidate["session_id"], {
            "type": "extension_heartbeat",
            "candidate_id": body.candidate_id,
            "extension_version": body.extension_version,
            "policy_version": body.policy_version,
            "fullscreen": body.fullscreen,
            "enforcement_active": body.enforcement_active,
            "active_origin": active_origin,
            "ts": ts,
        })

    policy = build_extension_policy(
        candidate,
        session,
        api_origin=str(request.base_url),
        validated_app_origin=app_origin,
    )
    return {
        "ok": True,
        "accepted": accepted,
        "state": policy["state"],
        "policy_version": policy["policy_version"],
        "policy": policy,
    }


@api.post("/public/extension/access-requests")
async def create_extension_access_request(body: ExtensionAccessRequestIn, request: Request):
    candidate = await authenticated_candidate(request, body.candidate_id)
    session = await candidate_session(candidate)
    app_origin = extension_app_origin_from_request(request)
    require_candidate_state(
        candidate,
        session,
        allowed_statuses={"approved", "active", "locked"},
    )
    try:
        requested_url = normalize_allowed_url(body.url)
        requested_origin = normalize_origin(requested_url)
    except ValueError as exc:
        raise HTTPException(422, f"Invalid requested URL: {exc}")

    policy = build_extension_policy(
        candidate,
        session,
        api_origin=str(request.base_url),
        validated_app_origin=app_origin,
    )
    if requested_origin in policy["allowed_origins"]:
        return {
            "ok": True,
            "status": "already_allowed",
            "requested_url": requested_url,
            "requested_origin": requested_origin,
            "policy_version": policy["policy_version"],
        }

    existing = await db.access_requests.find_one(
        {
            "session_id": session["id"],
            "candidate_id": candidate["id"],
            "requested_origin": requested_origin,
            "status": "pending",
        },
        {"_id": 0},
    )
    if existing:
        return {"ok": True, "access_request": existing}

    pending_count = await db.access_requests.count_documents({
        "session_id": session["id"],
        "candidate_id": candidate["id"],
        "status": "pending",
    })
    if pending_count >= 10:
        raise HTTPException(429, "Too many pending access requests")

    doc = {
        "id": str(uuid.uuid4()),
        "session_id": session["id"],
        "candidate_id": candidate["id"],
        "student_id": candidate.get("student_id"),
        "full_name": candidate.get("full_name"),
        "requested_url": requested_url,
        "requested_origin": requested_origin,
        "reason": body.reason,
        "status": "pending",
        "created_at": now_iso(),
        "decided_at": None,
        "decided_by": None,
        "decision_reason": "",
    }
    await db.access_requests.insert_one(doc)
    doc.pop("_id", None)
    await ws_broadcast(session["id"], {"type": "access_request_created", "access_request": doc})
    return {"ok": True, "access_request": doc}


@api.get("/public/candidates/{cid}/assessment")
async def candidate_assessment(cid: str, request: Request):
    candidate = await authenticated_candidate(request, cid)
    session = await candidate_session(candidate)
    lockdown_mode = session.get("lockdown_mode", "extension_required")
    extension_required = lockdown_mode == "extension_required"
    extension_verified = extension_heartbeat_is_recent(candidate, session)
    remaining = seconds_remaining(session)
    response = {
        "ready": False,
        "reason": "candidate_not_approved",
        "candidate_status": candidate.get("status"),
        "session_status": session.get("status"),
        "exam_name": session.get("exam_name", ""),
        "exam_code": session.get("exam_code", ""),
        "duration_minutes": int(session.get("duration_minutes", 0) or 0),
        "questions": [],
        "seconds_remaining": remaining,
        "lockdown_mode": lockdown_mode,
        "extension_required": extension_required,
        "extension_verified": extension_verified,
        "require_fullscreen": bool(session.get("require_fullscreen", True)),
        "auto_record_webcam": bool(session.get("auto_record_webcam", True)),
        "heartbeat_interval_sec": int(session.get("heartbeat_interval_sec", 10) or 10),
    }
    if candidate.get("status") not in {"approved", "active"}:
        response["reason"] = f"candidate_{candidate.get('status', 'not_approved')}"
        return response
    if session.get("status") != "live":
        response["reason"] = f"session_{session.get('status', 'unavailable')}"
        return response
    if remaining <= 0:
        response["reason"] = "time_expired"
        return response
    if extension_required and not extension_verified:
        response["reason"] = "extension_heartbeat_required"
        return response
    response.update({
        "ready": True,
        "reason": None,
        "questions": session.get("questions", []),
    })
    return response


# ---- Real-time monitoring ----
class FrameIn(BaseModel):
    candidate_id: str
    candidate_token: Optional[str] = None
    image_b64: str  # data URL or raw base64


@api.post("/public/frames")
async def upload_frame(body: FrameIn, request: Request):
    """Store the latest webcam frame; accepts header/JWT and legacy body HMAC."""
    candidate = await authenticated_candidate(
        request,
        body.candidate_id,
        body_token=body.candidate_token,
    )
    session = await candidate_session(candidate)
    require_candidate_state(
        candidate,
        session,
        allowed_statuses={"approved", "active"},
    )
    if len(body.image_b64) > 8_000_000:
        raise HTTPException(413, "Frame is too large")
    raw = body.image_b64
    if "," in raw:
        raw = raw.split(",", 1)[1]
    image_url = f"data:image/jpeg;base64,{raw}"
    ts = now_iso()
    doc = {
        "candidate_id": body.candidate_id,
        "image_b64": image_url,
        "ts": ts,
    }
    await db.live_frames.replace_one(
        {"candidate_id": body.candidate_id}, doc, upsert=True
    )
    # Broadcast to invigilator dashboard for this candidate's session
    await ws_broadcast(candidate["session_id"], {
        "type": "frame",
        "candidate_id": body.candidate_id,
        "image_b64": image_url,
        "ts": ts,
    })
    return {"ok": True}


@api.get("/sessions/{sid}/frames")
async def session_frames(sid: str, user=Depends(current_invigilator)):
    """Returns map cid -> latest frame data URL for live tile rendering."""
    await owned_session(sid, user)
    cands = await db.candidates.find(
        {"session_id": sid}, {"_id": 0, "id": 1}
    ).to_list(500)
    cids = [c["id"] for c in cands]
    rows = await db.live_frames.find(
        {"candidate_id": {"$in": cids}}, {"_id": 0}
    ).to_list(500)
    return {r["candidate_id"]: {"image_b64": r["image_b64"], "ts": r["ts"]} for r in rows}


@api.post("/public/heartbeats")
async def heartbeat(body: HeartbeatIn, request: Request):
    candidate = await authenticated_candidate(request, body.candidate_id)
    session = await candidate_session(candidate)
    require_candidate_state(
        candidate,
        session,
        allowed_statuses={"approved", "active", "locked"},
    )
    doc = {
        "id": str(uuid.uuid4()),
        "candidate_id": body.candidate_id,
        "latency_ms": body.latency_ms,
        "bandwidth": body.bandwidth,
        "face_visible": body.face_visible,
        "tab_active": body.tab_active,
        "note": body.note,
        "ts": now_iso(),
    }
    await db.heartbeats.insert_one(doc)
    doc.pop("_id", None)
    return {"ok": True}


@api.get("/sessions/{sid}/heartbeats")
async def get_heartbeats(sid: str, user=Depends(current_invigilator)):
    await owned_session(sid, user)
    cands = await db.candidates.find({"session_id": sid}, {"_id": 0, "id": 1}).to_list(500)
    cids = [c["id"] for c in cands]
    rows = await db.heartbeats.find(
        {"candidate_id": {"$in": cids}}, {"_id": 0}
    ).sort("ts", -1).to_list(2000)
    return rows


@api.post("/public/violations")
async def violation(body: ViolationIn, request: Request):
    candidate = await authenticated_candidate(request, body.candidate_id)
    session = await candidate_session(candidate)
    require_candidate_state(
        candidate,
        session,
        allowed_statuses={"approved", "active", "locked"},
    )
    allowed_kinds = {
        "prohibited_url", "tab_switch", "face_lost", "unauthorized_person",
        "audio_detected", "copy_attempt", "extension_disabled", "fullscreen_exit",
        "focus_lost", "blocked_shortcut", "lockdown_bypass",
    }
    if body.kind not in allowed_kinds:
        raise HTTPException(422, "Unsupported violation kind")
    if body.kind not in LOCKING_VIOLATION_KINDS and VIOLATION_DEDUPE_SEC > 0:
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=VIOLATION_DEDUPE_SEC)).isoformat()
        recent = await db.violations.find_one(
            {"candidate_id": body.candidate_id, "kind": body.kind, "ts": {"$gte": cutoff}},
            {"_id": 0, "id": 1},
        )
        if recent:
            return {"ok": True, "locked": False, "duplicate": True}
    doc = {
        "id": str(uuid.uuid4()),
        "candidate_id": body.candidate_id,
        "kind": body.kind,
        "detail": body.detail,
        "ts": now_iso(),
    }
    await db.violations.insert_one(doc)
    locked = body.kind in LOCKING_VIOLATION_KINDS
    if locked:
        locked_at = now_iso()
        await db.candidates.update_one(
            {"id": body.candidate_id, "status": {"$in": ["approved", "active", "locked"]}},
            {"$set": {
                "status": "locked",
                "locked_at": locked_at,
                "lock_reason": f"Automatic lock: {body.kind}",
            }},
        )
    doc.pop("_id", None)
    await ws_broadcast(candidate["session_id"], {
        "type": "violation",
        "candidate_id": body.candidate_id,
        "kind": body.kind,
        "detail": body.detail,
        "ts": doc["ts"],
        "locked": locked,
    })
    return {"ok": True, "locked": locked}


@api.get("/sessions/{sid}/violations")
async def list_violations(sid: str, user=Depends(current_invigilator)):
    await owned_session(sid, user)
    cands = await db.candidates.find({"session_id": sid}, {"_id": 0, "id": 1}).to_list(500)
    cids = [c["id"] for c in cands]
    rows = await db.violations.find(
        {"candidate_id": {"$in": cids}}, {"_id": 0}
    ).sort("ts", -1).to_list(1000)
    return rows


# ---- Answers ----
@api.post("/public/answers")
async def submit_answers(body: AnswerIn, request: Request):
    candidate = await authenticated_candidate(request, body.candidate_id)
    session = await candidate_session(candidate)
    require_candidate_state(
        candidate,
        session,
        allowed_statuses={"approved", "active"},
    )
    allowed_question_ids = {
        str(q.get("id")) for q in session.get("questions", [])
        if isinstance(q, dict) and q.get("id") is not None
    }
    unknown_question_ids = set(body.answers) - allowed_question_ids
    if unknown_question_ids:
        raise HTTPException(422, "Answers contain unknown question IDs")
    if sum(len(str(value)) for value in body.answers.values()) > 200_000:
        raise HTTPException(413, "Answers are too large")
    submitted_at = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "candidate_id": body.candidate_id,
        "answers": body.answers,
        "submitted_at": submitted_at,
    }
    await db.answers.replace_one(
        {"candidate_id": body.candidate_id}, doc, upsert=True
    )
    update_result = await db.candidates.update_one(
        {"id": body.candidate_id, "status": {"$in": ["approved", "active"]}},
        {"$set": {"status": "finished", "submitted_at": submitted_at}},
    )
    if not update_result.matched_count:
        raise HTTPException(409, "Candidate cannot submit from the current state")
    await ws_broadcast(candidate["session_id"], {
        "type": "candidate_finished",
        "candidate_id": body.candidate_id,
        "submitted_at": submitted_at,
    })
    return {"ok": True, "receipt_id": doc["id"]}


@api.get("/public/receipt/{candidate_id}")
async def get_receipt(candidate_id: str, request: Request):
    await authenticated_candidate(request, candidate_id)
    c = await db.candidates.find_one(
        {"id": candidate_id},
        {"_id": 0, "id_front_url": 0, "id_back_url": 0, "selfie_url": 0,
         "id_front_b64": 0, "id_back_b64": 0, "selfie_b64": 0},
    )
    if not c:
        raise HTTPException(404, "Candidate not found")
    a = await db.answers.find_one({"candidate_id": candidate_id}, {"_id": 0})
    s = await db.sessions.find_one({"id": c["session_id"]}, {"_id": 0, "model_answers": 0})
    return {
        "receipt_id": a["id"] if a else None,
        "candidate": c,
        "exam_name": s["exam_name"] if s else "",
        "exam_code": s["exam_code"] if s else "",
        "submitted_at": a["submitted_at"] if a else None,
        "answer_count": len(a["answers"]) if a else 0,
    }


# ---- Reports & AI Grading ----
# ---- Reports & AI Grading ----
def fallback_semantic_score(student_text: str, model_text: str) -> tuple[float, str]:
    """Fallback heuristic grading algorithm when LLM API is unavailable.
    Uses keyword overlap, token intersection, and answer completeness.
    """
    import re
    s_clean = str(student_text or "").strip().lower()
    m_clean = str(model_text or "").strip().lower()
    if not s_clean:
        return 0.0, "No response provided."
    if s_clean == m_clean:
        return 10.0, "Exact match to reference solution."

    s_words = set(re.findall(r"\w+", s_clean))
    m_words = set(re.findall(r"\w+", m_clean))
    if not m_words:
        return 10.0, "Reference solution contains no key tokens."

    intersection = s_words.intersection(m_words)
    jaccard = len(intersection) / float(len(m_words))
    len_ratio = min(1.0, len(s_words) / max(1.0, float(len(m_words))))

    raw_score = (jaccard * 0.70 + len_ratio * 0.30) * 10.0
    score = round(max(0.0, min(10.0, raw_score)), 1)

    return score, f"Automated evaluation score: {int(jaccard * 100)}% key phrase overlap."


@api.get("/sessions/{sid}/report")
async def session_report(sid: str, user=Depends(current_invigilator)):
    s = await db.sessions.find_one({"id": sid, "owner_inv_id": user["inv_id"]}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Session not found")
    cands = await db.candidates.find(
        {"session_id": sid},
        {"_id": 0, "id_front_url": 0, "id_back_url": 0, "selfie_url": 0,
         "id_front_b64": 0, "id_back_b64": 0, "selfie_b64": 0},
    ).to_list(500)
    answers = await db.answers.find({"candidate_id": {"$in": [c["id"] for c in cands]}}, {"_id": 0}).to_list(500)
    violations = await db.violations.find({"candidate_id": {"$in": [c["id"] for c in cands]}}, {"_id": 0}).to_list(2000)
    grades = await db.grades.find({"session_id": sid}, {"_id": 0}).to_list(500)
    by_cand_v: Dict[str, int] = {}
    for v in violations:
        by_cand_v[v["candidate_id"]] = by_cand_v.get(v["candidate_id"], 0) + 1
    grade_map = {g["candidate_id"]: g for g in grades}
    rows = []
    for c in cands:
        ans = next((a for a in answers if a["candidate_id"] == c["id"]), None)
        rows.append({
            "candidate_id": c["id"],
            "student_id": c["student_id"],
            "full_name": c["full_name"],
            "status": c["status"],
            "violations": by_cand_v.get(c["id"], 0),
            "submitted_at": c.get("submitted_at"),
            "answers": ans["answers"] if ans else {},
            "grade": grade_map.get(c["id"]),
        })

    # Statistical summary calculation
    scores = [g["total"] for g in grades if "total" in g]
    max_totals = [g["max_total"] for g in grades if "max_total" in g and g["max_total"] > 0]
    avg_max = (sum(max_totals) / len(max_totals)) if max_totals else 100.0

    mean_score = round(sum(scores) / len(scores), 2) if scores else 0.0
    sorted_scores = sorted(scores)
    median_score = round(sorted_scores[len(sorted_scores) // 2], 2) if sorted_scores else 0.0
    min_score = round(min(scores), 2) if scores else 0.0
    max_score = round(max(scores), 2) if scores else 0.0

    if len(scores) > 1:
        variance = sum((x - mean_score) ** 2 for x in scores) / (len(scores) - 1)
        std_dev = round(variance ** 0.5, 2)
    else:
        std_dev = 0.0

    pass_count = sum(1 for g in grades if g.get("total", 0) >= (g.get("max_total", 100) * 0.5))
    pass_rate = round((pass_count / len(scores)) * 100, 1) if scores else 0.0

    dist = {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0}
    for g in grades:
        tot = g.get("total", 0)
        mt = g.get("max_total", 100) or 100
        pct = (tot / mt) * 100
        if pct >= 90: dist["A"] += 1
        elif pct >= 80: dist["B"] += 1
        elif pct >= 70: dist["C"] += 1
        elif pct >= 60: dist["D"] += 1
        else: dist["F"] += 1

    return {
        "session": s,
        "rows": rows,
        "totals": {
            "candidates": len(cands),
            "finished": sum(1 for c in cands if c["status"] == "finished"),
            "violations": len(violations),
        },
        "stats": {
            "total_graded": len(scores),
            "mean_score": mean_score,
            "median_score": median_score,
            "min_score": min_score,
            "max_score": max_score,
            "std_dev": std_dev,
            "pass_rate": pass_rate,
            "avg_max": avg_max,
            "grade_distribution": dist,
        },
    }


@api.post("/sessions/{sid}/grade")
async def grade_session(sid: str, user=Depends(current_invigilator)):
    s = await db.sessions.find_one({"id": sid, "owner_inv_id": user["inv_id"]}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Session not found")
    model_ans = s.get("model_answers", {})
    if not model_ans:
        raise HTTPException(400, "Provide model_answers in session before grading")
    cands = await db.candidates.find({"session_id": sid}, {"_id": 0, "id": 1, "full_name": 1}).to_list(500)
    cids = [c["id"] for c in cands]
    answers = await db.answers.find({"candidate_id": {"$in": cids}}, {"_id": 0}).to_list(500)

    # Per-question marks (default 10), text and types
    questions = s.get("questions", []) or []
    marks_map: Dict[str, float] = {}
    type_map: Dict[str, str] = {}
    text_map: Dict[str, str] = {}
    for q in questions:
        if isinstance(q, dict) and "id" in q:
            marks_map[q["id"]] = float(q.get("marks", 10))
            type_map[q["id"]] = q.get("type", "text")
            text_map[q["id"]] = q.get("text", "")

    chat = None
    if EMERGENT_LLM_KEY:
        try:
            chat = LlmChat(
                api_key=EMERGENT_LLM_KEY,
                session_id=f"grade-{sid}",
                system_message=(
                    "You are an expert RAG academic evaluator. Review student submission against RAG retrieved context."
                ),
            ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        except Exception as e:
            log.warning(f"Failed to initialize LlmChat: {e}")

    grader = RAGGrader(
        llm_chat=chat,
        openai_key=OPENAI_API_KEY,
        anthropic_key=ANTHROPIC_API_KEY,
        gemini_key=GEMINI_API_KEY,
    )

    results = []
    for a in answers:
        per_q: Dict[str, Any] = {}
        total = 0.0
        max_total = 0.0
        for q_id, model_text in model_ans.items():
            student_text = a["answers"].get(q_id, "")
            q_max = marks_map.get(q_id, 10.0)
            q_type = type_map.get(q_id, "text")
            q_text = text_map.get(q_id, "")

            eval_res = await grader.evaluate_answer(
                question_id=q_id,
                question_text=q_text,
                model_answer=model_text,
                student_answer=student_text,
                max_marks=q_max,
                question_type=q_type,
            )

            per_q[q_id] = eval_res
            total += eval_res["score"]
            max_total += q_max

        grade_doc = {
            "id": str(uuid.uuid4()),
            "session_id": sid,
            "candidate_id": a["candidate_id"],
            "per_question": per_q,
            "total": round(total, 2),
            "max_total": round(max_total, 2),
            "graded_at": now_iso(),
            "rag_graded": True,
        }
        await db.grades.replace_one(
            {"session_id": sid, "candidate_id": a["candidate_id"]}, grade_doc, upsert=True
        )
        grade_doc.pop("_id", None)
        results.append(grade_doc)
    return {"ok": True, "graded": len(results), "results": results}


@api.put("/sessions/{sid}/grade/{candidate_id}")
async def override_grade(
    sid: str,
    candidate_id: str,
    body: GradeOverrideIn,
    user=Depends(current_invigilator),
):
    s = await db.sessions.find_one({"id": sid, "owner_inv_id": user["inv_id"]}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Session not found")
    
    grade_doc = await db.grades.find_one({"session_id": sid, "candidate_id": candidate_id}, {"_id": 0})
    if not grade_doc:
        grade_doc = {
            "id": str(uuid.uuid4()),
            "session_id": sid,
            "candidate_id": candidate_id,
            "per_question": {},
            "max_total": 0.0,
        }
    
    grade_doc["total"] = body.total
    grade_doc["invigilator_comment"] = body.invigilator_comment
    grade_doc["graded_at"] = now_iso()
    grade_doc["is_override"] = True
    
    await db.grades.replace_one(
        {"session_id": sid, "candidate_id": candidate_id}, grade_doc, upsert=True
    )
    grade_doc.pop("_id", None)
    return {"ok": True, "grade": grade_doc}


# ---- Test / Demo Seed Endpoint (dev only) ----
test_api = APIRouter(prefix="/api/test")


@test_api.post("/seed")
async def seed_test_session():
    """Create a ready-to-use test session for local testing.
    Returns invigilator credentials, session code, and URLs.
    """
    # Ensure test invigilator exists
    inv = await db.invigilators.find_one({"inv_id": "INV0001"})
    if not inv:
        await db.invigilators.insert_one({
            "inv_id": "INV0001",
            "name": "Test Invigilator",
            "password_hash": hash_pw("Password123!"),
            "phone": "+15550101",
            "created_at": now_iso(),
        })

    # Check if a test session already exists
    existing = await db.sessions.find_one({"exam_code": "TEST-DEMO-001"}, {"_id": 0})
    if existing:
        return {
            "status": "already_seeded",
            "invigilator": {
                "inv_id": "INV0001",
                "password": "Password123!",
                "login_url": "http://localhost:3000/login",
            },
            "session": {
                "id": existing["id"],
                "session_code": existing["session_code"],
                "exam_name": existing["exam_name"],
                "status": existing["status"],
            },
            "student": {
                "session_code": existing["session_code"],
                "entry_url": "http://localhost:3000/student",
            },
        }

    # Create a test session
    sid = str(uuid.uuid4())
    code = make_session_code("TEST-DEMO-001")
    session_doc = {
        "id": sid,
        "session_code": code,
        "owner_inv_id": "INV0001",
        "status": "live",
        "created_at": now_iso(),
        "started_at": now_iso(),
        "ended_at": None,
        "exam_name": "Demo Exam — Software Engineering",
        "exam_code": "TEST-DEMO-001",
        "duration_minutes": 60,
        "max_students": 5,
        "heartbeat_interval_sec": 10,
        "allow_pause": True,
        "auto_record_webcam": True,
        "save_screen_share": True,
        "whitelisted_urls": ["https://docs.python.org/", "https://developer.mozilla.org/"],
        "whitelisted_apps": [],
        "lockdown_mode": "extension_required",
        "require_manual_approval": True,
        "require_fullscreen": True,
        "extension_min_version": "1.0.0",
        "policy_version": 1,
        "policy_updated_at": now_iso(),
        "questions": [
            {
                "id": "q1",
                "text": "Explain the difference between a process and a thread.",
                "marks": 10,
            },
            {
                "id": "q2",
                "text": "What is the purpose of an API gateway in microservices architecture?",
                "marks": 10,
            },
            {
                "id": "q3",
                "text": "Write a Python function that checks if a string is a palindrome.",
                "marks": 20,
            },
        ],
        "model_answers": {
            "q1": "A process is an independent program with its own memory space. A thread is a lightweight unit of execution within a process that shares memory with other threads in the same process.",
            "q2": "An API gateway acts as a single entry point for client requests, routing them to appropriate microservices. It handles cross-cutting concerns like authentication, rate limiting, and load balancing.",
            "q3": "def is_palindrome(s): s = s.lower().replace(' ', ''); return s == s[::-1]",
        },
        "scheduled_for": None,
    }
    await db.sessions.insert_one(session_doc)
    log.info(f"Seeded test session {sid} with code {code}")

    return {
        "status": "seeded",
        "invigilator": {
            "inv_id": "INV0001",
            "password": "Password123!",
            "login_url": "http://localhost:3000/login",
        },
        "session": {
            "id": sid,
            "session_code": code,
            "exam_name": "Demo Exam — Software Engineering",
            "status": "live",
        },
        "student": {
            "session_code": code,
            "entry_url": "http://localhost:3000/student",
        },
    }


@test_api.delete("/reset")
async def reset_test_data():
    """Wipe all test data to start fresh."""
    await db.sessions.delete_many({"exam_code": "TEST-DEMO-001"})
    await db.candidates.delete_many({})
    await db.heartbeats.delete_many({})
    await db.violations.delete_many({})
    await db.answers.delete_many({})
    await db.grades.delete_many({})
    await db.live_frames.delete_many({})
    await db.access_requests.delete_many({})
    return {"status": "reset_complete"}


if not IS_PRODUCTION:
    app.include_router(test_api)
app.include_router(api)


@app.websocket("/api/ws/sessions/{sid}/live")
async def ws_live(websocket: WebSocket, sid: str, token: str = Query(...)):
    """Invigilator-only live event channel. Token = JWT issued at login."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("role") != "invigilator":
            await websocket.close(code=1008)
            return
    except jwt.PyJWTError:
        await websocket.close(code=1008)
        return
    s = await db.sessions.find_one(
        {"id": sid, "owner_inv_id": payload["sub"]}, {"_id": 0, "id": 1}
    )
    if not s:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    ws_subscribers.setdefault(sid, set()).add(websocket)
    try:
        while True:
            await websocket.receive_text()  # client keepalive pings
    except WebSocketDisconnect:
        pass
    finally:
        ws_subscribers.get(sid, set()).discard(websocket)
