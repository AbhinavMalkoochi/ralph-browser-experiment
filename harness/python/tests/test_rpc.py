"""StdioJsonRpc round-trip test using a pair of in-process pipes.

Two ``StdioJsonRpc`` instances are wired so peer A's stdout is peer B's stdin
and vice versa. Then we issue calls in both directions and assert the
responses match.
"""

from __future__ import annotations

import os
import threading
import time

from gba_agent.rpc import RpcError, StdioJsonRpc


def _pipe_streams() -> tuple:
    r_fd, w_fd = os.pipe()
    return os.fdopen(r_fd, "r", buffering=1), os.fdopen(w_fd, "w", buffering=1)


def test_bidirectional_call_round_trip():
    a_in, b_out = _pipe_streams()  # b writes -> a reads
    b_in, a_out = _pipe_streams()  # a writes -> b reads

    peer_a = StdioJsonRpc(in_stream=a_in, out_stream=a_out)
    peer_b = StdioJsonRpc(in_stream=b_in, out_stream=b_out)

    peer_a.register("a.echo", lambda p: {"echoed": p["msg"]})
    peer_b.register("b.add", lambda p: p["x"] + p["y"])

    peer_a.start()
    peer_b.start()

    # B calls into A.
    result = peer_b.call("a.echo", {"msg": "hi"}, timeout=5)
    assert result == {"echoed": "hi"}

    # A calls into B.
    result = peer_a.call("b.add", {"x": 2, "y": 40}, timeout=5)
    assert result == 42

    # Unknown method surfaces RpcError.
    try:
        peer_a.call("b.does_not_exist", {}, timeout=5)
    except RpcError as e:
        assert e.code == -32601
    else:
        raise AssertionError("expected RpcError for unknown method")

    # Clean up: closing a writer stream causes the peer's reader to see EOF.
    a_out.close()
    b_out.close()
    peer_a.join(timeout=2)
    peer_b.join(timeout=2)


def test_handler_can_call_back_during_request():
    """Inbound handlers run on a worker thread so they may issue their own
    RPC calls without deadlocking the reader."""
    a_in, b_out = _pipe_streams()
    b_in, a_out = _pipe_streams()
    peer_a = StdioJsonRpc(in_stream=a_in, out_stream=a_out)
    peer_b = StdioJsonRpc(in_stream=b_in, out_stream=b_out)

    # B's handler calls back into A while still inside its own handler invocation.
    def b_handler(_params):
        return peer_b.call("a.value", {}, timeout=5)

    peer_a.register("a.value", lambda _p: "from-a")
    peer_b.register("b.callback", b_handler)
    peer_a.start()
    peer_b.start()

    result = peer_a.call("b.callback", {}, timeout=5)
    assert result == "from-a"

    a_out.close()
    b_out.close()
    peer_a.join(timeout=2)
    peer_b.join(timeout=2)
