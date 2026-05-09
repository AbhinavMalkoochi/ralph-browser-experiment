"""gba_agent: Python side of the cross-language Agent contract.

A Python agent subclasses ``Agent`` and is launched by the TS harness via
``python -m gba_agent.runner --agent <path>``. The runner exchanges JSON-RPC
2.0 messages over stdio with the harness; ``BrowserProxy`` / ``Budget`` /
``TrajectoryProxy`` are thin client objects that turn agent calls into RPC
requests.
"""

from .agent import Agent, AgentContext
from .browser import BrowserProxy
from .budget import Budget, BudgetExceeded
from .trajectory import TrajectoryProxy

__all__ = [
    "Agent",
    "AgentContext",
    "BrowserProxy",
    "Budget",
    "BudgetExceeded",
    "TrajectoryProxy",
]
