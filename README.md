# General Browser Agent (GBA)

Tournament harness comparing complete end-to-end browser agents under self-invented
approaches, evaluated on a deliberately hard browser-task suite. The full research
PRD lives at [`tasks/prd-general-browser-agent.md`](tasks/prd-general-browser-agent.md).

## What this is

GBA hosts many *complete* browser agents in one harness. Each agent owns its own
end-to-end strategy (perception, planning, action, recovery). The harness:

- runs every agent against the same task suite under fixed budgets (tokens, $, wall, steps),
- records per-step trajectories (observation summary, action, latency, cost, screenshot),
- declares a champion via single-elimination tournament,
- emits a markdown leaderboard so results are reproducible without running the harness.

## Repository layout

```
general-browser/
├── Makefile                 # install / smoke / eval / tournament / report
├── package.json             # TS workspace; node 24 + tsx
├── pyproject.toml           # Python 3.13 via uv
├── tsconfig.json
├── harness/
│   ├── ts/                  # CDP core, tournament runner, CLIs (TypeScript)
│   └── python/              # Python adapters (cross-language agents)
├── agents/                  # one directory per complete agent (auto-discovered)
├── tasks/
│   ├── prd-general-browser-agent.md
│   ├── fixtures/            # local hostile fixture pages (US-006..US-008)
│   └── suite/{easy,hard}/   # YAML task specs
├── runs/                    # trajectories, screenshots, leaderboard.json (gitignored)
├── docs/                    # leaderboard.md, results.md, etc.
└── scripts/ralph/           # Ralph loop driver + prd.json
```

## Agent slot convention

Drop a new complete agent under `agents/<unique-id>/`. It must contain:

- `agent.ts` (or `agent.py`) exporting a default `Agent` subclass.
- `manifest.yaml` with `{id, language, summary, approach_keywords, distinct_from}`.
- `README.md` describing the approach in 200–500 words.

The harness auto-discovers agents on tournament start. No central registry edit
is needed. `manifest.distinct_from` enforces that a new agent's
`approach_keywords` do not overlap >50% with any agent it claims to be distinct
from. See US-012 for the discovery contract.

## Quickstart

```bash
cp .env.example .env          # fill in OPENAI_API_KEY and/or GEMINI_API_KEY
make install                  # npm + uv
make smoke                    # boots Chrome via CDP, exits 0 on success
```

Once agents and tasks are wired up:

```bash
make eval AGENT=baseline-a11y-react SLICE=easy SEEDS=1
make tournament SLICE=hard SEEDS=3
make report                   # writes docs/leaderboard.md from runs/leaderboard.json
```

## How the smoke test works

`make smoke` (`harness/ts/smoke.ts`) launches headless Chrome with
`--remote-debugging-port`, fetches `/json/version` over HTTP, opens a CDP
WebSocket against the target page, navigates to `about:blank`, then exits 0.
On exit it kills the Chrome process and removes the temp `--user-data-dir` so
no orphan processes or profile dirs are left behind.

## Agent contract (US-002)

A complete agent implements one method:

```ts
class MyAgent extends Agent {
  readonly id = "my-agent";
  async run(goal: string, browser: BrowserSession, budget: Budget, ctx: AgentContext): Promise<Trajectory> { ... }
}
```

The harness hands the agent a per-task `BrowserSession` (CDP wrapper), a
`Budget` enforcing tokens/$/wall/steps, and an `AgentContext` carrying
`{task_id, seed, runs_root}`. The agent constructs a `Trajectory` via
`Trajectory.open(...)`, appends one `TrajectoryStep` per action, and ends
with `trajectory.finish({terminal_state, verifier_verdict?, decline_reason?})`.
Trajectories are written as JSONL to
`runs/<agent>/<task>/<seed>/trajectory.jsonl` and gzipped to
`trajectory.jsonl.gz` on completion. The presence of the `.gz` file is the
done-marker the resumable tournament runner (US-010) uses.

Cross-language agents are supported via the `gba_agent` Python package and
`PythonAgentBridge`: the harness spawns
`python -m gba_agent.runner --agent <path>` and proxies browser/budget/
trajectory calls over line-delimited JSON-RPC 2.0 on stdio. See
`agents/click-first-link-py/` for the reference Python agent.

## Browser pool (US-003)

`harness/ts/cdp/pool.ts` exposes `BrowserPool` — N parallel Chrome processes,
each with its own `--user-data-dir` for true profile isolation (cookies,
localStorage, IndexedDB, service workers, HTTP cache). Pool size defaults to
4, overridable via `GBA_POOL_SIZE` or `BrowserPool.create({size})`.

```ts
import { BrowserPool } from "./harness/ts/cdp/pool.js";
const pool = await BrowserPool.create({ size: 4, defaultTaskTimeoutMs: 60_000 });
try {
  await pool.withSession(
    async (session) => {
      await session.navigate("https://example.com");
      const snap = await session.snapshot();              // URL + cookies + storage
      // ... agent does work ...
      await session.restore(snap);                         // rollback
    },
    { taskTimeoutMs: 30_000 },
  );
} finally {
  await pool.close();
}
```

- Each `acquire()`/`release(session)` cycle destroys the slot's Chrome and
  spawns a fresh one. Isolation is the contract; ~1s spawn cost per task is
  the price.
- `pool.withSession(fn, {taskTimeoutMs})` enforces a wall-clock deadline. On
  expiry the session is `SIGKILL`ed and the inflight call rejects with
  `SessionTimeoutError`; agents map that to `terminal_state="SESSION_TIMEOUT"`.
- The pool is crash-only: a wedged Chrome (renderer hang, OOM, external
  `kill`) is detected via the process exit event and the slot is replaced
  without taking the harness down.
- Snapshots capture URL + cookies (via `Network.getAllCookies`) +
  local/sessionStorage. Pass `{includeMhtml:true}` for an audit DOM payload
  (`Page.captureSnapshot`); MHTML is *not* replayed by `restore()` — restore
  reconstitutes state, not arbitrary DOM.
- Chrome is spawned `detached:true` and killed via process group so renderer /
  GPU / network subprocesses die before we `rm -rf` the profile dir.

## Per-task budgets

| Slice  | tokens | $    | wall_s | steps |
|--------|--------|------|--------|-------|
| easy   |   50k  | 0.20 |   60   |  15   |
| medium |  200k  | 1.00 |  240   |  40   |
| hard   |  600k  | 3.00 |  600   |  80   |

Budgets are enforced by `LLMClient` (US-004) and the tournament runner (US-010).
A run that exceeds any axis is recorded as `BUDGET_EXCEEDED`.

## LLMClient (US-004)

`harness/ts/llm/` is the unified shim every agent uses to call models.

```ts
import { defaultClient } from "../../harness/ts/llm/index.js";

const llm = defaultClient({ budget, trajectory, paradigmSeed: "react-v1" });
const r = await llm.call("gpt-4o-mini", [
  { role: "system", content: "you are an agent" },
  { role: "user", content: goal },
]);
```

- **Multi-provider**: `gpt-*` / `o4-*` / `o3-*` route to OpenAI Chat Completions;
  `gemini-*` routes to Gemini `generateContent`. Anthropic is left to whichever
  agent opts in.
- **Cost accounting**: token counts are multiplied by `harness/ts/llm/pricing.ts`
  list prices and recorded into the active `Budget` and `Trajectory`.
- **Cache**: every call's `(model, messages, opts, paradigm_seed)` is sha256'd
  and persisted under `runs/.cache/llm/`. `mode: "record"` (default) calls the
  provider on miss; `mode: "replay"` throws `LLMReplayMissError` on miss.
- **Budget enforcement**: `budget.check()` runs before AND after each call.
  Pre-trip refuses without spending tokens; post-call detects the call that
  pushed an axis over the line.
- **Secret redaction**: API keys configured at provider construction never
  appear in cache files, trajectories, or the error messages that escape the
  client (`redactValues` scrubs them from any `Error.message`).
- **Cross-language**: Python agents call `gba_agent.LLMClient.call(...)`; the
  bridge forwards to the same TS client so cache/budget/trajectory accounting
  is unified.

The trajectory JSONL gains a third line kind alongside `meta` / `step` / `end`:

```json
{"kind":"llm_call","model":"gpt-4o-mini","prompt_hash":"...","prompt_tokens":42,"completion_tokens":7,"latency_ms":420,"cost_usd":0.0001,"cached":false}
```

## Verifier framework (US-005)

`harness/ts/verifier/` defines the contract every task uses to declare success.
Each task ships a verifier spec; the harness runs it after the agent and
records the verdict next to (and inside) the trajectory.

Three verifier kinds:

- **`js`** — expression evaluated in the page via CDP `Runtime.evaluate`.
  Preferred path for state-of-page checks.
- **`trajectory_predicate`** — JS expression evaluated in Node against
  `traj.{steps, llmCalls, metadata}`. Useful for asserting on the agent's
  recorded actions.
- **`llm_judge`** — temperature=0, n=3 majority vote against a frontier model.
  Allowed only when the task is tagged `judge_required`; the loader rejects
  any other case.

Task spec format (YAML):

```yaml
id: shadow-form
goal: |
  Submit "alice" / "secret" to the shadow form
start_url: http://127.0.0.1:8123/shadow
difficulty: hard
tags: [shadow_dom, form]
verifier:
  kind: js
  expression: |
    fetch('/__test/last').then(r => r.json()).then(j => j.user === 'alice')
```

`loadTaskFile(path)` parses the YAML and validates the verifier spec at load
time — a malformed verifier spec or `kind=llm_judge` without `judge_required`
fails before the tournament starts running.

```ts
import { loadTaskFile, verify } from "./harness/ts/verifier/index.js";

const task = await loadTaskFile("tasks/suite/hard/shadow-form.yaml");
const verdict = await verify(task, { browser, trajectory, llm });
//      ^ {pass, score, reason}
```

`verify(task, ctx)` does three things:
1. dispatches to the right verifier impl
2. appends a `verification` JSONL line into the open trajectory
   (so the audit lives inside `trajectory.jsonl.gz`)
3. writes a `verdict.json` sidecar in the trajectory directory for fast,
   gzip-free inspection

Both side-effects are individually opt-out via
`{recordIntoTrajectory: false, writeAuditFile: false}`.

`Trajectory.recordVerification(record)` is also exposed directly so an agent
that wants to self-verify mid-run can append additional verification lines.
On `finish()`, if no explicit `verifier_verdict` is given but verifications
were recorded, the most-recent verification is folded into `metadata`.

## Running a tournament (US-010)

`make tournament` (`harness/ts/cli/tournament.ts` →
`harness/ts/tournament/runner.ts`) auto-discovers every agent under `agents/`
via `manifest.yaml`, loads every task under `tasks/suite/<slice>/`, and runs
each `(agent, task, seed)` cell with its per-difficulty budget.

```bash
make tournament SLICE=hard SEEDS=3                    # 3 seeds, no bracket
make tournament SLICE=easy SEEDS=1 BRACKET=on         # single-elimination
```

CLI options on `harness/ts/cli/tournament.ts`:

- `--slice=easy,hard` (csv) or `--slice=easy` — which slice(s) to run
- `--seeds=N` — seeds per (agent, task)
- `--agents=a,b,c` — only run these agent ids
- `--tasks=t1,t2`  — only run these task ids
- `--bracket=on|off` — compute single-elimination bracket per slice
- `--retries=N` — override per-slice retry default
- `--runs-root=<path>` — defaults to `<cwd>/runs`

**Resumable**: each completed cell drops a `summary.json` next to
`trajectory.jsonl.gz`. The next invocation skips any cell whose `summary.json`
already exists and reuses the cached metrics. `rm runs/<agent>/<task>/<seed>/summary.json`
to force a single cell to re-run.

**Per-task budgets** (`DIFFICULTY_BUDGETS` in `harness/ts/eval/runner.ts`):
easy=(50k tok, $0.20, 60s, 15 steps), medium=(200k, $1.00, 240s, 40 steps),
hard=(600k, $3.00, 600s, 80 steps). The `Budget` instance enforces all axes;
overrun maps to `terminal_state="BUDGET_EXCEEDED"`.

**Leaderboard** lands at `runs/leaderboard.json` with one row per agent per
slice (sorted by champion-tiebreaker rules: success_pct desc, mean_cost_usd
asc, p95_latency_ms asc). Each row carries
`{success_pct, mean_steps, mean_cost_usd, p50_latency_ms, p95_latency_ms,
recovery_count, decline_count}`. `make report` (US-011) regenerates
`docs/leaderboard.md` from this JSON.

**Bracket**: with `--bracket=on`, the runner builds a single-elimination
bracket per slice using snake seeding (1v4, 2v3 in round 1) and the same
tiebreaker rules as the leaderboard sort. The bracket appears in the JSON
under `slices.<slice>.bracket = {rounds, winner}`.

## Self-hosted apps slice (US-027)

The `hard-app` slice tests agents against four self-hosted SPAs (Gitea,
Excalidraw, BookStack, Vikunja) booted via Docker Compose. Unlike the
`hard-real` slice, the harness owns the infrastructure: an admin user is
seeded, the agent user is pre-created, and `loginAs(session, app)` injects
the session before `agent.run()` so the agent starts already logged in
(it never sees the credentials).

```bash
make apps-up      # boot the four services (~60 s; pulls ~1 GB on first run)
make apps-seed    # idempotent users + project + 10+ items per app
make tournament SLICE=hard-app SEEDS=1
make apps-down    # docker compose down -v (wipes volumes for fast reset)
```

Resource budget: ~860 MB RAM steady state (peaks ~1.5 GB during first
BookStack migration), ~1.5 GB disk for images. Opt out with
`SKIP_SELF_HOSTED=1` — the tournament runner SKIPS the slice cleanly
with a clear log line. The same SKIP behaviour kicks in automatically
when the apps aren't reachable (HTTP-only preflight, ~1.5 s budget).

See `infra/docker/README.md` for the full hard-app contract and
`tasks/CLAUDE.md` (section "Hard-app slice") for the task-author rules.

## Status

Implementation lives behind the user stories in
`scripts/ralph/prd.json`. As of US-001 the workspace boots, the smoke test
passes, and the harness pieces (browser pool, agent contract, verifier,
tasks, tournament) are stubbed for upcoming iterations.
