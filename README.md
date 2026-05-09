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

## Per-task budgets

| Slice  | tokens | $    | wall_s | steps |
|--------|--------|------|--------|-------|
| easy   |   50k  | 0.20 |   60   |  15   |
| medium |  200k  | 1.00 |  240   |  40   |
| hard   |  600k  | 3.00 |  600   |  80   |

Budgets are enforced by `LLMClient` (US-004) and the tournament runner (US-010).
A run that exceeds any axis is recorded as `BUDGET_EXCEEDED`.

## Running a tournament

`make tournament` loads every agent under `agents/` and every task under
`tasks/suite/<slice>/`, runs each `(agent, task, seed)` cell with its budget,
and writes `runs/leaderboard.json`. The runner is resumable — completed cells
are not re-executed on restart. `make report` regenerates
`docs/leaderboard.md` from the JSON.

## Status

Implementation lives behind the user stories in
`scripts/ralph/prd.json`. As of US-001 the workspace boots, the smoke test
passes, and the harness pieces (browser pool, agent contract, verifier,
tasks, tournament) are stubbed for upcoming iterations.
