"""Standalone FastAPI backend for DeepKrak3n's public-data service."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import AsyncGenerator

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .profile_analyzer import AnalyzeRequest, PROMPT_FILE, analyze_profiles
from .proxy_manager import ProxyManager
from .search_service import SearchService

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="DeepKrak3n public-data API", version="1.0.0")


def _cors_origins() -> list[str]:
    configured = os.getenv("CORS_ORIGINS", "").strip()
    return [origin.strip() for origin in configured.split(",") if origin.strip()] or ["*"]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

proxy_manager = ProxyManager()
search_service = SearchService(
    max_concurrency=max(1, min(int(os.getenv("MAX_CONCURRENCY", "8")), 16)),
    max_retries=max(0, min(int(os.getenv("PROXY_MAX_RETRIES", "2")), 3)),
    backoff_base=max(0.0, min(float(os.getenv("PROXY_BACKOFF_BASE", "0.5")), 5.0)),
    proxy_manager=proxy_manager,
)


class PromptUpdate(BaseModel):
    prompt: str


def _validate_username(username: str) -> str:
    value = (username or "").strip()
    if not value or len(value) > 80 or not all(char.isalnum() or char in "._-" for char in value):
        raise HTTPException(
            status_code=400,
            detail="Username must use letters, numbers, dots, underscores, or hyphens.",
        )
    return value


def _validate_limit(limit: int | None) -> int:
    value = 30 if limit is None else limit
    if value < 1 or value > 30:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 30")
    return value


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "deepkrak3n"}


@app.post("/api/search/username")
async def search_username(
    username: str = Query(..., min_length=1, max_length=80),
    limit: int | None = Query(None),
) -> dict:
    validated_username = _validate_username(username)
    validated_limit = _validate_limit(limit)
    try:
        return await search_service.search_username(
            username=validated_username,
            limit=validated_limit,
        )
    except Exception:  # noqa: BLE001
        logger.exception("username search failed")
        raise HTTPException(status_code=503, detail="Search engine unavailable") from None


@app.get("/api/search/username/stream")
async def stream_username(
    username: str = Query(..., min_length=1, max_length=80),
    limit: int | None = Query(None),
) -> StreamingResponse:
    validated_username = _validate_username(username)
    validated_limit = _validate_limit(limit)

    async def event_generator() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue = asyncio.Queue()
        result_data: dict = {}

        async def on_result(site_result) -> None:
            await queue.put({"type": "site_result", "result": site_result.__dict__})

        async def run_search() -> None:
            nonlocal result_data
            try:
                result_data = await search_service.search_username(
                    username=validated_username,
                    limit=validated_limit,
                    on_result=on_result,
                )
            except Exception:  # noqa: BLE001
                logger.exception("streaming username search failed")
                await queue.put({"type": "error", "error": "Search engine unavailable"})
            finally:
                await queue.put({"type": "_done"})

        asyncio.create_task(run_search())
        while True:
            event = await queue.get()
            if event.get("type") == "_done":
                break
            yield f"event: {event.get('type', 'message')}\ndata: {json.dumps(event)}\n\n"

        if result_data:
            summary = {
                "type": "search_complete",
                "summary": {
                    "total_found": result_data.get("total_found", 0),
                    "total_checked": result_data.get("total_checked", 0),
                },
                "found_profiles": result_data.get("found_profiles", []),
            }
            yield f"event: search_complete\ndata: {json.dumps(summary)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.get("/api/network/status")
async def network_status() -> dict:
    direct_ip = None
    proxy_ip = None
    proxy_snapshot = proxy_manager.snapshot()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get("https://api.ipify.org?format=json")
            direct_ip = response.json().get("ip")
    except Exception:  # noqa: BLE001
        logger.info("direct network status unavailable")

    if proxy_manager.enabled:
        proxy = await proxy_manager.get_proxy()
        if proxy:
            try:
                async with httpx.AsyncClient(timeout=5.0, proxy=proxy.url) as client:
                    response = await client.get("https://api.ipify.org?format=json")
                    proxy_ip = response.json().get("ip")
            except Exception:  # noqa: BLE001
                logger.info("proxy network status unavailable")

    return {
        "proxy_enabled": proxy_manager.enabled,
        "proxy": proxy_snapshot,
        "direct_ip": direct_ip,
        "proxy_ip": proxy_ip,
    }


@app.post("/api/proxy/toggle")
async def proxy_toggle(enabled: bool = Query(...)) -> dict:
    if enabled and not proxy_manager.proxies:
        proxy_manager.set_enabled(False)
        return {
            "proxy_enabled": False,
            "proxy_count": 0,
            "auto_fetch_attempted": False,
            "message": "No configured proxies; proxy remains disabled.",
        }
    proxy_manager.set_enabled(enabled)
    return {
        "proxy_enabled": proxy_manager.enabled,
        "proxy_count": len(proxy_manager.proxies),
        "auto_fetch_attempted": False,
    }


@app.post("/api/profile/analyze")
async def profile_analyze(req: AnalyzeRequest) -> dict:
    if not req.profiles:
        raise HTTPException(status_code=400, detail="profiles required")
    try:
        return await analyze_profiles(req)
    except Exception:  # noqa: BLE001
        logger.exception("profile analysis failed")
        raise HTTPException(status_code=500, detail="Profile analysis unavailable") from None


@app.post("/api/prompt")
async def save_prompt(body: PromptUpdate) -> dict:
    text = (body.prompt or "").strip("\ufeff").strip()
    if not text:
        raise HTTPException(status_code=400, detail="prompt cannot be empty")
    try:
        PROMPT_FILE.parent.mkdir(parents=True, exist_ok=True)
        PROMPT_FILE.write_text(text, encoding="utf-8")
        return {"saved": True, "bytes": len(text)}
    except OSError:
        logger.exception("failed to save prompt")
        raise HTTPException(status_code=500, detail="Prompt could not be saved") from None


@app.get("/api/ollama/models")
async def list_ollama_models(host: str | None = Query(None)) -> dict:
    target_host = host or os.getenv("OLLAMA_HOST", "http://localhost:11434")
    url = target_host.rstrip("/") + "/api/tags"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json() or {}
            models = [model.get("name") for model in data.get("models", []) if model.get("name")]
            return {"host": target_host, "models": models}
    except Exception:  # noqa: BLE001
        logger.info("configured Ollama host unavailable")
        raise HTTPException(status_code=503, detail="Configured Ollama host unavailable") from None