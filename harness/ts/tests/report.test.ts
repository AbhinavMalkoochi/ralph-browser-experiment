// US-011 markdown leaderboard report generator.
//
// Covers:
//   - paretoFront() picks the dominant agents
//   - bestTrajectoryPerAgent() picks the highest-score (then cheapest) cell
//   - computeFailureClusters() groups by terminal_state + tag, falls back
//     gracefully when a task is unknown
//   - renderReport() emits the documented sections (tables per slice,
//     Pareto, best trajectory, failure clusters) with repo-relative links
//   - generateReport() reads runs/leaderboard.json + summary.json sidecars
//     and writes docs/leaderboard.md
//   - loadAllSummaries() walks runs/<agent>/<task>/<seed>/summary.json
//     and skips top-level non-cell entries (.cache, leaderboard.json)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bestTrajectoryPerAgent,
  computeFailureClusters,
  generateReport,
  loadAllSummaries,
  paretoFront,
  renderReport,
} from "../report/index.js";
import type { CellSummary, LeaderboardFile, LeaderboardRow } from "../tournament/types.js";
import type { Task } from "../verifier/types.js";
import { writeSummary } from "../tournament/summary.js";
import { writeLeaderboard } from "../tournament/leaderboard.js";

function row(over: Partial<LeaderboardRow>): LeaderboardRow {
  return {
    agent_id: "a",
    total: 1,
    passed: 1,
    success_pct: 1,
    mean_steps: 1,
    mean_cost_usd: 0.01,
    p50_latency_ms: 100,
    p95_latency_ms: 200,
    recovery_count: 0,
    decline_count: 0,
    ...over,
  };
}

function summary(over: Partial<CellSummary>): CellSummary {
  return {
    agent_id: "a",
    task_id: "t1",
    seed: 0,
    difficulty: "easy",
    completed_at: "2026-05-09T00:00:00.000Z",
    terminal_state: "DONE",
    pass: true,
    score: 1,
    reason: "ok",
    decline_reason: null,
    steps: 1,
    llm_calls: 0,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 100,
    attempts: 1,
    ...over,
  };
}

function task(over: Partial<Task>): Task {
  return {
    id: "t1",
    goal: "go",
    start_url: "https://example.com/",
    difficulty: "easy",
    tags: ["easy"],
    verifier: { kind: "js", expression: "true" },
    ...over,
  };
}

// --- pareto ---------------------------------------------------------------

test("paretoFront: dominated agents are filtered out", () => {
  const rows: LeaderboardRow[] = [
    row({ agent_id: "cheap-good", success_pct: 0.8, mean_cost_usd: 0.01 }),
    row({ agent_id: "expensive-good", success_pct: 0.8, mean_cost_usd: 0.05 }),
    row({ agent_id: "cheap-bad", success_pct: 0.3, mean_cost_usd: 0.01 }),
    row({ agent_id: "expensive-best", success_pct: 0.95, mean_cost_usd: 0.5 }),
  ];
  const front = paretoFront(rows);
  const ids = front.map((r) => r.agent_id).sort();
  // expensive-good is dominated by cheap-good (same success, lower cost).
  // cheap-bad is dominated by cheap-good (same cost, higher success).
  assert.deepEqual(ids, ["cheap-good", "expensive-best"]);
});

test("paretoFront: empty input → empty output", () => {
  assert.deepEqual(paretoFront([]), []);
});

test("paretoFront: single agent is on the front by definition", () => {
  const rows: LeaderboardRow[] = [row({ agent_id: "alone", success_pct: 0, mean_cost_usd: 1 })];
  assert.equal(paretoFront(rows).length, 1);
});

// --- best trajectory ------------------------------------------------------

test("bestTrajectoryPerAgent: prefers pass=true, then highest score, then cheapest", () => {
  const summaries: CellSummary[] = [
    summary({ agent_id: "alpha", task_id: "t1", pass: false, score: 0.4, cost_usd: 0.01 }),
    summary({ agent_id: "alpha", task_id: "t2", pass: true, score: 0.9, cost_usd: 0.10 }),
    summary({ agent_id: "alpha", task_id: "t3", pass: true, score: 0.9, cost_usd: 0.05 }),
    summary({ agent_id: "beta", task_id: "tx", pass: false, score: 0.0 }),
  ];
  const best = bestTrajectoryPerAgent(summaries);
  const alpha = best.find((b) => b.agent_id === "alpha")!;
  assert.equal(alpha.task_id, "t3", "ties on pass+score should break by lowest cost");
  assert.equal(alpha.pass, true);
  const beta = best.find((b) => b.agent_id === "beta")!;
  assert.equal(beta.pass, false, "an agent with no passes still gets a best entry");
});

test("bestTrajectoryPerAgent: empty input → empty output", () => {
  assert.deepEqual(bestTrajectoryPerAgent([]), []);
});

// --- failure clusters -----------------------------------------------------

test("computeFailureClusters: groups failures by terminal_state and by task tag", () => {
  const tasks = new Map<string, Task>([
    ["t-shadow", task({ id: "t-shadow", difficulty: "hard", tags: ["hard", "fixtures", "shadow_dom"] })],
    ["t-canvas", task({ id: "t-canvas", difficulty: "hard", tags: ["hard", "fixtures", "canvas"] })],
  ]);
  const summaries: CellSummary[] = [
    summary({ task_id: "t-shadow", pass: false, terminal_state: "DECLINED", difficulty: "hard" }),
    summary({ task_id: "t-shadow", pass: false, terminal_state: "DECLINED", difficulty: "hard", seed: 1 }),
    summary({ task_id: "t-canvas", pass: false, terminal_state: "BUDGET_EXCEEDED", difficulty: "hard" }),
    summary({ task_id: "t-canvas", pass: true, terminal_state: "DONE", difficulty: "hard", seed: 1 }),
    summary({ task_id: "t-unknown", pass: false, terminal_state: null, difficulty: "easy" }),
  ];
  const clusters = computeFailureClusters(summaries, tasks);
  assert.equal(clusters.failed.length, 4);
  assert.equal(clusters.byErrorClass.get("DECLINED"), 2);
  assert.equal(clusters.byErrorClass.get("BUDGET_EXCEEDED"), 1);
  assert.equal(clusters.byErrorClass.get("UNKNOWN"), 1);
  assert.equal(clusters.byTag.get("hard"), 3, "3 failures on hard-tagged tasks");
  assert.equal(clusters.byTag.get("shadow_dom"), 2);
  assert.equal(clusters.byTag.get("canvas"), 1);
  // unknown task contributes no tag entries.
  const unknown = clusters.byTask.get("t-unknown")!;
  assert.deepEqual(unknown.tags, []);
  assert.equal(unknown.failures, 1);
});

// --- renderReport ---------------------------------------------------------

test("renderReport: includes per-slice tables, Pareto, best trajectory, failure clusters with repo-relative links", () => {
  const leaderboard: LeaderboardFile = {
    generated_at: "2026-05-09T12:00:00.000Z",
    slices: {
      easy: {
        rows: [
          row({ agent_id: "alpha", total: 4, passed: 3, success_pct: 0.75, mean_cost_usd: 0.01 }),
          row({ agent_id: "beta", total: 4, passed: 1, success_pct: 0.25, mean_cost_usd: 0.10 }),
        ],
      },
      hard: {
        rows: [
          row({
            agent_id: "alpha",
            total: 2,
            passed: 0,
            success_pct: 0,
            mean_cost_usd: 0,
            decline_count: 2,
          }),
        ],
        bracket: {
          winner: "alpha",
          rounds: [
            {
              round: 1,
              matches: [{ a: "alpha", b: "beta", winner: "alpha", reason: "success_pct 75% > 25%" }],
            },
          ],
        },
      },
    },
    overall: [
      row({ agent_id: "alpha", total: 6, passed: 3, success_pct: 0.5, mean_cost_usd: 0.01 }),
      row({ agent_id: "beta", total: 4, passed: 1, success_pct: 0.25, mean_cost_usd: 0.10 }),
    ],
  };
  const summaries: CellSummary[] = [
    summary({ agent_id: "alpha", task_id: "easy-1", pass: true, score: 1, cost_usd: 0.005 }),
    summary({ agent_id: "alpha", task_id: "hard-1", pass: false, terminal_state: "DECLINED", difficulty: "hard" }),
    summary({ agent_id: "beta", task_id: "easy-1", pass: false, terminal_state: "BUDGET_EXCEEDED" }),
  ];
  const tasks = new Map<string, Task>([
    ["easy-1", task({ id: "easy-1", tags: ["easy", "navigate"] })],
    ["hard-1", task({ id: "hard-1", difficulty: "hard", tags: ["hard", "fixtures"] })],
  ]);
  const md = renderReport({ leaderboard, summaries, tasksById: tasks });

  // Header.
  assert.match(md, /# General Browser Agent Tournament Leaderboard/);
  assert.match(md, /Generated 2026-05-09T12:00:00\.000Z/);
  // Slices appear in the canonical order: easy then hard.
  const easyIdx = md.indexOf("## Slice: `easy`");
  const hardIdx = md.indexOf("## Slice: `hard`");
  assert.ok(easyIdx >= 0 && hardIdx > easyIdx, "easy must come before hard");
  // Agent README link uses the default ../ prefix.
  assert.match(md, /\[alpha\]\(\.\.\/agents\/alpha\/README\.md\)/);
  // Bracket section appears for the slice that has a bracket.
  assert.match(md, /### Bracket/);
  assert.match(md, /Winner: \*\*alpha\*\*/);
  // Pareto-optimal listing.
  assert.match(md, /## Pareto front/);
  assert.match(md, /Pareto-optimal agents/);
  // Best trajectory table links to the gz under runs/.
  assert.match(md, /## Best trajectory per agent/);
  assert.match(md, /\.\.\/runs\/alpha\/easy-1\/0\/trajectory\.jsonl\.gz/);
  // Failure clusters: shows error class + tag.
  assert.match(md, /## Failure clusters/);
  assert.match(md, /`DECLINED`/);
  assert.match(md, /`BUDGET_EXCEEDED`/);
  assert.match(md, /`fixtures`/);
  assert.match(md, /`navigate`/);
  // Recent failure trajectory list.
  assert.match(md, /### Recent failure trajectories/);
});

test("renderReport: respects custom linkPrefix", () => {
  const md = renderReport(
    {
      leaderboard: {
        generated_at: "2026-05-09T00:00:00.000Z",
        slices: { easy: { rows: [row({ agent_id: "alpha" })] } },
        overall: [row({ agent_id: "alpha" })],
      },
      summaries: [summary({ agent_id: "alpha" })],
      tasksById: new Map(),
    },
    { linkPrefix: "https://example.com/" },
  );
  assert.match(md, /https:\/\/example\.com\/agents\/alpha\/README\.md/);
});

test("renderReport: empty failure section when nothing failed", () => {
  const md = renderReport({
    leaderboard: {
      generated_at: "2026-05-09T00:00:00.000Z",
      slices: { easy: { rows: [row({ agent_id: "alpha" })] } },
      overall: [row({ agent_id: "alpha" })],
    },
    summaries: [summary({ agent_id: "alpha", pass: true })],
    tasksById: new Map(),
  });
  assert.match(md, /No failures recorded/);
});

// --- loadAllSummaries -----------------------------------------------------

test("loadAllSummaries: walks runs/<agent>/<task>/<seed>/summary.json and skips non-cell entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "gba-report-load-"));
  // Cell A.
  await writeSummary(join(root, "agentA", "task1", "0", "summary.json"), summary({ agent_id: "agentA" }));
  // Cell B.
  await writeSummary(join(root, "agentB", "task2", "1", "summary.json"), summary({ agent_id: "agentB", task_id: "task2", seed: 1 }));
  // Top-level files / dirs that must be skipped.
  await writeFile(join(root, "leaderboard.json"), "{}");
  await mkdir(join(root, ".cache"), { recursive: true });
  await writeFile(join(root, ".cache", "ignored.json"), "{}");

  const all = await loadAllSummaries(root);
  const ids = all.map((s) => s.agent_id).sort();
  assert.deepEqual(ids, ["agentA", "agentB"]);
});

test("loadAllSummaries: missing runs root → empty list", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "gba-report-empty-")), "does-not-exist");
  const all = await loadAllSummaries(root);
  assert.deepEqual(all, []);
});

// --- generateReport (end-to-end) ------------------------------------------

test("generateReport: reads leaderboard.json + summaries and writes docs/leaderboard.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "gba-report-e2e-"));
  const runsRoot = join(root, "runs");
  // Stage a real leaderboard.json + one summary.json.
  await writeLeaderboard(join(runsRoot, "leaderboard.json"), {
    generated_at: "2026-05-09T13:00:00.000Z",
    slices: {
      easy: {
        rows: [row({ agent_id: "click-first-link", total: 1, passed: 0, success_pct: 0, decline_count: 1 })],
      },
    },
    overall: [row({ agent_id: "click-first-link", total: 1, passed: 0, success_pct: 0, decline_count: 1 })],
  });
  await writeSummary(
    join(runsRoot, "click-first-link", "easy-example-com", "0", "summary.json"),
    summary({
      agent_id: "click-first-link",
      task_id: "easy-example-com",
      pass: false,
      terminal_state: "DECLINED",
      decline_reason: "no-links",
    }),
  );
  // Reuse the repo's tasks/suite/easy so the easy-example-com tag lookup works.
  const repoRoot = process.cwd();
  const outPath = join(root, "docs", "leaderboard.md");
  const result = await generateReport({ runsRoot, repoRoot, outPath });
  assert.equal(result.outPath, outPath);
  assert.equal(result.summaryCount, 1);
  assert.ok(result.taskCount > 0, "task lookup should populate from tasks/suite/easy");
  const md = await readFile(outPath, "utf8");
  assert.match(md, /## Slice: `easy`/);
  assert.match(md, /click-first-link/);
  assert.match(md, /## Pareto front/);
  assert.match(md, /## Best trajectory per agent/);
  assert.match(md, /## Failure clusters/);
  assert.match(md, /`DECLINED`/);
});

test("generateReport: filters out summaries from slices not represented in the leaderboard", async () => {
  const root = await mkdtemp(join(tmpdir(), "gba-report-filter-"));
  const runsRoot = join(root, "runs");
  // Leaderboard only mentions hard.
  await writeLeaderboard(join(runsRoot, "leaderboard.json"), {
    generated_at: "2026-05-09T14:00:00.000Z",
    slices: {
      hard: { rows: [row({ agent_id: "click-first-link", total: 1, passed: 0, success_pct: 0 })] },
    },
    overall: [row({ agent_id: "click-first-link", total: 1, passed: 0, success_pct: 0 })],
  });
  // But on disk: an easy cell from a prior tournament + a hard cell for this run.
  await writeSummary(
    join(runsRoot, "click-first-link", "easy-stale", "0", "summary.json"),
    summary({ agent_id: "click-first-link", task_id: "easy-stale", pass: true, difficulty: "easy" }),
  );
  await writeSummary(
    join(runsRoot, "click-first-link", "hard-shadow-form", "0", "summary.json"),
    summary({
      agent_id: "click-first-link",
      task_id: "hard-shadow-form",
      pass: false,
      terminal_state: "DECLINED",
      difficulty: "hard",
    }),
  );
  const outPath = join(root, "out.md");
  const result = await generateReport({ runsRoot, repoRoot: process.cwd(), outPath });
  // Only the hard-slice cell should have made it through.
  assert.equal(result.summaryCount, 1, "easy-stale must be filtered out");
  const md = result.markdown;
  assert.ok(!md.includes("easy-stale"), "easy-stale should not appear in the report");
  assert.match(md, /hard-shadow-form/);
});

test("generateReport: missing leaderboard.json throws a clear error", async () => {
  const root = await mkdtemp(join(tmpdir(), "gba-report-missing-"));
  await assert.rejects(
    () => generateReport({ runsRoot: root, repoRoot: process.cwd(), outPath: join(root, "out.md") }),
    /ENOENT|leaderboard\.json/,
  );
});
