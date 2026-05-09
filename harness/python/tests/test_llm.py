"""LLM RPC proxy unit tests.

We pair two StdioJsonRpc peers over an in-memory pipe so the tests stay
purely Python — no TS process, no network. The "TS side" mock registers an
``llm.call`` handler that returns a canned response; the "Python side" is
the real ``LLMClient`` proxy.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from gba_agent import LLMClient, LLMMessage, LLMProviderUnavailable, LLMReplayMiss
from gba_agent.rpc import StdioJsonRpc


def _pair() -> tuple[StdioJsonRpc, StdioJsonRpc]:
    a_read, b_write = os.pipe()
    b_read, a_write = os.pipe()
    a_in = os.fdopen(a_read, "r", buffering=1)
    a_out = os.fdopen(a_write, "w", buffering=1)
    b_in = os.fdopen(b_read, "r", buffering=1)
    b_out = os.fdopen(b_write, "w", buffering=1)
    a = StdioJsonRpc(in_stream=a_in, out_stream=a_out)
    b = StdioJsonRpc(in_stream=b_in, out_stream=b_out)
    return a, b


def test_llm_call_round_trip_plain_dict_messages() -> None:
    py_side, ts_side = _pair()
    captured: list[dict[str, Any]] = []

    def handler(params: dict[str, Any]) -> dict[str, Any]:
        captured.append(params)
        return {
            "text": "hello",
            "model": params["model"],
            "tokens_in": 4,
            "tokens_out": 2,
            "cost_usd": 0.0001,
            "latency_ms": 12.5,
            "prompt_hash": "abc",
            "cached": False,
        }

    ts_side.register("llm.call", handler)
    ts_side.start()
    py_side.start()

    client = LLMClient(py_side)
    result = client.call(
        "gpt-4o-mini",
        [{"role": "user", "content": "hi"}],
        temperature=0.2,
        max_tokens=64,
        paradigm_seed="alpha",
    )
    assert result.text == "hello"
    assert result.tokens_in == 4
    assert result.tokens_out == 2
    assert result.cost_usd == pytest.approx(0.0001)
    assert result.cached is False
    assert result.prompt_hash == "abc"

    assert len(captured) == 1
    p = captured[0]
    assert p["model"] == "gpt-4o-mini"
    assert p["messages"] == [{"role": "user", "content": "hi"}]
    assert p["opts"]["temperature"] == 0.2
    assert p["opts"]["max_tokens"] == 64
    assert p["opts"]["paradigm_seed"] == "alpha"


def test_llm_call_with_message_dataclass() -> None:
    py_side, ts_side = _pair()

    def handler(params: dict[str, Any]) -> dict[str, Any]:
        # Should have already been coerced to plain dicts by the proxy.
        assert all(isinstance(m, dict) for m in params["messages"])
        return {
            "text": "ok",
            "model": "gpt-4o-mini",
            "tokens_in": 1,
            "tokens_out": 1,
            "cost_usd": 0.0,
            "latency_ms": 0.0,
            "prompt_hash": "k",
            "cached": True,
        }

    ts_side.register("llm.call", handler)
    ts_side.start()
    py_side.start()

    client = LLMClient(py_side)
    result = client.call(
        "gpt-4o-mini",
        [LLMMessage(role="user", content="hello")],
    )
    assert result.cached is True


def test_llm_replay_miss_translates_to_python_exception() -> None:
    py_side, ts_side = _pair()

    def handler(params: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("LLMReplayMissError: model=gpt-4o-mini key=deadbeef")

    ts_side.register("llm.call", handler)
    ts_side.start()
    py_side.start()

    client = LLMClient(py_side)
    with pytest.raises(LLMReplayMiss):
        client.call("gpt-4o-mini", [{"role": "user", "content": "x"}])


def test_llm_provider_unavailable_translates() -> None:
    py_side, ts_side = _pair()

    def handler(params: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("LLMProviderUnavailableError: No provider configured to serve model gpt-4o")

    ts_side.register("llm.call", handler)
    ts_side.start()
    py_side.start()

    client = LLMClient(py_side)
    with pytest.raises(LLMProviderUnavailable):
        client.call("gpt-4o", [{"role": "user", "content": "x"}])
