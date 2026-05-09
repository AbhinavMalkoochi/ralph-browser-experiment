// Verifier framework types (US-005).
//
// Every task ships with a verifier spec. After an agent finishes a task, the
// harness runs the verifier against (task, browser, trajectory) and produces a
// Verdict. The verdict is then logged into the trajectory for audit.
//
// Three verifier kinds:
//   - "js"                    Run an expression inside the page via CDP
//                             Runtime.evaluate. Preferred for state-of-page
//                             checks (e.g. window.__test.success === true).
//   - "trajectory_predicate"  Run a JS expression in Node against the
//                             trajectory's recorded steps (no browser call).
//                             Useful when the verifier wants to assert on the
//                             agent's actions rather than final page state.
//   - "llm_judge"             Sample an LLM (temp=0, n=3 majority vote) for
//                             tasks tagged judge_required.
//
// Verifier specs are validated at task load (loader.ts) so that a malformed
// task yaml fails fast rather than at run time.

import type { Trajectory } from "../agent/trajectory.js";
import type { BrowserSession, VerifierVerdict } from "../agent/types.js";
import type { LLMClient } from "../llm/client.js";

export type Verdict = VerifierVerdict;

export type Difficulty = "easy" | "medium" | "hard";

export type VerifierKind = "js" | "trajectory_predicate" | "llm_judge";

/** "Programmatic" = JS or trajectory_predicate. Not LLM. */
export const PROGRAMMATIC_KINDS: readonly VerifierKind[] = ["js", "trajectory_predicate"];

export interface JsVerifierSpec {
  kind: "js";
  /**
   * Expression evaluated in the page (Runtime.evaluate, returnByValue=true,
   * awaitPromise=true). May resolve to:
   *   - boolean        -> {pass, score: pass?1:0, reason: "js: <bool>"}
   *   - VerdictShape   -> {pass, score, reason} forwarded
   * Anything else -> {pass:false, reason: "js: unexpected return shape"}.
   */
  expression: string;
}

export interface TrajectoryPredicateSpec {
  kind: "trajectory_predicate";
  /**
   * JS source compiled with `new Function('traj', expression)`. `traj` is
   * `{steps, llmCalls, metadata}` (see traj snapshot in runner.ts). May
   * return boolean or {pass, score, reason}.
   */
  expression: string;
}

export interface LlmJudgeSpec {
  kind: "llm_judge";
  /** Plain-language pass/fail question shown to the judge. */
  question: string;
  /** Model id, defaults to "gpt-4o-mini" if absent. Must be a priced model. */
  model?: string;
  /**
   * Optional inputs passed to the judge alongside the trajectory snapshot.
   * Primarily a hook so future task authors can inject expected answers.
   */
  expected?: string;
}

export type VerifierSpec = JsVerifierSpec | TrajectoryPredicateSpec | LlmJudgeSpec;

export interface Task {
  id: string;
  goal: string;
  start_url: string;
  difficulty: Difficulty;
  tags: string[];
  verifier: VerifierSpec;
}

/** Context handed to a Verifier. Some kinds use only a subset. */
export interface VerifyContext {
  /** Live session; required for `js` verifiers. */
  browser?: BrowserSession;
  /** Open trajectory for recording the verdict. May be null in tests. */
  trajectory?: Trajectory | null;
  /**
   * Filesystem path the trajectory lives in (for sidecar verdict.json).
   * Defaults to `trajectory.dir` when trajectory is present.
   */
  trajectoryDir?: string;
  /** Required when running an `llm_judge` verifier. */
  llm?: LLMClient;
}

export interface RunVerifierOptions {
  /** Write verdict.json next to trajectory.jsonl.gz. Default true. */
  writeAuditFile?: boolean;
  /** Append a `verification` JSONL line into the trajectory. Default true. */
  recordIntoTrajectory?: boolean;
}

export interface Verifier {
  readonly kind: VerifierKind;
  verify(task: Task, ctx: VerifyContext): Promise<Verdict>;
}

export class InvalidTaskSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskSpecError";
  }
}

export class VerifierMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierMisuseError";
  }
}
