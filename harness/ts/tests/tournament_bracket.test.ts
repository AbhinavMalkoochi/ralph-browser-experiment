// US-010 single-elimination bracket: snake seeding, deterministic
// tiebreakers, byes for odd counts.

import test from "node:test";
import assert from "node:assert/strict";

import { buildBracket } from "../tournament/bracket.js";
import type { LeaderboardRow } from "../tournament/types.js";

function row(over: Partial<LeaderboardRow>): LeaderboardRow {
  return {
    agent_id: over.agent_id ?? "x",
    total: 10,
    passed: 5,
    success_pct: 0.5,
    mean_steps: 1,
    mean_cost_usd: 0,
    p50_latency_ms: 100,
    p95_latency_ms: 200,
    recovery_count: 0,
    decline_count: 0,
    ...over,
  };
}

test("buildBracket: <2 agents → null", () => {
  assert.equal(buildBracket([]), null);
  assert.equal(buildBracket([row({ agent_id: "solo" })]), null);
});

test("buildBracket: 2 agents → 1 round, 1 match, higher success_pct wins", () => {
  const rows = [row({ agent_id: "alpha", success_pct: 0.9 }), row({ agent_id: "beta", success_pct: 0.4 })];
  const bracket = buildBracket(rows)!;
  assert.equal(bracket.rounds.length, 1);
  assert.equal(bracket.rounds[0]!.matches.length, 1);
  const m = bracket.rounds[0]!.matches[0]!;
  assert.equal(m.a, "alpha");
  assert.equal(m.b, "beta");
  assert.equal(m.winner, "alpha");
  assert.equal(bracket.winner, "alpha");
  assert.match(m.reason, /success_pct/);
});

test("buildBracket: 4 agents → 2 rounds, snake seeding (1v4, 2v3)", () => {
  const rows = [
    row({ agent_id: "s1", success_pct: 0.9 }),
    row({ agent_id: "s2", success_pct: 0.7 }),
    row({ agent_id: "s3", success_pct: 0.5 }),
    row({ agent_id: "s4", success_pct: 0.3 }),
  ];
  const bracket = buildBracket(rows)!;
  assert.equal(bracket.rounds.length, 2);
  const r1 = bracket.rounds[0]!.matches.map((m) => `${m.a}|${m.b}`).sort();
  assert.deepEqual(r1, ["s1|s4", "s2|s3"]);
  // s1 beats s4, s2 beats s3 → final s1 vs s2 → s1 wins
  assert.equal(bracket.winner, "s1");
});

test("buildBracket: odd count → top seed gets a bye in round 1", () => {
  const rows = [
    row({ agent_id: "s1", success_pct: 0.9 }),
    row({ agent_id: "s2", success_pct: 0.7 }),
    row({ agent_id: "s3", success_pct: 0.5 }),
  ];
  const bracket = buildBracket(rows)!;
  // round 1 should pair s1 (top) vs s3 (bottom) and give s2 (middle) a bye.
  const r1 = bracket.rounds[0]!.matches;
  const bye = r1.find((m) => m.b === null);
  assert.ok(bye, "expected a bye");
  assert.equal(bye!.a, "s2");
  assert.equal(bye!.winner, "s2");
});

test("buildBracket: tie on success_pct → lower mean_cost_usd wins", () => {
  const rows = [
    row({ agent_id: "expensive", success_pct: 0.5, mean_cost_usd: 0.5 }),
    row({ agent_id: "cheap", success_pct: 0.5, mean_cost_usd: 0.01 }),
  ];
  const bracket = buildBracket(rows)!;
  assert.equal(bracket.winner, "cheap");
  assert.match(bracket.rounds[0]!.matches[0]!.reason, /cost/);
});

test("buildBracket: tie on success_pct + cost → lower p95_latency wins", () => {
  const rows = [
    row({ agent_id: "slow", success_pct: 0.5, mean_cost_usd: 0, p95_latency_ms: 5000 }),
    row({ agent_id: "fast", success_pct: 0.5, mean_cost_usd: 0, p95_latency_ms: 100 }),
  ];
  const bracket = buildBracket(rows)!;
  assert.equal(bracket.winner, "fast");
  assert.match(bracket.rounds[0]!.matches[0]!.reason, /p95/);
});

test("buildBracket: alphabetical seeding option", () => {
  const rows = [
    row({ agent_id: "zebra", success_pct: 0.9 }),
    row({ agent_id: "alpha", success_pct: 0.4 }),
  ];
  const bracket = buildBracket(rows, { seeding: "alphabetical" })!;
  // a should be the top seed by id order.
  assert.equal(bracket.rounds[0]!.matches[0]!.a, "alpha");
  assert.equal(bracket.rounds[0]!.matches[0]!.b, "zebra");
  // But zebra still wins because success_pct dominates.
  assert.equal(bracket.winner, "zebra");
});
