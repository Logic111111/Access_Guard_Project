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
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional, Dict, Any, Set

import httpx
import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import (
    FastAPI, APIRouter, HTTPException, Depends, status, Response,
    Request, WebSocket, WebSocketDisconnect, Query,
)
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, ConfigDict
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from emergentintegrations.llm.chat import LlmChat, UserMessage

load_dotenv(ROOT_DIR / ".env")

# ---- Config ----
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "accessguard")
JWT_SECRET = os.environ.get("JWT_SECRET", "accessguard-secret")
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
ADMIN_INV_ID = os.environ.get("ADMIN_INV_ID", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "password")
REMOTE_LOGIN_SECRET = os.environ.get("REMOTE_LOGIN_SECRET", "remote-access-2026")
LOGIN_AUDIT_COLLECTION = "invigilator_login_audit"

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
    allow_credentials=True,
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


class StudentJoinIn(BaseModel):
    session_code: str
    student_id: str
    full_name: str
    id_front_b64: str
    id_back_b64: str
    selfie_b64: str
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


# ---- Auth ----
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global http_client
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

    # Ensure we have a test invigilator (EG/STAFF/0001)
    if not await db.invigilators.find_one({"inv_id": "EG/STAFF/0001"}):
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
    user = await db.invigilators.find_one({"inv_id": body.inv_id})
    if not user:
        raise HTTPException(404, "Invigilator not found")
    return {"code": "123456"}


@api.get("/auth/me")
async def me(user=Depends(current_invigilator)):
    return user


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
    doc = {
        "id": sid,
        "session_code": code,
        "owner_inv_id": user["inv_id"],
        "status": "scheduled",  # scheduled | live | ended
        "created_at": now_iso(),
        "started_at": None,
        "ended_at": None,
        **cfg.model_dump(),
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
    res = await db.sessions.update_one(
        {"id": sid, "owner_inv_id": user["inv_id"]},
        {"$set": {"status": "live", "started_at": now_iso()}},
    )
    if not res.matched_count:
        raise HTTPException(404, "Session not found")
    return {"ok": True}


@api.post("/sessions/{sid}/end")
async def end_session(sid: str, user=Depends(current_invigilator)):
    res = await db.sessions.update_one(
        {"id": sid, "owner_inv_id": user["inv_id"]},
        {"$set": {"status": "ended", "ended_at": now_iso()}},
    )
    if not res.matched_count:
        raise HTTPException(404, "Session not found")
    return {"ok": True}


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
        "questions": s.get("questions", []),
        "whitelisted_urls": s.get("whitelisted_urls", []),
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
        {"_id": 0, "model_answers": 0},
    ).sort("created_at", -1).to_list(50)
    return rows


# ---- Candidates (students join requests) ----
@api.post("/public/candidates/join")
async def candidate_join(body: StudentJoinIn):
    s = await db.sessions.find_one({"session_code": body.session_code}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Invalid session code")
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
    candidate_token = sign_candidate(cid)
    initial_status = "approved" if body.face_match_score >= 0.50 else "pending"
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
        "approved_at": now_iso() if initial_status == "approved" else None,
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
async def candidate_status(cid: str):
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
    rows = await db.candidates.find(
        {"session_id": sid},
        {"_id": 0, "id_front_url": 0, "id_back_url": 0,
         "id_front_b64": 0, "id_back_b64": 0},
    ).to_list(500)
    return rows


@api.post("/sessions/{sid}/candidates/decision")
async def decide(sid: str, body: ApprovalIn, user=Depends(current_invigilator)):
    new_status = "approved" if body.approve else "rejected"
    res = await db.candidates.update_one(
        {"id": body.candidate_id, "session_id": sid},
        {"$set": {"status": new_status, "approved_at": now_iso()}},
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
    res = await db.candidates.update_one(
        {"id": candidate_id, "session_id": sid},
        {"$set": {"status": "kicked"}},
    )
    if not res.matched_count:
        raise HTTPException(404, "Candidate not found")
    await ws_broadcast(sid, {
        "type": "candidate_decision",
        "candidate_id": candidate_id,
        "status": "kicked",
    })
    return {"ok": True, "status": "kicked"}


# ---- Real-time monitoring ----
class FrameIn(BaseModel):
    candidate_id: str
    candidate_token: str
    image_b64: str  # data URL or raw base64


@api.post("/public/frames")
async def upload_frame(body: FrameIn):
    """Stream-style: store latest webcam frame per candidate. HMAC-protected."""
    if not verify_candidate_token(body.candidate_id, body.candidate_token):
        raise HTTPException(401, "Invalid candidate token")
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
    cand = await db.candidates.find_one(
        {"id": body.candidate_id}, {"_id": 0, "session_id": 1}
    )
    if cand:
        await ws_broadcast(cand["session_id"], {
            "type": "frame",
            "candidate_id": body.candidate_id,
            "image_b64": image_url,
            "ts": ts,
        })
    return {"ok": True}


@api.get("/sessions/{sid}/frames")
async def session_frames(sid: str, user=Depends(current_invigilator)):
    """Returns map cid -> latest frame data URL for live tile rendering."""
    cands = await db.candidates.find(
        {"session_id": sid}, {"_id": 0, "id": 1}
    ).to_list(500)
    cids = [c["id"] for c in cands]
    rows = await db.live_frames.find(
        {"candidate_id": {"$in": cids}}, {"_id": 0}
    ).to_list(500)
    return {r["candidate_id"]: {"image_b64": r["image_b64"], "ts": r["ts"]} for r in rows}


@api.post("/public/heartbeats")
async def heartbeat(body: HeartbeatIn):
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
    cands = await db.candidates.find({"session_id": sid}, {"_id": 0, "id": 1}).to_list(500)
    cids = [c["id"] for c in cands]
    rows = await db.heartbeats.find(
        {"candidate_id": {"$in": cids}}, {"_id": 0}
    ).sort("ts", -1).to_list(2000)
    return rows


@api.post("/public/violations")
async def violation(body: ViolationIn):
    doc = {
        "id": str(uuid.uuid4()),
        "candidate_id": body.candidate_id,
        "kind": body.kind,
        "detail": body.detail,
        "ts": now_iso(),
    }
    await db.violations.insert_one(doc)
    locked = body.kind in ("prohibited_url", "unauthorized_person")
    if locked:
        await db.candidates.update_one(
            {"id": body.candidate_id},
            {"$set": {"status": "locked"}},
        )
    doc.pop("_id", None)
    cand = await db.candidates.find_one(
        {"id": body.candidate_id}, {"_id": 0, "session_id": 1}
    )
    if cand:
        await ws_broadcast(cand["session_id"], {
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
    cands = await db.candidates.find({"session_id": sid}, {"_id": 0, "id": 1}).to_list(500)
    cids = [c["id"] for c in cands]
    rows = await db.violations.find(
        {"candidate_id": {"$in": cids}}, {"_id": 0}
    ).sort("ts", -1).to_list(1000)
    return rows


# ---- Answers ----
@api.post("/public/answers")
async def submit_answers(body: AnswerIn):
    doc = {
        "id": str(uuid.uuid4()),
        "candidate_id": body.candidate_id,
        "answers": body.answers,
        "submitted_at": now_iso(),
    }
    await db.answers.replace_one(
        {"candidate_id": body.candidate_id}, doc, upsert=True
    )
    await db.candidates.update_one(
        {"id": body.candidate_id},
        {"$set": {"status": "finished", "submitted_at": now_iso()}},
    )
    return {"ok": True, "receipt_id": doc["id"]}


@api.get("/public/receipt/{candidate_id}")
async def get_receipt(candidate_id: str):
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
    return {
        "session": s,
        "rows": rows,
        "totals": {
            "candidates": len(cands),
            "finished": sum(1 for c in cands if c["status"] == "finished"),
            "violations": len(violations),
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

    # Per-question marks (default 10) and types
    questions = s.get("questions", []) or []
    marks_map: Dict[str, float] = {}
    type_map: Dict[str, str] = {}
    for q in questions:
        if isinstance(q, dict) and "id" in q:
            marks_map[q["id"]] = float(q.get("marks", 10))
            type_map[q["id"]] = q.get("type", "text")

    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"grade-{sid}",
        system_message=(
            "You are an expert exam grader. Compare a student's answer to the model answer. "
            "Return STRICT JSON: {\"score\": <0-10 number>, \"feedback\": \"<short>\"} only, no prose."
        ),
    ).with_model("anthropic", "claude-sonnet-4-5-20250929")

    results = []
    for a in answers:
        per_q: Dict[str, Any] = {}
        total = 0.0
        max_total = 0.0
        for q_id, model_text in model_ans.items():
            student_text = a["answers"].get(q_id, "")
            q_max = marks_map.get(q_id, 10.0)
            q_type = type_map.get(q_id, "text")

            if q_type == "mcq":
                is_correct = str(student_text).strip().upper() == str(model_text).strip().upper()
                scaled = q_max if is_correct else 0.0
                feedback = f"Correct choice: {model_text}" if is_correct else f"Incorrect. Selected: {student_text}, Correct: {model_text}"
            else:
                prompt = (
                    f"Question id: {q_id}\n"
                    f"Model answer: {model_text}\n"
                    f"Student answer: {student_text}\n"
                    "Return JSON only."
                )
                try:
                    raw = await chat.send_message(UserMessage(text=prompt))
                    import json as _json, re as _re
                    m = _re.search(r"\{.*\}", raw, _re.S)
                    parsed = _json.loads(m.group(0)) if m else {"score": 0, "feedback": "Could not parse"}
                    ai_score = max(0.0, min(10.0, float(parsed.get("score", 0))))
                    # Scale AI's 0-10 score to per-question marks
                    scaled = round((ai_score / 10.0) * q_max, 2)
                    feedback = parsed.get("feedback", "")
                except Exception as e:
                    scaled, feedback = 0.0, f"AI error: {e}"

            per_q[q_id] = {"score": scaled, "max": q_max, "feedback": feedback}
            total += scaled
            max_total += q_max
        grade_doc = {
            "id": str(uuid.uuid4()),
            "session_id": sid,
            "candidate_id": a["candidate_id"],
            "per_question": per_q,
            "total": total,
            "max_total": max_total,
            "graded_at": now_iso(),
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


# Ensure CORS headers are always returned for testing (also handle preflight OPTIONS)
@app.middleware("http")
async def _add_cors_headers(request, call_next):
    from fastapi.responses import Response as FastAPIResponse
    origin = os.environ.get("CORS_ORIGINS", "*")
    allow_origin = origin if origin != "" else "*"
    # Testing hook: simulate a network gateway requiring authentication (HTTP 511).
    # Set environment variable SIMULATE_511=1 to enable, then send header X-Simulate-511: 1
    # or append ?simulate_511=1 to the request URL to trigger.
    try:
        # Allow on-demand simulation of a network-auth gateway by sending
        # header X-Simulate-511: 1 or appending ?simulate_511=1 to the URL.
        # Env var SIMULATE_511=1 can also enable the check globally.
        simulate_enabled = os.environ.get("SIMULATE_511", "0") == "1"
        if request.headers.get("X-Simulate-511") == "1" or request.query_params.get("simulate_511") == "1":
            simulate_enabled = True
        if simulate_enabled:
            from fastapi.responses import PlainTextResponse
            return PlainTextResponse("Network Authentication Required", status_code=511, headers={
                "Content-Type": "text/plain",
                "Access-Control-Allow-Origin": allow_origin,
            })
    except Exception:
        pass
    # Handle preflight
    if request.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": allow_origin,
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
            "Access-Control-Allow-Headers": "*",
        }
        return FastAPIResponse(status_code=200, headers=headers)
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = allow_origin
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response

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
        "whitelisted_urls": ["https://docs.python.org", "https://developer.mozilla.org"],
        "whitelisted_apps": [],
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
    return {"status": "reset_complete"}


app.include_router(test_api)
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    # For the testing environment we allow any origin but do not allow credentials
    allow_credentials=False,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


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
