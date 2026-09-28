from __future__ import annotations

import logging
import os
from typing import Any, Dict, List
from pathlib import Path

import httpx
from pydantic import BaseModel

logger = logging.getLogger(__name__)


DEFAULT_PROMPT = (
    "You are a concise profile analyst.\n"
    "Given multi-platform profile hits, infer persona, interests, and risk signals.\n"
    "Keep it under 140 words."
)
PROMPT_FILE = Path(__file__).resolve().parents[2] / "data" / "prompt_profile.txt"


class ProfileInput(BaseModel):
    platform: str
    url: str | None = None
    display_name: str | None = None
    bio: str | None = None
    avatar: str | None = None
    category: str | None = None


class AnalyzeRequest(BaseModel):
    profiles: List[ProfileInput]
    use_llm: bool = False
    llm_model: str | None = None
    ollama_host: str | None = None
    api_mode: str | None = None  # "ollama" (generate) or "openai" (chat)
    username: str | None = None
    email: str | None = None
    prompt: str | None = None


def _dedupe_profiles(profiles: List[ProfileInput]) -> List[ProfileInput]:
    seen = set()
    unique: List[ProfileInput] = []
    for p in profiles:
        key = (p.platform.lower(), (p.url or p.display_name or "").lower())
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def _load_prompt_template(prompt_override: str | None) -> str:
    """Return the prompt text, preferring a caller override, otherwise external file, else default."""
    if prompt_override and prompt_override.strip():
        return prompt_override.strip()

    try:
        content = PROMPT_FILE.read_text(encoding="utf-8").strip()
        if content:
            return content
    except FileNotFoundError:
        pass

    return DEFAULT_PROMPT


def _heuristic_analysis(profiles: List[ProfileInput]) -> Dict[str, Any]:
    uniq_profiles = _dedupe_profiles(profiles)
    total = len(uniq_profiles)
    platforms = [p.platform.lower() for p in uniq_profiles]
    bios = [p.bio for p in profiles if p.bio]

    traits: List[str] = []
    risks: List[str] = []

    if any("github" in p or "gitlab" in p or "bitbucket" in p for p in platforms):
        traits.append("developer/tech footprint")
    if any("linkedin" in p for p in platforms):
        traits.append("professional identity")
    if any("instagram" in p or "facebook" in p or "tiktok" in p for p in platforms):
        traits.append("social presence")
    if any("patreon" in p or "ko-fi" in p or "venmo" in p or "cash app" in p for p in platforms):
        traits.append("creator/monetization signals")
    if any(len(b or "") > 240 for b in bios):
        traits.append("long-form bio detected")

    if len(set(platforms)) <= 2 and total >= 3:
        risks.append("identity reuse across few platforms")
    if any("vpn" in (b or "").lower() or "proxy" in (b or "").lower() for b in bios):
        risks.append("privacy tooling mentioned")

    summary = (
        f"Found {total} profiles across {len(set(platforms))} platforms. "
        "Signals combined into high-level traits and risks."
    )

    return {
        "summary": summary,
        "traits": traits,
        "risks": risks,
        "mode": "heuristic",
        "llm_used": False,
    }


async def _ollama_analysis(
    profiles: List[ProfileInput],
    model: str,
    host: str,
    api_mode: str = "ollama",
    username: str | None = None,
    email: str | None = None,
    prompt_override: str | None = None,
) -> tuple[str, str]:
    profiles = _dedupe_profiles(profiles)
    timeout = httpx.Timeout(float(os.getenv("OLLAMA_TIMEOUT", "60")))
    prompt_lines = [_load_prompt_template(prompt_override)]
    if username:
        prompt_lines.append(f"Username pivot: {username}")
    if email:
        prompt_lines.append(f"Email pivot: {email}")
    prompt_lines.append("Profiles:")
    for p in profiles:
        line = f"- {p.platform}: {p.display_name or ''} | {p.url or ''}"
        if p.bio:
            line += f" | bio: {p.bio[:220]}"
        prompt_lines.append(line)
    prompt_lines.append(
        "Output a single concise paragraph (<100 words) summarizing persona, interests, and risk signals. "
        "Plain text only—no code, no markdown, no lists, no URLs, no instructions, and no scraping guidance."
    )
    prompt = "\n".join(prompt_lines)

    async def _call_generate() -> str:
        payload = {"model": model, "prompt": prompt, "stream": False}
        url = host.rstrip("/") + "/api/generate"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            text = data.get("response") or data.get("data") or ""
            text = text.strip()
            if not text:
                raise ValueError("Ollama generate returned an empty response")
            return text

    async def _call_chat() -> str:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a concise profile analyst."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
        }
        url = host.rstrip("/") + "/v1/chat/completions"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            choice = (data.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            text = message.get("content") or ""
            text = text.strip()
            if not text:
                raise ValueError("Ollama chat returned an empty response")
            return text

    # Try preferred mode, fallback to the other if 404/Not Found
    if api_mode == "openai":
        try:
            return await _call_chat(), "openai"
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise
        # fallback
        return await _call_generate(), "ollama"
    else:
        try:
            return await _call_generate(), "ollama"
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise
        # fallback
        return await _call_chat(), "openai"


async def analyze_profiles(req: AnalyzeRequest) -> Dict[str, Any]:
    deduped = _dedupe_profiles(req.profiles)
    base = _heuristic_analysis(deduped)

    if not req.use_llm:
        return base

    model = req.llm_model or os.getenv("OLLAMA_MODEL", "llama3")
    host = req.ollama_host or os.getenv("OLLAMA_HOST", "http://localhost:11434")
    api_mode = (req.api_mode or os.getenv("OLLAMA_API_MODE", "ollama")).lower()

    try:
        llm_summary, used_mode = await _ollama_analysis(
            deduped,
            model,
            host,
            api_mode,
            username=req.username,
            email=req.email,
            prompt_override=req.prompt,
        )
        llm_summary = llm_summary.strip()
        banned_markers = ["```", "import requests", "from bs4", "BeautifulSoup", "<table", "</table>"]
        if not llm_summary:
            raise ValueError("LLM returned an empty summary")
        if any(marker.lower() in llm_summary.lower() for marker in banned_markers):
            raise ValueError("LLM produced disallowed content (code/HTML)")
        # Once LLM succeeds, drop heuristic traits/risks so the UI doesn't show empty/irrelevant sections
        base["traits"] = []
        base["risks"] = []
        base.update(
            {
                "summary": llm_summary or base["summary"],
                "mode": used_mode,
                "llm_used": True,
                "llm_model": model,
                "llm_error": None,
            }
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("ollama analysis failed")
        error_text = str(exc) or repr(exc)
        base.update(
            {
                "mode": "heuristic_fallback",
                "llm_used": False,
                "llm_model": model,
                "llm_error": error_text,
            }
        )

    return base
