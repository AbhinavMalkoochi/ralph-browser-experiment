// TrajectoryPredicateVerifier and verdict audit/recording.
//
// Pure-Node tests: no Chrome, no LLM. Build a Trajectory in a temp dir,
// append steps, run the verifier, assert on both the returned Verdict and
// the audit side-effects (verdict.json + verification line in JSONL).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import { Trajectory } from "../agent/trajectory.js";
import { verify } from "../verifier/runner.js";
import type { Task, VerifyContext } from "../verifier/types.js";

async function readGzipLines(path: string): Promise<unknown[]> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  createReadStream(path).pipe(gunzip);
  for await (const chunk of gunzip) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function predicateTask(expression: string): Task {
  return {
    id: "predicate-test",
    goal: "do an action",
    start_url: "about:blank",
    difficulty: "easy",
    tags: ["test"],
    verifier: { kind: "trajectory_predicate", expression },
  };
}

test("trajectory_predicate: passes when predicate returns true", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const trajectory = await Trajectory.open(
      { runsRoot, agent: "a", task: "t", seed: 0 },
      { agent_id: "a", task_id: "t", seed: 0 },
    );
    await trajectory.addStep({
      step: 1,
      observation_summary: "saw a button",
      action: { type: "click", selector: "#go" },
      latency_ms: 10,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      screenshot_path: null,
      verifier_state: null,
    });
    const ctx: VerifyContext = { trajectory, trajectoryDir: trajectory.dir };
    const task = predicateTask("traj.steps.some(s => s.action.type === 'click')");
    const verdict = await verify(task, ctx);
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 1);

    // Verification line landed in trajectory before finish.
    await trajectory.finish({ terminal_state: "DONE" });
    const lines = await readGzipLines(trajectory.gzPath);
    const kinds = lines.map((l) => (l as { kind: string }).kind);
    assert.deepEqual(kinds, ["meta", "step", "verification", "end"]);
    const verification = lines[2] as { pass: boolean; verifier_kind: string };
    assert.equal(verification.pass, true);
    assert.equal(verification.verifier_kind, "trajectory_predicate");

    // The end line picked up the verdict from the verification, not null.
    const end = lines[3] as { verifier_verdict: { pass: boolean } | null };
    assert.ok(end.verifier_verdict);
    assert.equal(end.verifier_verdict.pass, true);

    // Verdict sidecar exists and parses.
    const sidecar = JSON.parse(await readFile(join(trajectory.dir, "verdict.json"), "utf8"));
    assert.equal(sidecar.pass, true);
    assert.equal(sidecar.task_id, "predicate-test");
    assert.equal(sidecar.verifier_kind, "trajectory_predicate");
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("trajectory_predicate: fails when no matching step", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const trajectory = await Trajectory.open(
      { runsRoot, agent: "a", task: "t2", seed: 0 },
      { agent_id: "a", task_id: "t2", seed: 0 },
    );
    await trajectory.addStep({
      step: 1,
      observation_summary: "noop",
      action: { type: "noop" },
      latency_ms: 1,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      screenshot_path: null,
      verifier_state: null,
    });
    const ctx: VerifyContext = { trajectory };
    const task = predicateTask("traj.steps.some(s => s.action.type === 'click')");
    const verdict = await verify(task, ctx, { writeAuditFile: false });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 0);
    await trajectory.finish({ terminal_state: "DONE" });
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("trajectory_predicate: returns object {pass, score, reason}", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const trajectory = await Trajectory.open(
      { runsRoot, agent: "a", task: "t3", seed: 0 },
      { agent_id: "a", task_id: "t3", seed: 0 },
    );
    const ctx: VerifyContext = { trajectory };
    const task = predicateTask(
      `({ pass: true, score: 0.5, reason: 'partial credit for trying' })`,
    );
    const verdict = await verify(task, ctx, { writeAuditFile: false });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 0.5);
    assert.equal(verdict.reason, "partial credit for trying");
    await trajectory.finish({ terminal_state: "DONE" });
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("trajectory_predicate: throwing predicate -> graceful fail", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const trajectory = await Trajectory.open(
      { runsRoot, agent: "a", task: "t4", seed: 0 },
      { agent_id: "a", task_id: "t4", seed: 0 },
    );
    const ctx: VerifyContext = { trajectory };
    const task = predicateTask(`(() => { throw new Error('boom'); })()`);
    const verdict = await verify(task, ctx, { writeAuditFile: false });
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /boom/);
    await trajectory.finish({ terminal_state: "DONE" });
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("verify: writeAuditFile false -> no verdict.json written", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const trajectory = await Trajectory.open(
      { runsRoot, agent: "a", task: "t5", seed: 0 },
      { agent_id: "a", task_id: "t5", seed: 0 },
    );
    await verify(predicateTask("true"), { trajectory }, { writeAuditFile: false });
    await assert.rejects(() => stat(join(trajectory.dir, "verdict.json")), /ENOENT/);
    await trajectory.finish({ terminal_state: "DONE" });
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});
