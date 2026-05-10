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

Catch these errors in your `run()` and finish the trajectory accordingly:

- `BudgetExceeded` (from `harness/ts/agent/types.js`) → `terminal_state="BUDGET_EXCEEDED"`.
  Thrown by `budget.check()` when any axis (tokens / usd / wall_seconds / steps)
  is exceeded.
- `SessionTimeoutError` (from `harness/ts/cdp/pool.js`) → `terminal_state="SESSION_TIMEOUT"`.
  Thrown by `BrowserSession` methods when the pool's per-task wall-clock
  deadline fires; the underlying Chrome has been SIGKILLed and any further
  CDP calls will fail. Don't try to recover — finish and exit.
- Anything else → `terminal_state="ERROR"` with the message as `decline_reason`.

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

### LLM access (US-004)

Both TS and Python agents call models through the harness's `LLMClient`,
never the provider SDKs directly. The client handles multi-provider
routing (OpenAI `gpt-*`/`o4-*`/`o3-*`, Gemini `gemini-*`), cost accounting,
record-or-replay caching, budget enforcement, and secret redaction.

```ts
// TS
import { defaultClient } from "../../harness/ts/llm/index.js";
const llm = defaultClient({ budget, trajectory, paradigmSeed: this.id });
const r = await llm.call("gpt-4o-mini", [{ role: "user", content: goal }]);
```

```python
# Python
from gba_agent import LLMClient
llm = LLMClient(rpc)  # TODO: TrajectoryProxy will hand this in once US-013 lands
r = llm.call("gpt-4o-mini", [{"role": "user", "content": goal}])
```

Calls to `llm.call()` may throw `BudgetExceeded` (over-budget pre-check) or
`LLMReplayMissError` (replay mode + cache miss). Treat both like any other
budget breach: finish the trajectory with the right `terminal_state`.

### Verifiers (US-005)

Agents do NOT run task verifiers themselves; the harness does, after `run()`
returns. But agents may call `trajectory.recordVerification(record)` mid-run
to log interim self-checks (the JSONL line kind is `verification`). On
`finish()`, if no explicit `verifier_verdict` is passed and verifications
were recorded, the latest one is folded into `metadata.verifier_verdict`.

Tasks ship YAML specs under `tasks/suite/<slice>/`. The verifier framework
lives at `harness/ts/verifier/`:

```ts
import { loadTaskFile, verify } from "../../harness/ts/verifier/index.js";

const task = await loadTaskFile(taskPath);
const verdict = await verify(task, { browser, trajectory, llm });
// verdict: {pass: boolean, score: 0..1, reason: string}
```

Three verifier kinds, validated at task load:
- `js` — expression run in the page (CDP Runtime.evaluate, awaitPromise=true)
- `trajectory_predicate` — JS expression run in Node against
  `{steps, llmCalls, metadata}` snapshots
- `llm_judge` — temperature=0, n=3 majority vote; only allowed when the task
  is tagged `judge_required`

`verify()` writes `verdict.json` next to `trajectory.jsonl.gz` for a
gzip-free audit trail, and appends a `verification` line to the open
trajectory.

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

Every run lands at `runs/<agent_id>/<task_id>/<seed>/`:

- `trajectory.jsonl.gz` — the gzipped JSONL trajectory.
- `verdict.json` — the verifier's verdict (US-005 sidecar).
- `summary.json` — the tournament runner's per-cell metrics + done-marker
  (US-010). Presence means the cell is complete; the resumable
  tournament runner skips any cell whose `summary.json` exists. Do NOT
  write or rename this file from inside an agent — the harness owns it.
