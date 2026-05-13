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

## STEERING (2026-05-10) — read before picking a new agent slot

Two existing mechanisms are **deprioritized**. Keep their trajectories as
data, but DO NOT clone or extend their core mechanism in any future agent
slot — the user has explicitly steered away from them:

- **vision-grounded** (0/10 hard). Pure pixel-coord vision without overlay
  augmentation is a known structural failure of un-augmented chat models.
  Successor is **US-031** (vision + Set-of-Marks). Do not ship another
  raw-pixel-coordinate agent.
- **speculative-rollback** (1/10 hard, 2× LLM cost per step). The
  proposer/judge double-call inflates cost without expanding the capability
  frontier. Successor is **US-032** (codegen × predicate-driven
  composition: free-form action substrate + code-decided termination, one
  LLM call per step). Do not ship another generic "did that help?" judge
  loop.

Also do NOT build:

- Another raw-JS-bodied agent (runtime-codegen owns that substrate; new
  agents must pick a different action primitive).
- Another single-LLM single-shot planner whose only novelty is the prompt
  template — the mechanism axis must move.

Preferred directions for the remaining open agent slots
(US-031/US-032/US-033/US-021):

1. **DOM-as-filesystem** (US-033): tiny shell-style command vocabulary
   compiled to `Runtime.evaluate`, persistent cwd selector chain,
   shell-flavoured ls/cd/cat/grep/find + click/type. Distinct from
   runtime-codegen (unbounded JS) AND from baseline (named JSON actions).
2. **Set-of-Marks vision** (US-031): numbered DOM-derived overlays → LLM
   picks integer mark id → harness translates to CDP click on the stable
   element id behind the mark.
3. **Composed mechanisms where the composition itself is the novelty**
   (US-032 is the canonical example): runtime-codegen action × predicate
   termination, network-shadow observation × baseline actions, vision-SoM
   perception × runtime-codegen action.
4. **Skill crystallisation / Voyager-for-the-web**: agent records
   successful trajectories as named skills and retrieves them on similar
   tasks. No agent has any persistent learning today.
5. **Filesystem-as-working-memory**: real on-disk scratch
   (notes.md / plan.md / observations/) survives across steps so context
   doesn't grow linearly.

The full directive lives in `prd.json` → `steeringNotes`. Re-read it each
iteration before opening a new slot.

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
- `vision-grounded/` — US-018, fifth novel slot. **Pure-pixel
  perception with absolute-coordinate action dispatch.** The LLM sees
  ONLY a JPEG screenshot of the viewport plus a small text banner
  (URL, title, viewport size) — no DOM walk, no a11y tree, no element
  list, no Set-of-Marks overlay. It emits actions keyed by absolute
  `(x, y)` viewport pixel coordinates. Actions are dispatched at the
  OS event layer via Chrome DevTools Protocol `Input.*` commands
  (`Input.dispatchMouseEvent` for clicks/moves/drag/wheel,
  `Input.dispatchKeyEvent` for special keys, `Input.insertText` for
  typing). **Distinct on TWO axes** from every prior slot: observation
  modality (pixels vs DOM/a11y/text) AND action substrate (CDP Input
  events vs DOM selectors / aids / in-page JS). Live results
  (gpt-4o-mini, detail=high, 200ms post-action settle): 20/22 easy,
  0/10 hard. The hard-slice 0/10 is the documented-failure-analysis
  branch of AC #4: gpt-4o-mini (and gpt-4o) systematically
  centre-bias x-coordinates and mis-click small targets — a known
  limitation of un-augmented vision LLMs that public-framework agents
  (WebVoyager etc.) work around with Set-of-Marks overlays. The
  README has the full empirical analysis. Required harness changes:
  `LLMMessage.content` extended to `string | LLMContentPart[]` for
  multimodal payloads, OpenAI provider gained 429-with-backoff retry
  (defaults to 5 attempts, parses "try again in Xms" hints).
- `network-shadow/` — US-019, sixth novel slot. **API-first browser
  agent.** A fetch + XMLHttpRequest monkey-patch is installed at run
  start via BOTH `Page.addScriptToEvaluateOnNewDocument` (covers
  future docs/popups) and `Runtime.evaluate` (covers the already-
  loaded doc since the harness navigates to `start_url` before
  `agent.run()`). Every page-issued and agent-issued request lands
  on `window.__gba_net_log` (cap 60 entries, ~600-char body sample).
  Each step the LLM sees a 12-entry tail alongside a minimal page
  summary and emits one of: `fetch(method, url, body?,
  content_type?)` (executed in-page so cookies+origin are preserved),
  `click(selector)` (UI fallback to make the page reveal its own
  endpoints), `navigate(url)`, `wait(ms)`, `done(reason)`,
  `decline(reason)`. **Distinct on TWO axes** from every prior slot:
  observation modality (network traffic vs DOM/a11y/pixels) AND
  action substrate (HTTP requests vs aids/text/CSS-selectors/raw-JS/
  pixel-coords). Live eval (gpt-4o-mini, temperature=0): 21/22 easy
  in 141.8s, **3/10 hard** in 88.0s (shadow-form, recoverable,
  modal-stack) — the shadow-form win is the canonical API-first
  result: the agent POSTed JSON directly to `/__shadow/submit`
  without ever traversing the shadow DOM. Patch idempotency is
  load-bearing: a window-level `__gba_net_installed` flag
  short-circuits double-installs; without it, a second install
  wraps the wrapped fetch and logs every request twice.
- `dom-mutation-stream/` — US-020, seventh novel slot. **Delta-first
  observation.** A MutationObserver is installed via BOTH
  Page.addScriptToEvaluateOnNewDocument and Runtime.evaluate; every
  childList / attribute / characterData mutation lands on
  window.__gba_dom_log with a strictly-monotonic `seq`. Each step
  the LLM sees a tail of recent mutations (most recent 24) alongside
  a minimal aid-keyed snapshot, then emits one of: click(aid),
  type(aid, text, submit?), scroll(direction, pixels?), wait(ms),
  await_change(timeout_ms), navigate(url), done(reason),
  decline(reason). After every state-changing action the harness
  calls settleAfter() which BLOCKS in-page until the mutation log
  grows then quiesces (cap 400ms) — the LLM only ever observes a
  SETTLED post-action state. The `await_change` action is a novel
  primitive: a first-class "block until the page moves" timer the
  LLM can dial up when it expects a slow reaction (hydration, network
  round-trip, animation). **Distinct on TWO axes**: observation
  modality (DOM deltas vs DOM/a11y states, network, pixels) AND
  cadence primitive (document-driven `await_change` vs wall-clock
  `wait`). approach_keywords = [mutation_observer, dom_event_stream,
  delta_observation, change_driven_loop, await_dom_change,
  transition_aware]; Jaccard=0 with every prior agent's keywords
  (tested explicitly in the manifest distinctness test). Composition
  reuses the install pattern from network-shadow and the aid-keyed
  substrate from baseline — the COMPOSITION is novel because the
  signal axis (deltas, not states) plus the cadence primitive
  (await_change) together yield a mechanism no prior agent has.
  Live eval (gpt-4o-mini, temperature=0): **22/22 easy** in 176.4s,
  2/10 hard in 218.8s (modal-stack via clean FSM advance with
  mutation_delta>0 on each step; recoverable via the cell-retry
  semantics). Above both AC thresholds.
- `vision-som/` — US-031, eighth novel slot. **Set-of-Marks vision**:
  successor to vision-grounded with the WebVoyager / SeeAct / Operator
  fix for un-augmented chat-LLM pixel-grounding failure. Per step the
  harness walks the page, finds visible interactive elements whose
  bounding box intersects the viewport, stamps each with
  `data-gba-som-id="<N>"`, and overlays a numbered red rectangle on
  the live DOM before capturing a JPEG (overlay is then torn down).
  The LLM sees the annotated screenshot AND a small text mark table
  (`[N] role "name" bbox=x,y,wxh`) and picks ONE mark id + one action
  verb (`click(mark)`, `type(mark, text, submit?)`, `scroll`, `wait`,
  `navigate`, `done`, `decline`). The harness translates "click mark
  7" to a CDP `Input.dispatchMouseEvent` at the centre of mark 7's
  recomputed bounding box. **The LLM never emits raw pixel coordinates
  — only a mark id.** Distinct from vision-grounded on the localisation
  primitive: the failure mode that bottomed vision-grounded at 0/10
  hard (gpt-4o-mini centre-biases its x estimates) is removed by
  integer indirection through the DOM. approach_keywords =
  [set_of_marks, numbered_overlays, mark_id_actions,
  dom_anchored_vision, bbox_grounding, multimodal_with_marks];
  Jaccard=0 vs every prior agent. Fresh ids each step (NOT reused
  across steps the way baseline-aids are) so the LLM cannot pick a
  stale id from the prior screenshot. Live eval pending API keys;
  mechanism + harness covered by 29 unit/e2e tests.
- `fs-memory/` — US-021, twelfth novel slot. **Filesystem-as-working-
  memory.** The prompt is constant-shape (goal + page banner + scratch
  tree + last action result), and the LLM curates ALL observation
  history by writing/reading files in a per-task scratch directory at
  `<trajectoryDir>/scratch/`. There is NO rolling action history in
  the prompt — observations the LLM wants to remember past one turn
  MUST be persisted to disk via `fs.write` / `fs.append` and re-read
  via `fs.read`. Action vocabulary: filesystem ops (fs.write / append
  / read / list / delete) scoped to scratch root with path-traversal
  rejected by `ScratchFs.resolve()`, browser ops (observe / click /
  type / navigate / scroll / wait), terminate (done / decline).
  **Distinct on the OBSERVATION-STORAGE axis** from every prior agent
  — every other agent stores rolling history in the prompt context
  window, this one externalises it to disk. Ralph-original per the
  steering note's `preferredDirections` #5
  ("Filesystem-as-working-memory"). approach_keywords =
  [filesystem_working_memory, on_disk_scratchpad,
  externalised_observations, agent_curated_notes, constant_shape_prompt,
  persistent_per_task_workspace, fs_action_substrate]; Jaccard=0 vs
  every prior agent (asserted). Live eval deferred (no API keys in
  this env); mechanism covered by 25 tests including a property test
  that asserts each LLM request's user message contains at most ONE
  "--- last action output ---" block.
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
