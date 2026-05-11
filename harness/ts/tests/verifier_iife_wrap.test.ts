// Regression test for the verifier expression wrapping fix.
//
// The hard-app slice's multi-line `|` YAML block-scalar verifiers terminate
// with `})();` plus a trailing newline (idiomatic JS for self-invoking
// IIFEs). The verifier's wrapForRuntimeEvaluate used to concatenate this
// directly inside `(async () => (EXPR))()`, which produces `(...);)` —
// not a legal JS expression. Runtime.evaluate then surfaced a
// SyntaxError as the only failure signal (`js verifier threw: Uncaught`),
// so EVERY hard-app cell failed at the verifier stage even when the
// underlying state was correct.
//
// This test fixes the regression vector: a bare IIFE expression with a
// trailing `;` MUST resolve to its return value, not a SyntaxError.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Trajectory } from "../agent/trajectory.js";
import { verify } from "../verifier/runner.js";
import type { Task } from "../verifier/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ephemeralTask(expression: string): Task {
  return {
    id: "verifier-wrap-smoke",
    goal: "verifier wrap regression",
    start_url: "about:blank",
    difficulty: "easy",
    tags: ["js_verifier", "smoke"],
    verifier: { kind: "js", expression },
  };
}

test("js verifier: bare boolean expression (legacy single-line shape)", async () => {
  const session = await CdpBrowserSession.create();
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const task = ephemeralTask("1 + 1 === 2");
    await session.navigate("about:blank");
    const traj = await Trajectory.open(
      { runsRoot, agent: "wrap-test", task: task.id, seed: 0 },
      { agent_id: "wrap-test", task_id: task.id, seed: 0 },
    );
    const v = await verify(task, { browser: session, trajectory: traj });
    await traj.finish({ terminal_state: "DONE" });
    assert.equal(v.pass, true);
    assert.equal(v.score, 1);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("js verifier: IIFE expression with trailing semicolon (hard-app shape) does NOT throw", async () => {
  const session = await CdpBrowserSession.create();
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    // The literal YAML `|` block scalar shape: trailing `};` plus a
    // newline. Without the wrap fix, this surfaces as
    // `js verifier threw: Uncaught` (SyntaxError: Unexpected token ';').
    const task = ephemeralTask(
      "(async () => {\n  return { pass: true, score: 1, reason: 'ok' };\n})();\n",
    );
    await session.navigate("about:blank");
    const traj = await Trajectory.open(
      { runsRoot, agent: "wrap-test", task: task.id, seed: 0 },
      { agent_id: "wrap-test", task_id: task.id, seed: 0 },
    );
    const v = await verify(task, { browser: session, trajectory: traj });
    await traj.finish({ terminal_state: "DONE" });
    assert.equal(v.pass, true);
    assert.equal(v.score, 1);
    assert.equal(v.reason, "ok");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("js verifier: IIFE with multiple trailing semicolons + whitespace still wraps cleanly", async () => {
  const session = await CdpBrowserSession.create();
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const task = ephemeralTask(
      "(async () => ({ pass: false, score: 0, reason: 'expected-fail' }))(); ;\n  \n",
    );
    await session.navigate("about:blank");
    const traj = await Trajectory.open(
      { runsRoot, agent: "wrap-test", task: task.id, seed: 0 },
      { agent_id: "wrap-test", task_id: task.id, seed: 0 },
    );
    const v = await verify(task, { browser: session, trajectory: traj });
    await traj.finish({ terminal_state: "DONE" });
    assert.equal(v.pass, false);
    assert.equal(v.reason, "expected-fail");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});
