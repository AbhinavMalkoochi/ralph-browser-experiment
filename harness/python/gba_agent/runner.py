"""Stdio runner: TS spawns ``python -m gba_agent.runner --agent <path>``.

We import the user agent module from <path>, find the Agent subclass, and
expose ``agent.run`` as the single inbound RPC method. After the agent
finishes the runner blocks until stdin is closed by the TS side, so the TS
side controls process lifetime.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
import threading
from pathlib import Path
from typing import Any

from .agent import Agent, AgentContext
from .browser import BrowserProxy
from .budget import Budget
from .rpc import StdioJsonRpc
from .trajectory import TrajectoryProxy


def load_agent_class(path: Path) -> type[Agent]:
    if not path.exists():
        raise FileNotFoundError(f"agent path does not exist: {path}")
    spec = importlib.util.spec_from_file_location("user_agent", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load agent from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    explicit = getattr(module, "AGENT_CLASS", None)
    if isinstance(explicit, type) and issubclass(explicit, Agent):
        return explicit

    candidates: list[type[Agent]] = []
    for attr in dir(module):
        value = getattr(module, attr)
        if isinstance(value, type) and issubclass(value, Agent) and value is not Agent:
            candidates.append(value)
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise RuntimeError(f"no Agent subclass found in {path}")
    raise RuntimeError(
        f"multiple Agent subclasses in {path}: {[c.__name__ for c in candidates]}; "
        "set AGENT_CLASS = <one> to disambiguate"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gba_agent.runner")
    parser.add_argument("--agent", required=True, help="path to user agent module (.py)")
    args = parser.parse_args(argv)

    agent_cls = load_agent_class(Path(args.agent).resolve())
    rpc = StdioJsonRpc()
    done = threading.Event()

    def handle_run(params: dict[str, Any]) -> dict[str, Any]:
        try:
            agent = agent_cls()
            ctx = AgentContext(
                agent_id=str(params.get("agent_id", agent.id)),
                task_id=str(params["task_id"]),
                seed=int(params["seed"]),
            )
            browser = BrowserProxy(rpc)
            budget = Budget(rpc)
            trajectory = TrajectoryProxy(rpc)
            agent.run(str(params["goal"]), browser, budget, trajectory, ctx)
            return {"ok": True}
        except Exception as exc:  # noqa: BLE001 — surface to TS
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    rpc.register("agent.run", handle_run)
    rpc.start()

    # Block until TS closes our stdin (reader returns) or we're told to stop.
    rpc.join()
    done.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
