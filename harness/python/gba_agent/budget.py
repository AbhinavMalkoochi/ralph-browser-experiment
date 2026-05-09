"""Budget RPC proxy."""

from __future__ import annotations

from .rpc import StdioJsonRpc


class BudgetExceeded(Exception):
    pass


class Budget:
    def __init__(self, rpc: StdioJsonRpc) -> None:
        self._rpc = rpc

    def record_step(self) -> None:
        self._rpc.call("budget.record_step", {})

    def record_tokens(self, tokens_in: int, tokens_out: int, usd: float) -> None:
        self._rpc.call(
            "budget.record_tokens",
            {"tokens_in": tokens_in, "tokens_out": tokens_out, "usd": usd},
        )

    def check(self) -> None:
        result = self._rpc.call("budget.check", {})
        if not isinstance(result, dict):
            raise RuntimeError(f"budget.check returned unexpected shape: {result!r}")
        if not result.get("ok"):
            raise BudgetExceeded(result.get("error", "budget exceeded"))
