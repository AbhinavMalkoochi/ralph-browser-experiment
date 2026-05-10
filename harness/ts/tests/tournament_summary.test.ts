// US-010 cell summary I/O.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasSummary, readSummary, summaryPath, writeSummary } from "../tournament/summary.js";
import type { CellSummary } from "../tournament/types.js";

test("summaryPath: <runs>/<agent>/<task>/<seed>/summary.json", () => {
  const p = summaryPath({ runsRoot: "/runs", agent: "a", task: "t", seed: 0 });
  assert.equal(p, "/runs/a/t/0/summary.json");
});

test("readSummary returns null on missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-summary-"));
  const v = await readSummary(join(dir, "nope.json"));
  assert.equal(v, null);
});

test("writeSummary then readSummary round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-summary-"));
  const path = join(dir, "x", "y", "summary.json");
  const orig: CellSummary = {
    agent_id: "a",
    task_id: "t",
    seed: 0,
    difficulty: "hard",
    completed_at: "2026-05-09T01:00:00.000Z",
    terminal_state: "DECLINED",
    pass: false,
    score: 0,
    reason: "no anchors",
    decline_reason: "no links",
    steps: 1,
    llm_calls: 0,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 1234,
    attempts: 1,
  };
  assert.equal(await hasSummary(path), false);
  await writeSummary(path, orig);
  assert.equal(await hasSummary(path), true);
  const back = await readSummary(path);
  assert.deepEqual(back, orig);
});
