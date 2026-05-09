"""Browser RPC proxy. Mirrors the TS BrowserSession contract."""

from __future__ import annotations

import base64
from typing import Any

from .rpc import StdioJsonRpc


class BrowserProxy:
    def __init__(self, rpc: StdioJsonRpc) -> None:
        self._rpc = rpc

    def navigate(self, url: str) -> None:
        self._rpc.call("browser.navigate", {"url": url})

    def evaluate(self, expression: str) -> Any:
        return self._rpc.call("browser.evaluate", {"expression": expression})

    def screenshot(self) -> bytes:
        result = self._rpc.call("browser.screenshot", {})
        if not isinstance(result, dict) or "base64" not in result:
            raise RuntimeError(f"browser.screenshot returned unexpected shape: {result!r}")
        return base64.b64decode(result["base64"])
