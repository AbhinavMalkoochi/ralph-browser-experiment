"""Trivial reference agent (Python). Sibling of agents/click-first-link/.

Demonstrates the cross-language Agent contract end-to-end: every call into
``browser`` / ``budget`` / ``trajectory`` becomes a JSON-RPC request back to
the TS harness.
"""

from __future__ import annotations

import time

from gba_agent import Agent, AgentContext, BrowserProxy, Budget, TrajectoryProxy
from gba_agent.budget import BudgetExceeded


class ClickFirstLinkAgent(Agent):
    id = "click-first-link-py"

    def run(
        self,
        goal: str,
        browser: BrowserProxy,
        budget: Budget,
        trajectory: TrajectoryProxy,
        ctx: AgentContext,
    ) -> None:
        try:
            t0 = time.monotonic()
            links = browser.evaluate(
                "Array.from(document.querySelectorAll('a')).map(a => a.href).filter(Boolean)"
            )
            if not isinstance(links, list):
                links = []
            budget.record_step()
            budget.check()

            observe = f"goal={goal[:80]} | found {len(links)} link(s)"

            if not links:
                trajectory.add_step(
                    step=1,
                    observation_summary=observe,
                    action={"type": "noop", "reason": "no links on page"},
                    latency_ms=(time.monotonic() - t0) * 1000,
                )
                trajectory.finish("DECLINED", decline_reason="no links on page")
                return

            target = links[0]
            t1 = time.monotonic()
            browser.evaluate(f"window.location.href = {_js_string(target)}")
            budget.record_step()
            budget.check()

            trajectory.add_step(
                step=1,
                observation_summary=observe,
                action={"type": "click_link", "href": target},
                latency_ms=(time.monotonic() - t1) * 1000,
            )
            trajectory.finish("DONE")
        except BudgetExceeded as e:
            trajectory.finish("BUDGET_EXCEEDED", decline_reason=str(e))
        except Exception as e:  # noqa: BLE001
            trajectory.finish("ERROR", decline_reason=f"{type(e).__name__}: {e}")


def _js_string(value: str) -> str:
    import json

    return json.dumps(value)


AGENT_CLASS = ClickFirstLinkAgent
