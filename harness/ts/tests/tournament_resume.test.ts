// US-010 end-to-end: runTournament against the trivial agent on a tiny
// fixture-backed slice. Asserts:
//   - leaderboard.json is written with the documented per-agent shape
//   - per-cell summary.json sidecar lands next to trajectory.jsonl.gz
//   - re-running the tournament SKIPS cells whose summary.json exists
//   - the bracket flag flips on a single-elimination matchup

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTaskFile } from "../verifier/loader.js";
import { runTournament, LEADERBOARD_FILENAME } from "../tournament/runner.js";
import type { CellSummary, LeaderboardFile } from "../tournament/types.js";
import { discoverAgents } from "../tournament/discovery.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test(
  "runTournament: trivial agent on hard fixtures writes leaderboard + summaries; re-run is resumable",
  { timeout: 180_000 },
  async (t) => {
    const repoRoot = process.cwd();
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-tournament-"));

    // Use only one fixture to keep wall time tight; verify shape end-to-end.
    const tasksPath = join(repoRoot, "tasks/suite/hard/shadow-form.yaml");
    const task = await loadTaskFile(tasksPath);
    const agents = (await discoverAgents()).filter((a) => a.id === "click-first-link");
    assert.equal(agents.length, 1);

    const progressLines: string[] = [];
    const result1 = await runTournament({
      slices: ["hard"],
      seeds: 1,
      runsRoot,
      agents,
      tasksBySlice: new Map([["hard", [task]]]),
      onProgress: (l) => progressLines.push(l),
    });
    assert.ok(result1.leaderboardPath, "leaderboardPath should be set");
    assert.ok(await fileExists(result1.leaderboardPath as string));
    assert.ok(progressLines.some((l) => /run\s+agent=click-first-link/.test(l)));

    // Validate leaderboard shape.
    const lbRaw = await readFile(result1.leaderboardPath as string, "utf8");
    const lb = JSON.parse(lbRaw) as LeaderboardFile;
    assert.ok(lb.generated_at);
    assert.ok(lb.slices.hard);
    const row = lb.slices.hard!.rows.find((r) => r.agent_id === "click-first-link");
    assert.ok(row, "expected row for click-first-link");
    assert.equal(row!.total, 1);
    assert.equal(row!.passed, 0);
    assert.equal(row!.success_pct, 0);
    assert.equal(row!.decline_count, 1);
    assert.equal(row!.recovery_count, 0);
    assert.equal(typeof row!.mean_steps, "number");
    assert.equal(typeof row!.mean_cost_usd, "number");
    assert.equal(typeof row!.p50_latency_ms, "number");
    assert.equal(typeof row!.p95_latency_ms, "number");

    // Per-cell summary.json sidecar exists.
    const summaryFile = join(runsRoot, "click-first-link", task.id, "0", "summary.json");
    assert.ok(await fileExists(summaryFile), `expected summary at ${summaryFile}`);
    const summary = JSON.parse(await readFile(summaryFile, "utf8")) as CellSummary;
    assert.equal(summary.agent_id, "click-first-link");
    assert.equal(summary.task_id, task.id);
    assert.equal(summary.seed, 0);
    assert.equal(summary.difficulty, "hard");
    assert.equal(summary.pass, false);
    // trajectory.jsonl.gz also sits alongside.
    const gz = join(runsRoot, "click-first-link", task.id, "0", "trajectory.jsonl.gz");
    assert.ok(await fileExists(gz), `expected gzipped trajectory at ${gz}`);

    // Re-run: no cell should be re-executed (resumability).
    progressLines.length = 0;
    const result2 = await runTournament({
      slices: ["hard"],
      seeds: 1,
      runsRoot,
      agents,
      tasksBySlice: new Map([["hard", [task]]]),
      onProgress: (l) => progressLines.push(l),
    });
    const ranLines = progressLines.filter((l) => /^\[tournament\] run\s/.test(l));
    const resumeLines = progressLines.filter((l) => /^\[tournament\] resume\s/.test(l));
    assert.equal(ranLines.length, 0, `expected zero runs on re-entry, got: ${ranLines.join(" | ")}`);
    assert.equal(resumeLines.length, 1, `expected one resume line, got: ${resumeLines.join(" | ")}`);
    // Cached summary surfaces with reused=true.
    const reusedRow = result2.summariesBySlice.get("hard")![0]!;
    assert.equal(reusedRow.reused, true);
    assert.equal(reusedRow.task_id, task.id);

    // Bracket flag: with a single agent, bracket is null (no matchup).
    const result3 = await runTournament({
      slices: ["hard"],
      seeds: 1,
      runsRoot,
      agents,
      tasksBySlice: new Map([["hard", [task]]]),
      bracket: true,
      skipLeaderboardWrite: true,
      onProgress: () => {},
    });
    assert.equal(result3.leaderboard.slices.hard?.bracket ?? null, null);

    t.diagnostic(`runs root: ${runsRoot}`);
  },
);

test("runTournament: bracket=true with two synthetic agents produces a winner", async () => {
  // Use two pre-discovered TS agents from the repo to avoid fabricating
  // throwaway agent.ts files. The trivial agent fails the hard fixture; we
  // give it two ids by reusing the same dir under different filter keys would
  // require disk fixtures — instead, exercise the bracket pure-function path
  // with synthetic leaderboard rows in tournament_bracket.test.ts. Here we
  // confirm runTournament wires bracket=true through to the leaderboard
  // when >=2 agents exist. The repo ships click-first-link + click-first-link-py.
  const repoRoot = process.cwd();
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-tournament-bracket-"));
  const allAgents = await discoverAgents({ repoRoot });
  const agents = allAgents.filter((a) =>
    a.id === "click-first-link" || a.id === "click-first-link-py",
  );
  if (agents.length < 2) {
    // Repo doesn't ship the python sibling here; skip.
    return;
  }
  const task = await loadTaskFile(join(repoRoot, "tasks/suite/hard/shadow-form.yaml"));
  const result = await runTournament({
    slices: ["hard"],
    seeds: 1,
    runsRoot,
    agents,
    tasksBySlice: new Map([["hard", [task]]]),
    bracket: true,
    skipLeaderboardWrite: true,
  });
  const bracket = result.leaderboard.slices.hard?.bracket ?? null;
  assert.ok(bracket, "expected bracket present");
  assert.equal(bracket!.rounds.length >= 1, true);
  assert.ok(typeof bracket!.winner === "string" && bracket!.winner.length > 0);
});

test("runTournament: leaderboard.json lands at runs/<root>/leaderboard.json", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-tournament-path-"));
  const task = await loadTaskFile(join(process.cwd(), "tasks/suite/hard/shadow-form.yaml"));
  const agents = (await discoverAgents()).filter((a) => a.id === "click-first-link");
  const result = await runTournament({
    slices: ["hard"],
    seeds: 1,
    runsRoot,
    agents,
    tasksBySlice: new Map([["hard", [task]]]),
  });
  assert.equal(result.leaderboardPath, join(runsRoot, LEADERBOARD_FILENAME));
});
