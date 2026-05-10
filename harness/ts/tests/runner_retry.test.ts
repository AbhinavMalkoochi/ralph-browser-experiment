// US-009: unit tests for the retry helper used by runEval to tolerate
// live-site flakiness on the easy slice.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultRetriesForSlice,
  runWithRetry,
  SLICE_RETRIES,
  type EvalResult,
} from "../eval/runner.js";

function fakeResult(pass: boolean, label: string): EvalResult {
  return {
    task_id: "fake",
    seed: 0,
    terminal_state: pass ? "DONE" : "DECLINED",
    pass,
    score: pass ? 1 : 0,
    reason: label,
    durationMs: 1,
    attempts: 1,
  };
}

test("runWithRetry: passes on first try → 1 attempt, no extra calls", async () => {
  let calls = 0;
  const r = await runWithRetry(2, async () => {
    calls += 1;
    return fakeResult(true, "first");
  });
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
  assert.equal(r.pass, true);
});

test("runWithRetry: passes on second attempt → 2 attempts", async () => {
  let calls = 0;
  const r = await runWithRetry(2, async () => {
    calls += 1;
    return fakeResult(calls >= 2, `attempt ${calls}`);
  });
  assert.equal(calls, 2);
  assert.equal(r.attempts, 2);
  assert.equal(r.pass, true);
  assert.equal(r.reason, "attempt 2");
});

test("runWithRetry: passes on third (final) attempt → 3 attempts", async () => {
  let calls = 0;
  const r = await runWithRetry(2, async () => {
    calls += 1;
    return fakeResult(calls >= 3, `attempt ${calls}`);
  });
  assert.equal(calls, 3);
  assert.equal(r.attempts, 3);
  assert.equal(r.pass, true);
  assert.equal(r.reason, "attempt 3");
});

test("runWithRetry: never passes → exhausts retries+1 attempts and returns the last failure", async () => {
  let calls = 0;
  const r = await runWithRetry(2, async () => {
    calls += 1;
    return fakeResult(false, `attempt ${calls}`);
  });
  assert.equal(calls, 3);
  assert.equal(r.attempts, 3);
  assert.equal(r.pass, false);
  assert.equal(r.reason, "attempt 3");
});

test("runWithRetry: retries=0 disables retries (1 attempt, fail returned as-is)", async () => {
  let calls = 0;
  const r = await runWithRetry(0, async () => {
    calls += 1;
    return fakeResult(false, "only");
  });
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
  assert.equal(r.pass, false);
});

test("runWithRetry: negative retries clamp to 0", async () => {
  let calls = 0;
  const r = await runWithRetry(-5, async () => {
    calls += 1;
    return fakeResult(false, "only");
  });
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
});

test("runWithRetry: non-integer retries are floored", async () => {
  let calls = 0;
  await runWithRetry(2.9, async () => {
    calls += 1;
    return fakeResult(false, "only");
  });
  assert.equal(calls, 3); // floor(2.9) + 1 = 3 attempts
});

test("runWithRetry: passes attempt number (0-indexed) into the callback", async () => {
  const seen: number[] = [];
  await runWithRetry(2, async (attempt) => {
    seen.push(attempt);
    return fakeResult(false, "fail");
  });
  assert.deepEqual(seen, [0, 1, 2]);
});

test("defaultRetriesForSlice: easy is 2; every other slice is 0", () => {
  assert.equal(defaultRetriesForSlice("easy"), 2);
  assert.equal(defaultRetriesForSlice("hard"), 0);
  assert.equal(defaultRetriesForSlice("medium"), 0);
  assert.equal(defaultRetriesForSlice("nonexistent-slice"), 0);
  // SLICE_RETRIES is the source of truth for non-default values.
  assert.equal(SLICE_RETRIES.easy, 2);
});
