"""Bidirectional JSON-RPC 2.0 over line-delimited stdio.

Each side can both call methods on the peer and respond to incoming method
calls. Inbound requests are dispatched to a worker thread so handlers may
themselves issue calls back to the peer without deadlocking the reader.
"""

from __future__ import annotations

import json
import sys
import threading
from queue import Queue
from typing import Any, Callable, IO


Handler = Callable[[dict[str, Any]], Any]


class RpcError(RuntimeError):
    def __init__(self, code: int, message: str):
        super().__init__(f"RPC {code}: {message}")
        self.code = code
        self.message = message


class StdioJsonRpc:
    """Bidirectional JSON-RPC peer over a (read, write) pair of text streams.

    Defaults read=stdin, write=stdout; tests can pass their own pipes.
    """

    def __init__(
        self,
        in_stream: IO[str] | None = None,
        out_stream: IO[str] | None = None,
    ) -> None:
        self.in_stream = in_stream if in_stream is not None else sys.stdin
        self.out_stream = out_stream if out_stream is not None else sys.stdout
        self._next_id = 1
        self._id_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending: dict[int, Queue[Any]] = {}
        self._handlers: dict[str, Handler] = {}
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None

    # ------------------------------ public API ------------------------------

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def start(self) -> None:
        if self._reader is not None:
            return
        self._reader = threading.Thread(
            target=self._read_loop, name="gba-rpc-reader", daemon=True
        )
        self._reader.start()

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float | None = None) -> Any:
        with self._id_lock:
            req_id = self._next_id
            self._next_id += 1
            q: Queue[Any] = Queue(maxsize=1)
            self._pending[req_id] = q
        self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}})
        result = q.get(timeout=timeout)
        if isinstance(result, BaseException):
            raise result
        return result

    def stop(self) -> None:
        self._stop.set()

    def join(self, timeout: float | None = None) -> None:
        if self._reader is not None:
            self._reader.join(timeout=timeout)

    # ----------------------------- internals --------------------------------

    def _send(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload) + "\n"
        with self._write_lock:
            self.out_stream.write(line)
            self.out_stream.flush()

    def _read_loop(self) -> None:
        while not self._stop.is_set():
            line = self.in_stream.readline()
            if not line:
                # EOF: peer closed our stdin. Fail any pending callers.
                for q in list(self._pending.values()):
                    q.put(RpcError(-32000, "peer closed stream"))
                self._pending.clear()
                return
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                sys.stderr.write(f"[gba-rpc] non-JSON line ({e}): {line!r}\n")
                continue
            if "method" in msg and "id" in msg:
                self._dispatch_request(msg)
            elif "method" in msg:
                # notification; ignored for now
                pass
            elif "id" in msg:
                self._dispatch_response(msg)

    def _dispatch_request(self, msg: dict[str, Any]) -> None:
        # Handlers may issue their own RPC calls; run on a worker thread so the
        # reader can keep processing responses.
        worker = threading.Thread(
            target=self._invoke_handler,
            args=(msg,),
            name=f"gba-rpc-h-{msg['id']}",
            daemon=True,
        )
        worker.start()

    def _invoke_handler(self, msg: dict[str, Any]) -> None:
        req_id = msg["id"]
        method = msg["method"]
        params = msg.get("params") or {}
        handler = self._handlers.get(method)
        if handler is None:
            self._send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"unknown method {method}"},
                }
            )
            return
        try:
            result = handler(params)
            self._send({"jsonrpc": "2.0", "id": req_id, "result": result})
        except Exception as exc:  # noqa: BLE001 — surface as RPC error
            self._send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32000, "message": str(exc)},
                }
            )

    def _dispatch_response(self, msg: dict[str, Any]) -> None:
        req_id = msg["id"]
        q = self._pending.pop(req_id, None)
        if q is None:
            return
        if "error" in msg:
            err = msg["error"]
            q.put(RpcError(err.get("code", -32000), err.get("message", "unknown error")))
        else:
            q.put(msg.get("result"))
