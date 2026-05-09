# click-first-link-py (Python reference agent)

Same logic as the TypeScript `click-first-link` agent, but written in Python
to demonstrate the cross-language Agent contract. The TS harness spawns this
process via `python -m gba_agent.runner --agent agents/click-first-link-py/agent.py`
and exchanges JSON-RPC over stdio.

## How it talks to the harness

| Direction | Method | Purpose |
|-----------|--------|---------|
| TS → Py   | `agent.run` | start the agent with `{goal, task_id, seed, agent_id, budget_limits}` |
| Py → TS   | `browser.evaluate` / `browser.navigate` / `browser.screenshot` | inspect/manipulate the page |
| Py → TS   | `budget.record_step` / `budget.record_tokens` / `budget.check` | budget accounting |
| Py → TS   | `trajectory.add_step` / `trajectory.finish` | record one JSONL step / close the trajectory |

The trajectory file lives only on the TS side; this agent never touches the
filesystem.
