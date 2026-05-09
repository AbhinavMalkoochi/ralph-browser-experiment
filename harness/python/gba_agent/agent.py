"""Python Agent base class. Subclass and implement ``run``.

The harness instantiates the agent, then invokes::

    agent.run(goal, browser, budget, trajectory, ctx)

``browser`` / ``budget`` / ``trajectory`` are RPC proxies that route calls
back to the TS harness; ``ctx`` carries per-task identifiers needed to
correlate the trajectory file path.
"""

from __future__ import annotations

from dataclasses import dataclass

from .browser import BrowserProxy
from .budget import Budget
from .trajectory import TrajectoryProxy


@dataclass(frozen=True)
class AgentContext:
    agent_id: str
    task_id: str
    seed: int


class Agent:
    """Base class. Concrete agents must set ``id`` and override ``run``."""

    id: str = "unnamed"

    def run(
        self,
        goal: str,
        browser: BrowserProxy,
        budget: Budget,
        trajectory: TrajectoryProxy,
        ctx: AgentContext,
    ) -> None:
        raise NotImplementedError
