"""Trajectory RPC proxy. The TS harness owns the on-disk file; we just emit
RPCs describing each step and the final result."""

from __future__ import annotations

from typing import Any

from .rpc import StdioJsonRpc


class TrajectoryProxy:
    def __init__(self, rpc: StdioJsonRpc) -> None:
        self._rpc = rpc

    def add_step(
        self,
        *,
        step: int,
        observation_summary: str,
        action: dict[str, Any],
        latency_ms: float,
        tokens_in: int = 0,
        tokens_out: int = 0,
        cost_usd: float = 0.0,
        screenshot_path: str | None = None,
        verifier_state: dict[str, Any] | None = None,
    ) -> None:
        self._rpc.call(
            "trajectory.add_step",
            {
                "step": step,
                "observation_summary": observation_summary,
                "action": action,
                "latency_ms": latency_ms,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "cost_usd": cost_usd,
                "screenshot_path": screenshot_path,
                "verifier_state": verifier_state,
            },
        )

    def finish(
        self,
        terminal_state: str,
        *,
        verifier_verdict: dict[str, Any] | None = None,
        decline_reason: str | None = None,
    ) -> None:
        self._rpc.call(
            "trajectory.finish",
            {
                "terminal_state": terminal_state,
                "verifier_verdict": verifier_verdict,
                "decline_reason": decline_reason,
            },
        )
