# Agents directory

Each subdirectory is one self-contained agent. The harness auto-discovers
agents on tournament start (US-012); no central registry edit is needed.

## Contract

A new agent under `agents/<id>/` MUST contain:

- `agent.ts` (TypeScript) **or** `agent.py` (Python).
- `manifest.yaml` with keys `{id, language, summary, approach_keywords, distinct_from}`.
- `README.md` describing the approach in 200–500 words.

### TypeScript agents

Default-export a class extending `Agent` from `harness/ts/agent/agent.ts`:

```ts
import { Agent, type AgentContext } from "../../harness/ts/agent/agent.js";
import { Trajectory } from "../../harness/ts/agent/trajectory.js";
import type { BrowserSession, Budget } from "../../harness/ts/agent/types.js";

export default class MyAgent extends Agent {
  readonly id = "my-agent";
  async run(goal, browser, budget, ctx): Promise<Trajectory> { ... }
}
```

The agent owns the `Trajectory`: open it with
`Trajectory.open({runsRoot: ctx.runs_root, agent: this.id, task: ctx.task_id, seed: ctx.seed}, {agent_id, task_id, seed})`,
append steps with `addStep`, finish with `finish({terminal_state, ...})`.
Handle `BudgetExceeded` thrown by `budget.check()` and finish the trajectory
with `terminal_state="BUDGET_EXCEEDED"` so the harness records it correctly.

### Python agents

Subclass `gba_agent.Agent` and (optionally) export `AGENT_CLASS = MyAgent` to
disambiguate when multiple subclasses exist:

```python
from gba_agent import Agent, AgentContext, BrowserProxy, Budget, TrajectoryProxy

class MyAgent(Agent):
    id = "my-agent"
    def run(self, goal, browser, budget, trajectory, ctx): ...

AGENT_CLASS = MyAgent
```

Trajectory ownership stays on the TS side; Python agents emit step/finish
RPCs via the `TrajectoryProxy`.

## Reference agents

- `click-first-link/` — TS reference. Contract demo, not a tournament entry.
- `click-first-link-py/` — Python sibling. Exercises the cross-language
  bridge end-to-end.

## Distinctness (US-012, not yet enforced)

`manifest.distinct_from` lists agent ids this agent claims a distinct
mechanism from. The auto-discovery contract test will reject a new agent
whose `approach_keywords` overlap >50% with any agent it claims to be
distinct from.

## Trajectory output layout

Every run lands at `runs/<agent_id>/<task_id>/<seed>/trajectory.jsonl.gz`.
Presence of the `.gz` file is the resumable-runner's done-marker (US-010);
do not touch the `.gz` after `finish()` returns.
