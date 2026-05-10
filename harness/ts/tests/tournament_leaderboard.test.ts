// US-010 leaderboard aggregation: percentiles, recovery_count, decline_count,
// per-agent rows sorted by champion-tiebreaker rules.

import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregate,
  buildLeaderboardFile,
  percentile,
} from "../tournament/leaderboard.js";
import type { CellSummary } from "../tournament/types.js";

function cell(over: Partial<CellSummary>): CellSummary {
  return {
    agent_id: "a",
    task_id: "t",
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

test("percentile: empty array → 0", () => {
  assert.equal(percentile([], 0.5), 0);
});

test("percentile: single element", () => {
  assert.equal(percentile([42], 0.5), 42);
  assert.equal(percentile([42], 0.95), 42);
});

test("percentile: midpoint linear interp", () => {
  // [10, 20, 30] → p50 = 20, p95 = 29 (interp 0.95*(3-1)=1.9)
  const sorted = [10, 20, 30];
  assert.equal(percentile(sorted, 0.5), 20);
  assert.equal(percentile(sorted, 0.95), 29);
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 1), 30);
});

test("aggregate: groups summaries by agent and computes the documented metrics", () => {
  const summaries: CellSummary[] = [
    cell({ agent_id: "alpha", task_id: "t1", pass: true, steps: 4, cost_usd: 0.01, latency_ms: 100 }),
    cell({ agent_id: "alpha", task_id: "t2", pass: true, steps: 6, cost_usd: 0.03, latency_ms: 200 }),
    cell({
      agent_id: "alpha",
      task_id: "t3",
      pass: false,
      terminal_state: "DECLINED",
      steps: 1,
      cost_usd: 0,
      latency_ms: 50,
    }),
    cell({
      agent_id: "alpha",
      task_id: "t4",
      pass: true,
      attempts: 2, // recovered after one failure
      steps: 3,
      cost_usd: 0.02,
      latency_ms: 400,
    }),
    cell({
      agent_id: "beta",
      task_id: "t1",
      pass: false,
      terminal_state: "DECLINED",
      steps: 0,
      cost_usd: 0,
      latency_ms: 30,
    }),
    cell({
      agent_id: "beta",
      task_id: "t2",
      pass: false,
      terminal_state: "BUDGET_EXCEEDED",
      steps: 5,
      cost_usd: 0.5,
      latency_ms: 9000,
    }),
  ];
  const rows = aggregate(summaries);
  assert.equal(rows.length, 2);
  // Champion sort: alpha > beta because higher success_pct.
  assert.equal(rows[0]!.agent_id, "alpha");
  assert.equal(rows[1]!.agent_id, "beta");

  const alpha = rows[0]!;
  assert.equal(alpha.total, 4);
  assert.equal(alpha.passed, 3);
  assert.equal(alpha.success_pct, 0.75);
  assert.equal(alpha.recovery_count, 1, "alpha had one cell with attempts>1 that passed");
  assert.equal(alpha.decline_count, 1);
  // mean steps = (4+6+1+3)/4 = 3.5
  assert.equal(alpha.mean_steps, 3.5);
  // mean cost = (0.01 + 0.03 + 0 + 0.02)/4 = 0.015
  assert.ok(Math.abs(alpha.mean_cost_usd - 0.015) < 1e-9);
  // latencies sorted: [50, 100, 200, 400]; p50 = 150, p95 = 0.95*3=2.85 → between idx 2 and 3 → 200 + 0.85*(400-200) = 370
  assert.ok(Math.abs(alpha.p50_latency_ms - 150) < 1e-6);
  assert.ok(Math.abs(alpha.p95_latency_ms - 370) < 1e-6);

  const beta = rows[1]!;
  assert.equal(beta.total, 2);
  assert.equal(beta.passed, 0);
  assert.equal(beta.success_pct, 0);
  assert.equal(beta.recovery_count, 0);
  assert.equal(beta.decline_count, 1, "BUDGET_EXCEEDED is NOT a decline");
});

test("aggregate: ties on success_pct break by lower mean_cost_usd", () => {
  const summaries: CellSummary[] = [
    cell({ agent_id: "expensive", pass: true, cost_usd: 0.5, latency_ms: 100 }),
    cell({ agent_id: "cheap", pass: true, cost_usd: 0.01, latency_ms: 100 }),
  ];
  const rows = aggregate(summaries);
  assert.equal(rows[0]!.agent_id, "cheap");
  assert.equal(rows[1]!.agent_id, "expensive");
});

test("aggregate: ties on success_pct + mean_cost_usd break by lower p95_latency_ms", () => {
  const summaries: CellSummary[] = [
    cell({ agent_id: "slow", pass: true, cost_usd: 0, latency_ms: 5000 }),
    cell({ agent_id: "fast", pass: true, cost_usd: 0, latency_ms: 100 }),
  ];
  const rows = aggregate(summaries);
  assert.equal(rows[0]!.agent_id, "fast");
});

test("buildLeaderboardFile: emits per-slice rows + overall ranking", () => {
  const easy: CellSummary[] = [
    cell({ agent_id: "alpha", task_id: "e1", pass: true, latency_ms: 100 }),
    cell({ agent_id: "beta", task_id: "e1", pass: false, latency_ms: 100 }),
  ];
  const hard: CellSummary[] = [
    cell({ agent_id: "alpha", task_id: "h1", pass: false, latency_ms: 1000 }),
    cell({ agent_id: "beta", task_id: "h1", pass: true, latency_ms: 800 }),
  ];
  const file = buildLeaderboardFile({
    perSlice: new Map([
      ["easy", easy],
      ["hard", hard],
    ]),
  });
  assert.ok(file.generated_at);
  assert.deepEqual(Object.keys(file.slices).sort(), ["easy", "hard"]);
  assert.equal(file.slices.easy!.rows[0]!.agent_id, "alpha");
  assert.equal(file.slices.hard!.rows[0]!.agent_id, "beta");
  // overall: each agent passes 1/2.
  assert.ok(file.overall);
  assert.equal(file.overall!.length, 2);
  for (const r of file.overall!) {
    assert.equal(r.total, 2);
    assert.equal(r.passed, 1);
    assert.equal(r.success_pct, 0.5);
  }
});
