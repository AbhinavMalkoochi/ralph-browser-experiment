// Verifier dispatcher + audit logger.
//
// `verify(task, ctx, opts)` constructs the right Verifier from the task spec,
// runs it, optionally records a `verification` line into the open trajectory,
// and optionally writes a verdict.json sidecar in the trajectory directory.
//
// The two side-effects are independently controllable so unit tests can opt
// out, but the default is "log everywhere reasonable for audit".

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { JsVerifier, TrajectoryPredicateVerifier } from "./programmatic.js";
import { LlmJudgeVerifier } from "./llm_judge.js";
import {
  type RunVerifierOptions,
  type Task,
  type Verdict,
  type Verifier,
  type VerifierSpec,
  type VerifyContext,
} from "./types.js";

export function makeVerifier(spec: VerifierSpec): Verifier {
  switch (spec.kind) {
    case "js":
      return new JsVerifier(spec);
    case "trajectory_predicate":
      return new TrajectoryPredicateVerifier(spec);
    case "llm_judge":
      return new LlmJudgeVerifier(spec);
  }
}

export async function verify(
  task: Task,
  ctx: VerifyContext,
  opts: RunVerifierOptions = {},
): Promise<Verdict> {
  const verifier = makeVerifier(task.verifier);
  const verdict = await verifier.verify(task, ctx);
  const recordIntoTrajectory = opts.recordIntoTrajectory ?? true;
  const writeAuditFile = opts.writeAuditFile ?? true;
  if (recordIntoTrajectory && ctx.trajectory && !ctx.trajectory.isFinished) {
    await ctx.trajectory.recordVerification({
      pass: verdict.pass,
      score: verdict.score,
      reason: verdict.reason,
      verifier_kind: task.verifier.kind,
      verified_at: new Date().toISOString(),
    });
  }
  if (writeAuditFile) {
    const dir = ctx.trajectoryDir ?? ctx.trajectory?.dir;
    if (dir) await writeVerdictAudit(dir, task, verdict);
  }
  return verdict;
}

export async function writeVerdictAudit(
  trajectoryDir: string,
  task: Task,
  verdict: Verdict,
): Promise<string> {
  const target = join(trajectoryDir, "verdict.json");
  await mkdir(dirname(target), { recursive: true });
  const payload = {
    task_id: task.id,
    verifier_kind: task.verifier.kind,
    pass: verdict.pass,
    score: verdict.score,
    reason: verdict.reason,
    verified_at: new Date().toISOString(),
  };
  await writeFile(target, JSON.stringify(payload, null, 2) + "\n");
  return target;
}
