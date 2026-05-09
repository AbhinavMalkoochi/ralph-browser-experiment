"""Runner test: load_agent_class on the trivial agent file finds the class."""

from __future__ import annotations

from pathlib import Path

from gba_agent.agent import Agent
from gba_agent.runner import load_agent_class

REPO = Path(__file__).resolve().parents[3]


def test_load_agent_class_finds_trivial_py():
    cls = load_agent_class(REPO / "agents" / "click-first-link-py" / "agent.py")
    assert issubclass(cls, Agent)
    assert cls.id == "click-first-link-py"
