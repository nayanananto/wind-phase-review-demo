"""Public demo adapter for the existing deterministic HITL workflow."""
from __future__ import annotations

from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import secrets
import sys
import threading
import time
from typing import Any

os.environ.setdefault("SEMANTIC_LLM_MODEL", "gpt-4o-mini")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.sessions import SessionMiddleware

from scripts import run_hitl_ui as original_ui
from deployment.casual_agent import (
    CasualConversationAgent, OUT_OF_SCOPE_ANSWER, casual_reply_language,
    classify_casual_message, is_unsupported_request,
)

LOGGER = logging.getLogger("wind_demo")
DATA_MODE = os.getenv("WIND_DATA_MODE", "snapshot").lower()
RUNTIME_DIR = Path(os.getenv("WIND_RUNTIME_DIR", str(PROJECT_ROOT / "runtime"))).resolve()
REQUEST_LIMIT = max(1, int(os.getenv("WIND_REQUESTS_PER_MINUTE", "20")))
LLM_LIMIT = max(0, int(os.getenv("WIND_LLM_REQUESTS_PER_DAY", "30")))
PROCESS_LOCK = threading.Lock()
RATE_LOCK = threading.Lock()
CLIENT_REQUESTS: OrderedDict[str, deque[float]] = OrderedDict()
LLM_USAGE = {"day": "", "requests": 0}
STARTUP_STATUS: dict[str, Any] = {}


class DemoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=1500)


def validate_assets() -> None:
    metadata = json.loads(original_ui.DEFAULT_5MIN_METADATA.read_text(encoding="utf-8"))
    required = [PROJECT_ROOT / p for p in metadata["output_paths"].values()]
    required += [original_ui.DEFAULT_LOCAL_LIVE_HISTORY,
                 original_ui.DEFAULT_LOCAL_LIVE_STATE, original_ui.DEFAULT_LOCAL_LIVE_RAW]
    missing = [str(p.relative_to(PROJECT_ROOT)) for p in required if not p.is_file()]
    if missing:
        raise RuntimeError("Required demo assets are missing: " + ", ".join(missing))


def _snapshot_timestamp() -> str | None:
    payload = json.loads(original_ui.DEFAULT_LOCAL_LIVE_STATE.read_text(encoding="utf-8"))
    for key in ("window_end", "last_observation_time", "generated_at", "updated_at"):
        if payload.get(key):
            return str(payload[key])
    state = payload.get("live_state") or payload.get("current_state") or payload.get("semantic_state") or {}
    return str(state["window_end"]) if state.get("window_end") else None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global STARTUP_STATUS
    if DATA_MODE not in {"snapshot", "live"}:
        raise RuntimeError("WIND_DATA_MODE must be snapshot or live")
    validate_assets()
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    if DATA_MODE == "live":
        result = original_ui._refresh_live_state_with_fallback()
        STARTUP_STATUS = {
            "attempted": True, "ok": bool(result.get("ok")),
            "status": "live_refreshed" if result.get("ok") else "snapshot_fallback",
            "message": "Observations refreshed at startup." if result.get("ok")
                       else "Live refresh unavailable; using the bundled dated snapshot.",
        }
    else:
        STARTUP_STATUS = {
            "attempted": False, "ok": True, "status": "snapshot",
            "message": "Using the bundled dated observation snapshot; no live refresh requested.",
        }
    yield


app = FastAPI(title="Wind Phase Review Demo", lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("WIND_SESSION_SECRET") or secrets.token_urlsafe(32),
    session_cookie="wind_demo_session", max_age=86400, same_site="lax",
    https_only=os.getenv("WIND_SECURE_COOKIES", "0") == "1",
)
app.mount("/static", StaticFiles(directory=original_ui.STATIC_DIR), name="static")


def _session_id(request: Request) -> str:
    if not request.session.get("session_id"):
        request.session["session_id"] = secrets.token_hex(16)
    return request.session["session_id"]


def _check_rate(request: Request) -> None:
    # Use the connection address, never an unvalidated client-supplied header.
    client = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with RATE_LOCK:
        times = CLIENT_REQUESTS.setdefault(client, deque())
        CLIENT_REQUESTS.move_to_end(client)
        while times and now - times[0] >= 60:
            times.popleft()
        if len(times) >= REQUEST_LIMIT:
            raise HTTPException(429, "Please wait a minute before trying again.",
                                headers={"Retry-After": "60"})
        times.append(now)
        while len(CLIENT_REQUESTS) > 2000:
            CLIENT_REQUESTS.popitem(last=False)


def _claim_llm_request() -> bool:
    if not os.getenv("OPENAI_API_KEY"):
        return False
    today = datetime.now(timezone.utc).date().isoformat()
    if LLM_USAGE["day"] != today:
        LLM_USAGE.update(day=today, requests=0)
    if LLM_USAGE["requests"] >= LLM_LIMIT:
        return False
    LLM_USAGE["requests"] += 1
    return True


@app.get("/")
def index() -> FileResponse:
    return FileResponse(original_ui.STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "data_mode": STARTUP_STATUS.get("status", DATA_MODE)}


@app.get("/api/defaults")
def defaults(request: Request) -> dict[str, Any]:
    _session_id(request)
    return {
        "metadata_exists": True, "live_sync": STARTUP_STATUS,
        "data_mode": STARTUP_STATUS.get("status", DATA_MODE),
        "data_as_of": _snapshot_timestamp(),
        "llm_enabled_by_default": bool(os.getenv("OPENAI_API_KEY")) and LLM_LIMIT > 0,
        "numeric_forecast_mode": "disabled", "phase_model_mode": "transition",
    }


def _unsupported_summary(engine: str = "langgraph") -> dict[str, Any]:
    # No evidence tables, fallback explanations or LLM diagnostics in the reply.
    return {
        "intent": "out_of_scope", "mode": "out_of_scope",
        "answer": OUT_OF_SCOPE_ANSWER,
        "demo_data_mode": STARTUP_STATUS.get("status", DATA_MODE),
        "agent_graph": {"enabled": True, "engine": engine, "route": "out_of_scope"},
    }


def _explanation_unavailable(result: dict[str, Any], *, use_llm: bool) -> bool:
    mode = str(result.get("mode") or "")
    if mode in {"out_of_scope", "memory_rag_unavailable", "memory_rag_missing_context"}:
        return True
    if result.get("agent_graph", {}).get("route") == "out_of_scope":
        return True
    if result.get("answer") == OUT_OF_SCOPE_ANSWER:
        return True
    # Keep the offline scientific tools intact. A configured public LLM which
    # failed or exhausted its allowance must not silently substitute prose.
    if os.getenv("OPENAI_API_KEY") and not use_llm:
        return result.get("agent_graph", {}).get("route") != "feedback"
    return bool(use_llm and (
        result.get("explanation_mode") == "heuristic"
        or mode.startswith("deterministic_")
        or mode in {"heuristic", "hitl_gru_live_phase_prediction"}
    ))


@app.post("/api/hitl")
def run_hitl(body: DemoRequest, request: Request) -> dict[str, Any]:
    question = body.question.strip()
    if not question:
        raise HTTPException(422, "Enter a question first.")
    _check_rate(request)
    session_id = _session_id(request)
    # Reject unsupported engineering/general tasks before the legacy memory
    # rewrite can mistake a wind-related question for a scientific follow-up.
    if is_unsupported_request(question):
        return {"summary": _unsupported_summary("domain_guard")}
    casual_intent = classify_casual_message(question)
    # The original JSON memory store requires one writer at a time.
    if not PROCESS_LOCK.acquire(timeout=2):
        raise HTTPException(503, "The demo is busy. Please try again shortly.",
                            headers={"Retry-After": "5"})
    try:
        use_llm = _claim_llm_request()
        if casual_intent is not None:
            reply = CasualConversationAgent().respond(
                casual_intent, language=casual_reply_language(question), enable_llm=use_llm,
            )
            # No scientific pipeline, feedback store, or memory writes here.
            return {"summary": {
                "intent": "small_talk", "mode": "casual_conversation",
                "answer": reply.answer, "llm_requested": use_llm,
                "llm_available": reply.llm_available, "llm_used": reply.llm_used,
                "demo_data_mode": STARTUP_STATUS.get("status", DATA_MODE),
                "agent_graph": {"enabled": True, "engine": "casual_agent", "route": "small_talk"},
            }}
        pipeline = original_ui.StandaloneHITLPipeline(
            metadata_path=original_ui.DEFAULT_5MIN_METADATA,
            latest=True, top_k=5, phase_history_length=3, phase_horizon_steps=1,
            phase_top_k=3, phase_analog_k=5, phase_min_support=5,
            phase_model_mode="transition", numeric_forecast_mode="disabled",
            prefer_live_phase=True, enable_rag=True, enable_llm=use_llm,
            enable_agent_graph=True,
            feedback_path=RUNTIME_DIR / "sessions" / session_id / "feedback.jsonl",
        )
        pipeline.require_llm_explanations = bool(os.getenv("OPENAI_API_KEY")) or use_llm
        result = pipeline.process(question=question, thread_id=session_id)
        if _explanation_unavailable(result, use_llm=use_llm):
            diagnostic = (result.get("memory_rag_debug") or {}).get("llm_error")
            if not isinstance(diagnostic, dict):
                diagnostic = getattr(pipeline.reasoner, "last_error", None) or {}
            LOGGER.warning("Explanation unavailable: category=%s status=%s",
                           diagnostic.get("category", "not_attempted_or_invalid_answer"),
                           diagnostic.get("status_code"))
            return {"summary": _unsupported_summary()}
        summary = original_ui._summarize_response(result)
        summary.pop("model_artifact_path", None)
        summary.pop("thread_id", None)
        summary["demo_data_mode"] = STARTUP_STATUS.get("status", DATA_MODE)
        if summary["demo_data_mode"] in {"snapshot", "snapshot_fallback"}:
            answer = summary.get("answer") or ""
            answer = answer.replace("latest real-time", "bundled snapshot")
            answer = answer.replace("current live window", "snapshot input window")
            answer = answer.replace("latest live semantic token sequence", "snapshot semantic token sequence")
            answer = answer.replace("live wind state", "snapshot wind state")
            summary["answer"] = answer
        return {"summary": summary}
    except Exception:
        LOGGER.exception("HITL demo request failed")
        raise HTTPException(500, "This request could not be completed. Please retry.") from None
    finally:
        PROCESS_LOCK.release()


def main() -> None:
    import uvicorn
    uvicorn.run("deployment.server:app", host=os.getenv("WIND_HOST", "0.0.0.0"),
                port=int(os.getenv("PORT", "7860")), workers=1, proxy_headers=False)


if __name__ == "__main__":
    main()
