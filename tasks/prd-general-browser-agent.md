# PRD: General Browser Agent — Tournament Harness for Next-Gen Browsing Paradigms

> **Status:** Open / research umbrella. Designed to be expanded by a Ralph loop. Every section ending in `(extension hook)` is an explicit invitation for Ralph (or a human) to add new paradigms, tasks, metrics, or experiments. Do not delete sections — append.

> **Working directory:** `/home/abhinav/projects/general-browser`
> **Available secrets:** `OPENAI_API_KEY`, `GEMINI_API_KEY` in `.env`
> **Available runtime:** Node 24, Python 3.13, `uv`, `google-chrome` 143 (CDP-capable). No Playwright installed yet.

---

## 1. Introduction / Overview

We are building **General Browser Agent (GBA)**: an experimental harness whose purpose is to discover the *strongest single paradigm* (or composition of paradigms) for a general-purpose, prompt-driven browser agent. The end deliverable is a winning agent — chosen by tournament — plus the harness, the trajectory dataset, and a written analysis of why it won.

### Why this exists

The 2026 browser-agent landscape has converged on three perception primitives (DOM, accessibility tree, screenshot) and a small number of control loops (ReAct, plan-execute-critic, MCTS). Public leaders on WebVoyager (Claude Opus 4.6 ≈ 88%, GLM-5V-Turbo ≈ 88.5%) and Online-Mind2Web sit in the 65–85% range, with persistent failure modes:

- **Token blow-up** — re-reading the page every step.
- **Recency bias** — losing the original goal under long traces.
- **DOM lies** — shadow DOM, virtualised lists, canvas/SVG, late hydration.
- **Irreversible action regret** — committing destructive actions before verifying.
- **Brittle visual grounding** — Set-of-Mark alone underperforms on the web.
- **Recovery cost** — ~30% of long-horizon runs hit exceptions; rollback is bolted on, not native.

Most current frameworks (browser-use, Stagehand, Skyvern, Computer Use, Operator, Project Mariner / Gemini Computer Use) attack one or two of these. GBA tests them all in one harness, including paradigms that have not yet been published.

### Method (one paragraph)

We implement a small, identical task harness driven by the same benchmark slice. Each *paradigm* is a thin adapter that consumes a goal and produces a trajectory. The harness records every observation, action, and verdict. Paradigms compete in a single-elimination tournament across multiple seeds and difficulty bands. Ralph's job is to (a) propose new paradigms, (b) propose new ablations of existing ones, (c) propose new tasks, and (d) update this PRD with what it finds.

---

## 2. Goals

- **G1.** Implement a paradigm-agnostic harness with a uniform `Paradigm` interface (goal in, trajectory out) that swaps cleanly between Python and TypeScript adapters.
- **G2.** Build the **12 seed paradigms** in §6 to a "minimum competent" bar (≥ 30% success on the easy slice).
- **G3.** Run a tournament across the seed paradigms on a held-out task slice; declare a champion under fixed budgets ($ / time / steps).
- **G4.** Capture every trajectory as durable artefacts (screenshots, a11y snapshots, action logs, verifier verdicts) so a downstream Ralph loop can mine them for skills, distillation, or new paradigm ideas.
- **G5.** Keep the PRD live: every Ralph iteration is allowed and expected to add paradigms (§6), tasks (§9), and ablations (§10). The number "12" in §6 is a floor, not a ceiling.
- **G6.** Produce a written post-mortem (`docs/results.md`) explaining why the champion won and where it failed — qualitative findings matter as much as the leaderboard.

---

## 3. User Stories

Each story is sized for one focused implementation session. They form a dependency chain unless noted; later stories may run in parallel once §3.US-003 lands.

### US-001: Bootstrap repo and env

**Description:** As a researcher, I want a single command to install deps, launch headless Chrome with CDP, and run a hello-world paradigm against `https://example.com`, so the environment is reproducible.

**Acceptance Criteria:**
- [ ] `uv` (Python) and `npm` (TypeScript) workspaces both initialised at repo root.
- [ ] `make smoke` (or `npm run smoke`) opens Chrome via CDP, navigates to `example.com`, returns the page title, exits 0.
- [ ] `.env.example` documents `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` (optional).
- [ ] Typecheck/lint passes for both languages.

### US-002: Paradigm interface and trajectory log

**Description:** As a paradigm author, I want a stable interface — `class Paradigm: async def run(goal, browser, budget) -> Trajectory` — so my paradigm composes with any other infra.

**Acceptance Criteria:**
- [ ] `Trajectory` is a JSONL-serializable record of `{step, observation, action, latency_ms, tokens_in, tokens_out, cost_usd, screenshot_path, verifier_state}`.
- [ ] A trivial "click first link" paradigm passes the harness contract test.
- [ ] Trajectories land in `runs/<paradigm>/<task_id>/<seed>/trajectory.jsonl` and are gzipped on completion.
- [ ] Typecheck/lint passes.

### US-003: Browser pool + isolation

**Description:** As a harness operator, I want N parallel Chrome contexts in a pool with per-task isolation (fresh profile, fresh cookies, fresh cache), so paradigm runs don't cross-contaminate.

**Acceptance Criteria:**
- [ ] Pool size configurable via env (`GBA_POOL_SIZE`, default 4).
- [ ] Per-run Chrome `--user-data-dir` is unique and torn down on exit.
- [ ] CDP sessions support snapshot/restore via `Page.captureSnapshot` + storage state dump (for paradigms that need rollback).
- [ ] Crash-only design: a wedged context is killed and replaced without taking the harness down.

### US-004: Verifier framework

**Description:** As a researcher, I want every task to ship with a programmatic verifier (a JS or Python predicate over final state) and a flexible LLM-judge fallback, so success is measured the same way for every paradigm.

**Acceptance Criteria:**
- [ ] Verifier signature: `verify(task, browser, trajectory) -> {pass: bool, score: 0..1, reason: str}`.
- [ ] Programmatic verifier preferred; LLM judge (GPT-4-class) used only when explicitly tagged.
- [ ] All verifier verdicts are themselves logged for auditability.
- [ ] Sanity test: the trivial paradigm fails non-trivial tasks.

### US-005: Benchmark slice loader

**Description:** As a researcher, I want a curated slice of ≈ 60 tasks drawn from WebVoyager + Online-Mind2Web + a custom 10-task "stress" set (e.g., shadow DOM, infinite scroll, OAuth-style modal), banded by difficulty, so paradigms compete on the same ladder.

**Acceptance Criteria:**
- [ ] Tasks live as `tasks/suite/*.yaml` with `{id, goal, start_url, difficulty, verifier_kind, verifier_spec, tags}`.
- [ ] Difficulty bands: `easy` (single-site, ≤ 5 steps), `medium` (multi-step, ≤ 15), `hard` (multi-site or recoverable failure required).
- [ ] `make eval PARADIGM=foo SLICE=easy` runs the slice end-to-end and emits a leaderboard row.

### US-006: Implement P1 — Programmatic Observability Bus *(see §6.P1)*

**Acceptance Criteria:**
- [ ] Event bus subscribes to CDP `DOM.*`, `Network.*`, `Page.*`, `Runtime.*` and normalises into a typed event log.
- [ ] Agent observation = "tail of bus since bookmark" + current focus snapshot, not full page.
- [ ] Token cost per step is logged and visibly lower than P3 (DOM-first) on the medium slice.

### US-007: Implement P2 — Compile-then-Execute *(see §6.P2)*

**Acceptance Criteria:**
- [ ] Agent emits a TypeScript program against a typed `BrowserAPI` and adaptive `await llm.assert(...)` checkpoints.
- [ ] Program is sandbox-executed; LLM is only re-invoked when an `assert` fires or the program throws.
- [ ] On easy slice, ≥ 50% of runs use zero in-loop LLM calls after compile.

### US-008: Implement P3 — Hybrid DOM+a11y baseline (control)

**Acceptance Criteria:**
- [ ] Reproduces a "browser-use"-style ReAct loop on top of the harness so we have an honest baseline.
- [ ] Achieves the published baseline ± 5pp on the easy slice or we explain why.

### US-009: Implement P4 — Vision+a11y Cross-Reference (Linked SoM) *(see §6.P4)*

**Acceptance Criteria:**
- [ ] Set-of-Mark labels are derived directly from a11y node IDs so click targets have exact identity across modalities.
- [ ] Single LLM call consumes both screenshot (with marks) and a11y subtree.
- [ ] Beats P3 on the "shadow DOM / canvas" tag bucket.

### US-010: Implement P5 — World-Model Speculative Execution *(see §6.P5)*

**Acceptance Criteria:**
- [ ] A small "world model" LLM predicts the next observation given an action.
- [ ] Top-N candidate actions are scored by predicted-vs-actual divergence; only the top-1 is committed.
- [ ] On `hard` tasks tagged `irreversible`, regret rate is lower than P3.

### US-011: Implement P6 — Skill Crystallisation *(see §6.P6)*

**Acceptance Criteria:**
- [ ] Successful trajectories are decomposed into reusable, parametrised "skills" stored in `skills/*.ts` indexed by embedding.
- [ ] On the second run of a near-duplicate task, ≥ 70% of steps are skill invocations, not novel reasoning.

### US-012: Implement P7 — Filesystem-as-Working-Memory *(see §6.P7)*

**Acceptance Criteria:**
- [ ] Per-run sandbox dir holds `plan.md`, numbered `obs_<n>.md`, `summary.md`, and a rolling `notes.md`.
- [ ] LLM context window contains only `plan.md` + diff(`obs_<n>`, `obs_<n-1>`) + `notes.md` — never the raw page.
- [ ] Demonstrates lower token use than P3 on tasks > 15 steps.

### US-013: Implement P8 — In-Page Agent Runtime *(see §6.P8)*

**Acceptance Criteria:**
- [ ] Inject a JS shim that exposes `agent.findText`, `agent.observe`, `agent.expect` as a high-level API the LLM speaks to.
- [ ] Shim handles shadow/iframe/virtualised list traversal natively.

### US-014: Implement P9 — Multi-Tab Parallel Exploration *(see §6.P9)*

**Acceptance Criteria:**
- [ ] On ambiguous decisions, harness clones the current tab N times, runs each candidate, and a verifier picks the survivor.
- [ ] Pool isolation guarantees other tasks don't starve.

### US-015: Implement P10 — Verifier-First Loop *(see §6.P10)*

**Acceptance Criteria:**
- [ ] First step of every task is generating a JS verification predicate; predicate fires after every action.
- [ ] On verifier failure the diagnostic is structured (what predicate, what state, what diff), not free-text.

### US-016: Implement P11 — Hierarchical Budgeted Recursion *(see §6.P11)*

**Acceptance Criteria:**
- [ ] Budgets (tokens, $, steps, wall time) propagate from root to leaves with quotas.
- [ ] Sub-task results are memoised by `(goal_hash, start_state_hash)` for cross-session reuse.

### US-017: Implement P12 — Trajectory Self-Distillation *(see §6.P12)*

**Acceptance Criteria:**
- [ ] Pipeline takes successful traces, lowers them to deterministic Playwright/CDP scripts, and stores them.
- [ ] An `edge` paradigm replays scripts directly with a small model only as fallback; demonstrates cost reduction on repeated tasks.

### US-018: Tournament runner + leaderboard

**Description:** As a researcher, I want a single command to run all paradigms × all tasks × N seeds with fixed per-task budgets and produce a sortable leaderboard.

**Acceptance Criteria:**
- [ ] `make tournament` writes `runs/leaderboard.json` and `docs/leaderboard.md` (regenerable).
- [ ] Per-paradigm rows include success%, mean steps, $/task, p50/p95 latency, recovery%.
- [ ] Single-elimination bracket logic: bottom-half eliminated each round on `hard` slice.

### US-019: Ralph extension entry points

**Description:** As an autonomous loop, I (Ralph) need a stable place to drop new paradigms and tasks without touching harness code, plus a `prd.json` describing the open work.

**Acceptance Criteria:**
- [ ] `paradigms/<name>/` directory convention is honoured by the harness via auto-discovery (no central registry edit needed).
- [ ] `tasks/suite/*.yaml` ditto.
- [ ] `scripts/ralph/prd.json` exists and is regenerated from this PRD by `make ralph-prd`.

### US-020: Post-mortem write-up

**Description:** As a stakeholder, I want a final analysis explaining what worked, what didn't, and what surprised us.

**Acceptance Criteria:**
- [ ] `docs/results.md` covers: champion description, ablation findings, failure taxonomy, and at least three concrete "next paradigm" hypotheses.

---

## 4. Functional Requirements

- **FR-1.** The harness MUST be paradigm-agnostic. Adding a new paradigm MUST require zero edits to harness internals.
- **FR-2.** Every paradigm run MUST emit a trajectory file even on failure or crash.
- **FR-3.** All LLM calls MUST flow through a single `LLMClient` shim that records `(model, prompt_hash, prompt_tokens, completion_tokens, latency_ms, cost_usd)` and supports caching keyed by `(model, prompt_hash, paradigm_seed)`.
- **FR-4.** Browser sessions MUST be isolated per task, with a fresh profile and reproducible storage state.
- **FR-5.** Verifiers MUST be deterministic. Non-deterministic LLM-judge verifiers MUST be tagged and run with `temperature=0` and `n=3` majority vote.
- **FR-6.** Budgets MUST be enforced. A paradigm that exceeds its `tokens` / `wall_seconds` / `steps` budget is killed and recorded as `BUDGET_EXCEEDED`.
- **FR-7.** Tournament runs MUST be resumable. Killing the runner and restarting MUST not re-execute completed `(paradigm, task, seed)` cells.
- **FR-8.** All randomness MUST be seeded. The same `(paradigm, task, seed)` MUST yield byte-identical actions if the LLM is in cached/replay mode.
- **FR-9.** A paradigm MAY decline a task (`Capability.NOT_APPLICABLE`); declines are reported separately from failures.
- **FR-10.** The harness MUST run in `record` mode (live LLM calls, real browser) and `replay` mode (cached LLM responses, real browser) for cheap regression.

---

## 5. Non-Goals (Out of Scope)

- **NG-1.** No production-grade scheduling, multi-tenant isolation, or auth flows. This is a research harness; a single user runs it.
- **NG-2.** No fine-tuning of base models. Distillation in P12 is restricted to script-lowering and prompt-time learning.
- **NG-3.** No mobile browser. Desktop Chromium only.
- **NG-4.** No CAPTCHA solving, no bypassing of bot-protection. Tasks needing those are filtered out at suite-load time.
- **NG-5.** No actions that send money, post user-visible content, or modify external accounts beyond what the task explicitly requests with a sandbox account.
- **NG-6.** No reliance on commercial agent SaaS (Browserbase, Anchor, Operator) inside paradigms. Citing them as comparison points is fine; the harness itself is self-hosted.
- **NG-7.** No GUI for the harness in v1. CLI + markdown reports only.

---

## 6. Seed Paradigms (≥ 12, expected to grow) *(extension hook)*

Each paradigm ships as `paradigms/<id>/` with a README, a `Paradigm` subclass, and unit tests. The IDs below are stable; Ralph appends new ones as P13+.

### P1 — Programmatic Observability Bus

Instead of polling DOM/screenshot every step, instrument the page once via CDP. Every mutation, network response, focus change, layout shift, and console message becomes an event on a typed pub/sub bus. The agent's "observation" is the *tail of events since its last bookmark* plus the current focus subtree. Hypothesis: this collapses long-horizon token cost because the model sees diffs, not full pages. Prior art: nothing public uses this end-to-end; closest analogue is React DevTools' instrumentation.

### P2 — Compile-then-Execute (CodeAct for browsers, with adaptive checkpoints)

Agent reads the goal, writes a single TypeScript program against a typed `BrowserAPI`, and embeds adaptive checkpoints — `await llm.assert("we are on the cart page", $)`. The program runs as a script; the LLM only re-fires when an assert returns false or the program throws. Most easy tasks finish with one LLM call total. Combines browser-use's "Auto-Research" idea with Karpathy-loop economics. Hypothesis: huge cost wins on repetitive task families.

### P3 — Hybrid DOM + a11y ReAct (control / baseline)

Reproduces the dominant 2026 pattern: a11y snapshot (90–95% smaller than raw HTML) + interactive-element labels + ReAct loop. This is the "browser-use" baseline. We need it as an honest control.

### P4 — Linked Set-of-Mark (Vision × a11y, identity-preserving)

Take a screenshot, derive marks from a11y node IDs (not from segmentation), so mark `7` in the image and node `7` in the a11y subtree are *the same target*. Single LLM call sees both. Hypothesis: solves SoM's identity-collision problem on dense web UIs and dominates on canvas/SVG/shadow content.

### P5 — World-Model Speculative Execution

A small/cheap "world model" LLM is asked: "if I clicked X, what would the page look like?" Run N candidates in parallel, score divergence between predicted and actual on a probe action, commit the winner, rollback the rest via CDP snapshot. Inspired by WMA web agents and SpecMCTS. Hypothesis: massively reduces "irreversible action regret" on `hard` slice.

### P6 — Skill Crystallisation (Voyager-for-the-web)

Mine successful trajectories into parametrised skills (`fill_address(addr)`, `paginate_until(text)`). Skill library is embedding-indexed. New tasks are first decomposed into skill invocations; only novel sub-tasks fall back to free-form agentic search. Hypothesis: cost-per-task decreases monotonically as the library grows.

### P7 — Filesystem-as-Working-Memory (Karpathy-style)

Per-run sandbox dir is the agent's externalised memory. `plan.md` is the durable goal-plus-strategy file. Each step writes `obs_<n>.md` and updates `notes.md`. The LLM context contains only `plan.md` + the latest diff. Rollback = filesystem revert. Hypothesis: small models become competitive because context is curated, not crammed.

### P8 — In-Page Agent Runtime

Inject a JS shim into the page that exposes a high-level, intent-shaped API: `agent.findText`, `agent.expect`, `agent.observe`, `agent.click`. The shim handles shadow DOM, iframes, virtualised lists, and late hydration internally — the LLM never sees those headaches. Hypothesis: removing the impedance mismatch between LLM and Chromium yields the largest real-world reliability gain.

### P9 — Multi-Tab Parallel Exploration

For ambiguous branches, clone the current tab N times via CDP target spawning, try each candidate in parallel, verifier picks the survivor, rest are discarded. Browser tabs *are* the search frontier; tree search becomes free. Hypothesis: dominates on tasks with branching ambiguity (product disambiguation, search-result picking).

### P10 — Verifier-First Loop (Acceptance-Test-Driven Browsing)

Step 0: generate a JS predicate that evaluates whether the goal is met against the page. Predicate auto-fires after every action. The agent never needs to "remember" the goal; it just needs to make the predicate green. On verifier failure, the diagnostic is *structured*: which predicate, which state, which diff. Hypothesis: collapses recency bias and turns recovery into a debug loop instead of a re-plan loop.

### P11 — Hierarchical Budgeted Recursion

Top-level agent decomposes task into sub-tasks; each gets a quota of `(tokens, $, wall_seconds, steps)`. Sub-task results are memoised by `(goal_hash, start_state_hash)`. Failures bubble up; parent re-plans within remaining budget. Like a CPU scheduler for agent reasoning. Hypothesis: predictable cost ceilings + cross-session caching at the sub-task level.

### P12 — Trajectory Self-Distillation (Replay-First, Reason-Last)

Successful trajectories are lowered to deterministic Playwright/CDP scripts. Future runs of the same task family hit the script first, fall back to a full agent only when the script breaks. Closest analogue: ZeroStep, but recursive. Hypothesis: production-grade cost on the long tail of repeat tasks.

### P13+ — *(extension hook for Ralph)*

Ralph: when adding a paradigm, copy the section above and fill in `Hypothesis` and a falsifiable acceptance criterion. Below are seed hypotheses you should consider but I have not yet picked up:

- **Provenance-traced perception**: every claim the agent emits ("we're on checkout") is tagged with the evidence (a11y node id, screenshot region, network response). Verifier disagreements walk the chain to find the bad observation.
- **Streaming action cursor**: continuous low-frequency action stream gated by a small verifier; large LLM only re-engages on goal change or surprise.
- **Negotiated affordances**: probe `/.well-known/agent-affordances.json`; structured fast path when present, perception fallback otherwise. Bets on the agent-friendly web's near-term shape.
- **Reverse-replay self-correction**: when the agent gets stuck, replay the trajectory backwards looking for the last "high-confidence" state and branch from there.
- **Two-model adversarial pair**: actor proposes actions; opponent tries to prove the action moves *away* from the goal; commit only if opponent fails.
- **Latent-state cache**: hash a11y subtree fingerprints; cache "what works here" by fingerprint across tasks and sessions.

---

## 7. Experiment Methodology

### Slice composition (US-005)

- **Easy (20 tasks):** single-site, ≤ 5 steps, programmatic verifier. From WebVoyager easy + WikiHow-style.
- **Medium (25 tasks):** multi-step, ≤ 15 steps, mixed verifiers. From Online-Mind2Web.
- **Hard (15 tasks):** multi-site, recovery required, or `irreversible` tag. Custom + Online-Mind2Web hard.

### Tournament structure

- **Round R1:** all paradigms × `easy`, 3 seeds. Bottom 25% by success% eliminated.
- **Round R2:** survivors × `medium`, 3 seeds. Bottom 33% eliminated.
- **Round R3:** survivors × `hard`, 5 seeds. Champion = highest success%, tiebreaker = lower mean $/task.
- **Round R4 (optional, Ralph):** champion × Ralph-extended slices. Champion may be unseated.

### Per-task budgets

| Slice  | tokens | $ | wall_s | steps |
|--------|--------|----|--------|-------|
| easy   | 50k    | 0.20 | 60   | 15  |
| medium | 200k   | 1.00 | 240  | 40  |
| hard   | 600k   | 3.00 | 600  | 80  |

### Models

- **Default actor:** `gpt-4.1` or `gpt-5`-class, `gemini-2.5-pro`. Both wired.
- **World model (P5):** Gemini Flash class.
- **Verifier judge:** GPT-4o, `temperature=0`, majority of 3.
- Specific model IDs MUST be pinned in `harness/models.yaml` and bumped only via PR.

### Metrics (logged for every cell)

- `success` (verifier verdict)
- `steps`, `wall_seconds`
- `tokens_in`, `tokens_out`, `cost_usd`
- `recovery_count` (number of agent-initiated retries)
- `irreversible_actions` (any action that mutated external state)
- `decline` (paradigm refused the task)

---

## 8. Technical Considerations

- **Language split:** harness core in TypeScript (CDP is most ergonomic in TS); paradigms may be Python or TypeScript via a thin RPC bridge. Cross-language adapters use stdio JSON-RPC, not HTTP, to avoid port noise.
- **CDP, not Playwright:** Stagehand 3 dropping Playwright for raw CDP gave them 44% on shadow/iframe. We start native-CDP from day 1 but keep a Playwright shim for paradigms that explicitly want it.
- **Snapshot/restore:** CDP `Page.captureSnapshot` for DOM, plus `Storage` API dumps for cookies/localStorage. Required by P5 and P9.
- **Cost guardrails:** every `LLMClient.call` checks the running budget for the active task; over-budget calls raise and are caught into `BUDGET_EXCEEDED`.
- **Reproducibility:** all LLM calls are content-hashed; `record` mode persists responses, `replay` mode short-circuits. CI runs in replay mode.
- **Concurrency:** start with `pool_size=4`; tournament is shard-friendly so we can scale to a beefier box later.
- **Observability:** tracebacks, action logs, screenshots, and a11y dumps are written per-step under `runs/`. A tiny static-site report (`make report`) renders the latest tournament without a server.
- **Secrets:** `.env` only, never logged. `LLMClient` redacts auth headers at the source.

---

## 9. Benchmark Suite Composition *(extension hook)*

Initial seed (Ralph: append, do not edit):

- **WebVoyager subset (20):** Allrecipes, Amazon, Apple, ArXiv, BBC News, Booking, Cambridge Dict, Coursera, ESPN, GitHub, Google Maps, Google Search, HuggingFace, IMDB, Reddit, StackOverflow, Wolfram, Yelp.
- **Online-Mind2Web subset (25):** balanced across e-commerce, finance, travel, media, government.
- **Custom stress (10):**
  1. Shadow-DOM heavy SPA (e.g., MUI v6 dashboard fixture).
  2. Canvas-rendered diagram editor — must drag a node.
  3. Infinite-scroll feed — must find an item past page 5.
  4. Modal stack — three nested modals must be navigated in order.
  5. Login-required (sandbox account) flow.
  6. Form with conditional fields that change validation rules mid-stream.
  7. PDF download then summarise locally.
  8. Tab-spawning workflow (action opens new tab; agent must follow).
  9. Cross-iframe drag-and-drop.
 10. Recoverable failure: the "submit" endpoint returns 500 once before succeeding.

---

## 10. Ablations *(extension hook)*

Each ablation is a one-flag variant of an existing paradigm. Ralph: append.

- **A1 — P3 with screenshot disabled** (a11y-only) vs. default — does vision help on web?
- **A2 — P7 with `notes.md` disabled** — does the externalised plan alone suffice?
- **A3 — P10 with verifier hidden from actor** — does the agent benefit from seeing its own predicate?
- **A4 — P5 with N=1** — degenerate; checks whether speculation alone is the win or the parallel branching is.
- **A5 — Mixed: P2 + P10** — code-first program + verifier-first predicate. Hypothesis: best of both.
- **A6 — Mixed: P7 + P11** — filesystem memory + budgeted recursion. Hypothesis: scales to very long horizon.

---

## 11. Success Metrics

- **M1.** Champion paradigm beats P3 (the honest baseline) by ≥ 10 absolute percentage points on the `hard` slice.
- **M2.** Champion paradigm uses ≤ 60% of P3's mean $/task on the `medium` slice.
- **M3.** Paradigm-add-time: a Ralph iteration can add a new paradigm and have it score on `easy` within one wall hour, no harness edits.
- **M4.** Trajectory dataset is large enough (≥ 5k completed task-runs across paradigms) to support downstream distillation experiments.
- **M5.** Post-mortem identifies ≥ 3 falsifiable next-paradigm hypotheses with evidence from the trajectory dataset.

---

## 12. Risks & Mitigations

- **R1. Benchmark contamination.** Live sites change between runs.
  *Mitigation:* pin task suites to dated snapshots where possible; mark live-only tasks; report per-task variance.
- **R2. Budget runaway.** A paradigm loops and burns API credits.
  *Mitigation:* hard kill on budget; nightly cap via env var.
- **R3. Verifier weakness.** A clever paradigm games the predicate.
  *Mitigation:* dual verifiers (programmatic + LLM-judge) for `medium`/`hard`; spot-check 10% of passes by hand.
- **R4. CDP fragility.** A wedged CDP session blocks the pool.
  *Mitigation:* per-task timeout + crash-only restart; the pool spawns fresh contexts.
- **R5. Paradigm "no true Scotsman" creep.** Ralph keeps adding tweaks to a favoured paradigm.
  *Mitigation:* every Ralph addition must specify a *prior* hypothesis and the cell it expects to win; ablations are first-class.

---

## 13. Open Questions *(extension hook — Ralph: answer or split into sub-tasks)*

- **OQ-1.** Does P2's compile-then-execute generalise across sites, or does it overfit to per-site DSLs? (Decide via cross-site replay: train on Amazon, replay on Walmart.)
- **OQ-2.** Is P5's world model worth the parallel cost when the task is reversible? (Ablate by `irreversible` tag.)
- **OQ-3.** Does P7 (filesystem memory) close the gap between Gemini Flash and Opus-class models on the `medium` slice?
- **OQ-4.** Is there a single dominant paradigm, or is the right answer always a *mixture* (e.g., P2 default + P5 on `irreversible` tasks + P9 on ambiguous branches)?
- **OQ-5.** Can we mine a fully-deterministic "skill" from a P6 trajectory and have P12 distil it down to a Playwright script, end-to-end, without human review?
- **OQ-6.** What is the right action space granularity? Pixel-level (Computer Use) vs. element-level (browser-use) vs. semantic (P8) — does this even matter once verifiers are strong?
- **OQ-7.** Can paradigms be *composed at runtime* — e.g., the harness picks the right paradigm per task based on trajectory features?
- **OQ-8.** Where do agents systematically fail in a way no current paradigm addresses? (Ralph: look for clusters in failed trajectories and propose P13+.)

---

## 14. Repository Layout (target)

```
general-browser/
├── .env.example
├── Makefile
├── package.json                 # TS workspace root
├── pyproject.toml               # Python via uv
├── harness/
│   ├── core/                    # Paradigm interface, browser pool, LLMClient
│   ├── verifier/
│   ├── tournament/
│   └── models.yaml              # pinned model IDs
├── paradigms/
│   ├── p1-event-bus/
│   ├── p2-compile-execute/
│   ├── p3-hybrid-baseline/      # honest control
│   ├── p4-linked-som/
│   ├── p5-world-model-spec/
│   ├── p6-skill-crystal/
│   ├── p7-filesystem-memory/
│   ├── p8-in-page-runtime/
│   ├── p9-multi-tab-search/
│   ├── p10-verifier-first/
│   ├── p11-budgeted-recursion/
│   └── p12-self-distill/
├── tasks/
│   ├── prd-general-browser-agent.md   # this file
│   └── suite/                   # YAML benchmark tasks
├── runs/                        # trajectories, screenshots, leaderboards (gitignored)
├── skills/                      # P6 skill library (versioned)
├── docs/
│   ├── leaderboard.md           # generated
│   └── results.md               # post-mortem
└── scripts/
    └── ralph/
        └── prd.json             # Ralph-format PRD, regenerated from this file
```

---

## 15. Ralph Loop Guidance *(extension hook)*

Ralph: this PRD is your scratch space. Rules:

1. **Append, don't rewrite.** Every section is open. Never delete a paradigm; mark losers as `[deprecated by tournament]` instead.
2. **Every new paradigm needs:** a hypothesis, an acceptance test, an expected slice/tag where it beats P3.
3. **Every new task needs:** a programmatic verifier (preferred) or an LLM-judge spec.
4. **Run cheap before expensive.** Validate ideas on `easy` before spending `hard` budget.
5. **Mine the trajectory dataset.** Failure clusters are the cheapest source of new paradigm ideas.
6. **Promote winners up the bracket; don't tune them in place.** A paradigm that mutates between rounds is a different paradigm — give it a new ID.
7. **When stuck, write a doc, not code.** A short `docs/notes-<topic>.md` beats a half-finished paradigm.

---

## Glossary

- **Paradigm.** An end-to-end strategy for converting a goal into a trajectory. Each is a `Paradigm` subclass.
- **Trajectory.** The full record of a single `(paradigm, task, seed)` run.
- **Verifier.** A predicate (programmatic or LLM-judge) that decides whether the trajectory's final state satisfies the goal.
- **CDP.** Chrome DevTools Protocol.
- **a11y tree.** Accessibility tree — semantic, ~10× smaller than raw DOM, the default observation surface in 2026.
- **SoM.** Set-of-Mark prompting — overlay numbered marks on a screenshot.
- **WMA.** World-model-augmented (web agent).
