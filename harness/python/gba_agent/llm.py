"""LLM RPC proxy.

Python agents call ``llm.call(model, messages, **opts)``; the TS harness owns
the cache, budget, trajectory, and provider plumbing (US-004).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .rpc import StdioJsonRpc


class LLMReplayMiss(Exception):
    """Raised when the TS harness reports a replay-mode cache miss."""


class LLMProviderUnavailable(Exception):
    """Raised when no provider is configured to serve the requested model."""


@dataclass(frozen=True)
class LLMMessage:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str

    def to_json(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass(frozen=True)
class LLMResult:
    text: str
    model: str
    tokens_in: int
    tokens_out: int
    cost_usd: float
    latency_ms: float
    prompt_hash: str
    cached: bool


def _coerce_message(m: Any) -> dict[str, str]:
    if isinstance(m, LLMMessage):
        return m.to_json()
    if isinstance(m, dict) and "role" in m and "content" in m:
        return {"role": str(m["role"]), "content": str(m["content"])}
    raise TypeError(f"messages must be LLMMessage or {{role, content}} dicts; got {type(m).__name__}")


class LLMClient:
    """Thin RPC client. The TS LLMClient is the source of truth."""

    def __init__(self, rpc: StdioJsonRpc) -> None:
        self._rpc = rpc

    def call(
        self,
        model: str,
        messages: Iterable[Any],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        json_mode: bool | None = None,
        stop: list[str] | None = None,
        paradigm_seed: str | None = None,
    ) -> LLMResult:
        opts: dict[str, Any] = {}
        if temperature is not None:
            opts["temperature"] = temperature
        if max_tokens is not None:
            opts["max_tokens"] = max_tokens
        if json_mode is not None:
            opts["json_mode"] = json_mode
        if stop is not None:
            opts["stop"] = stop
        if paradigm_seed is not None:
            opts["paradigm_seed"] = paradigm_seed

        try:
            result = self._rpc.call(
                "llm.call",
                {
                    "model": model,
                    "messages": [_coerce_message(m) for m in messages],
                    "opts": opts,
                },
            )
        except Exception as exc:
            text = str(exc)
            if "LLMReplayMissError" in text or "replay miss" in text.lower():
                raise LLMReplayMiss(text) from exc
            if "LLMProviderUnavailableError" in text or "No provider configured" in text:
                raise LLMProviderUnavailable(text) from exc
            raise

        if not isinstance(result, dict):
            raise RuntimeError(f"llm.call returned unexpected shape: {result!r}")
        return LLMResult(
            text=str(result.get("text", "")),
            model=str(result.get("model", model)),
            tokens_in=int(result.get("tokens_in", 0)),
            tokens_out=int(result.get("tokens_out", 0)),
            cost_usd=float(result.get("cost_usd", 0.0)),
            latency_ms=float(result.get("latency_ms", 0.0)),
            prompt_hash=str(result.get("prompt_hash", "")),
            cached=bool(result.get("cached", False)),
        )
