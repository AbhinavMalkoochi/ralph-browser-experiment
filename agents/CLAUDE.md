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
- `baseline-a11y-react/` — US-013 honest control. A11y snapshot via
  Runtime.evaluate (with stable `data-gba-aid` integer ids) + ReAct
  loop + JSON action set (click / type / scroll / wait / navigate /
  extract / finish). Default model is `gpt-4o-mini`; replays cleanly
  via the LLMClient cache. AGENT_ALIASES.baseline points here. Every
  novel agent (US-014..U-021) declares distinctness from this one.

## Novel agents

- `plan-then-execute/` — US-014, first novel slot. Batch planning
  over intent-keyed (visible-text) selectors. ONE LLM call emits the
  whole plan as a JSON array; the executor in `script.ts` resolves
  text → element inside the page. A bounded repair loop (up to
  `maxRepairs=2`) re-asks the LLM for a remaining-plan on hard_fail.
  Plan content is recorded as a trajectory step with
  `action.type='plan'` and `phase='initial' | 'repair'`. Live eval:
  21/22 easy, 2/10 hard with gpt-4o-mini.
- `runtime-codegen/` — US-015, second novel slot. **No action
  vocabulary**: each turn the LLM emits the body of an async JS
  function that the harness runs in-page via `Runtime.evaluate`. The
  body returns `{done?, message, navigate?, sleep_ms?}` and the agent
  loops. Distinct from prior slots because the LLM authors the action
  as *code* — direct access to shadow DOM, iframe.contentDocument,
  synthetic MouseEvent dispatch, fetch(), postMessage. In-page
  exceptions are caught inside the IIFE and surfaced as the next
  observation, giving a one-turn self-correcting retry path. Live
  eval: 21/22 easy, **5/10 hard** with gpt-4o-mini (shadow-form,
  virtual-scroll, modal-stack, late-hydration, recoverable).
- `speculative-rollback/` — US-016, third novel slot. Every action is
  a SPECULATIVE TRIAL. Per step: capture client-side state (URL +
  localStorage + sessionStorage via Runtime.evaluate) → PROPOSER LLM
  emits K=2 CSS-selector candidates → execute the top one → re-observe
  → JUDGE LLM (separate temperature=0 call, sees before/after digests
  + the action's canonical label) classifies as commit/revert/done →
  on revert, restoreState navigates back + rewrites storage, the
  action label joins a per-state blacklist, the next candidate is
  tried. **Distinct on the LOOP axis**: prior slots never abandon a
  misstep; this one explicitly snapshots a state, decides post-hoc
  whether to keep the change, and reverts when the judge disagrees.
  Action substrate is CSS selectors emitted by the LLM (different
  from baseline's aids and plan-then-execute's text). Restoration is
  best-effort: server-side mutations are not undone, HttpOnly cookies
  out of scope. Live eval: **22/22 easy** (beats both prior novel
  slots by 1), 1/10 hard (recoverable — exactly where the judge
  shines). The 9 hard failures are substrate-bound (shadow/canvas/
  iframe/popup/PDF), not loop-bound — documented in README.
- `predicate-driven/` — US-017, fourth novel slot. The LLM authors a
  JS PREDICATE upfront (one synthesis call); the agent loop polls the
  predicate in-page after every action and **terminates from CODE the
  moment the predicate returns true**. The action LLM has NO `finish`
  action — `actions.parseAction` explicitly rejects `{type:"finish"}`
  with a message about the agent's invariant. **Distinct on the
  TERMINATION axis**: every prior agent gives the LLM the final word
  (baseline `finish`, plan-then-execute end-of-plan, runtime-codegen
  body.done, srb judge done); this one inverts that. The predicate is
  the agent's OWN probe (separate from the harness verifier in
  `harness/ts/verifier/`); they may even disagree, which costs the
  agent steps but never leaks signal into scoring. Synthesis prompt
  asks for evidence-based predicates and warns against being true at
  start. The wrapped form is `(async () => { try { return Boolean(<expr>);
  } catch (e) { return { __predicate_error: ... }; } })()` so syntax
  errors fall out of evaluate() (parse fails before try) and runtime
  errors come back as a typed object — `evaluatePredicate` normalises
  both into `{satisfied: bool, error?: string}`. Action substrate is
  CSS selectors (same shape as srb), so capability on substrate-bound
  fixtures (canvas/popup/PDF) is unchanged from prior agents — the
  win zone is fixtures with TRANSIENT failure modes (recoverable,
  late-hydration, conditional-form) where the predicate keeps the
  agent honest about whether the page actually reached the goal state.

## Distinctness (US-012, enforced)

`manifest.distinct_from` lists agent ids this agent claims a distinct
mechanism from. Auto-discovery (`harness/ts/tournament/discovery.ts`)
runs a post-pass that computes the Jaccard overlap between this agent's
`approach_keywords` and the target agent's `approach_keywords`; if the
overlap exceeds 0.5 the violator is dropped from the discovery result
and a `distinctness violation:` warning is emitted. Pass
`enforceDistinctness: false` to opt out (e.g. tooling that wants to
surface violations itself rather than filter them).

Practical guidance:
- The check is symmetric (Jaccard) so order of `approach_keywords`
  does not matter; comparison is case-insensitive.
- Keywords like `trivial` / `reference` (the test agents share these)
  are fine because each test agent's `distinct_from` is `[]` — only a
  declared claim is validated.
- A new agent should pick keywords that *describe its mechanism*
  (e.g. `event_bus`, `code_gen`, `world_model`), not generic labels
  every agent might use, so legitimate distinctness claims survive.

## Contract test (US-012)

`harness/ts/tournament/contract.ts` exposes `runContractTest({agents,
runsRoot, browserFactory?})` which runs each agent on a 1-task dry
slice (default: a tiny data: URL) and checks that the agent returns
a finished Trajectory whose `metadata.agent_id` matches the manifest
and whose `terminal_state` is set. Failures are captured per-agent and
do NOT abort the loop, so one broken agent cannot mask others. The
test is wired into `harness/ts/tests/tournament_contract.test.ts` and
runs against the live agents under `agents/` on every `make test`.

The contract test uses **duck typing** (looking for `metadata` /
`isFinished` fields), not `instanceof Trajectory`, because tsx may
load an agent file dynamically against a different module URL than
the harness's static import — `instanceof` would give false negatives
across that boundary.

## Trajectory output layout

Every run lands at `runs/<agent_id>/<task_id>/<seed>/`:

- `trajectory.jsonl.gz` — the gzipped JSONL trajectory.
- `verdict.json` — the verifier's verdict (US-005 sidecar).
- `summary.json` — the tournament runner's per-cell metrics + done-marker
  (US-010). Presence means the cell is complete; the resumable
  tournament runner skips any cell whose `summary.json` exists. Do NOT
  write or rename this file from inside an agent — the harness owns it.
