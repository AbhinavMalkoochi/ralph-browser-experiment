// Programmatic verifiers: JS (run in page) and trajectory_predicate (run in
// Node against the recorded trajectory). Both kinds normalise their result
// into a `Verdict`; downstream code never sees the raw expression return.

import {
  VerifierMisuseError,
  type JsVerifierSpec,
  type Task,
  type TrajectoryPredicateSpec,
  type Verdict,
  type Verifier,
  type VerifyContext,
} from "./types.js";

interface RuntimeEvaluateResult {
  result: { value?: unknown; type: string };
  exceptionDetails?: { text?: string };
}

export class JsVerifier implements Verifier {
  readonly kind = "js" as const;
  constructor(private readonly spec: JsVerifierSpec) {}

  async verify(_task: Task, ctx: VerifyContext): Promise<Verdict> {
    if (!ctx.browser) {
      throw new VerifierMisuseError("JsVerifier requires ctx.browser");
    }
    const expression = wrapForRuntimeEvaluate(this.spec.expression);
    const r = await ctx.browser.cdp.send<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      return {
        pass: false,
        score: 0,
        reason: `js verifier threw: ${r.exceptionDetails.text ?? "unknown"}`,
      };
    }
    return normaliseReturn("js", r.result.value);
  }
}

export class TrajectoryPredicateVerifier implements Verifier {
  readonly kind = "trajectory_predicate" as const;
  private readonly fn: (traj: TrajectorySnapshot) => unknown;
  constructor(spec: TrajectoryPredicateSpec) {
    // Loader has already validated this compiles, but compile here too so
    // we don't share state with the loader.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    this.fn = new Function("traj", `"use strict"; return (${spec.expression});`) as (
      traj: TrajectorySnapshot,
    ) => unknown;
  }

  async verify(_task: Task, ctx: VerifyContext): Promise<Verdict> {
    const snap = trajectorySnapshot(ctx);
    let value: unknown;
    try {
      value = this.fn(snap);
      if (value && typeof (value as { then?: unknown }).then === "function") {
        value = await (value as Promise<unknown>);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { pass: false, score: 0, reason: `trajectory_predicate threw: ${msg}` };
    }
    return normaliseReturn("trajectory_predicate", value);
  }
}

export interface TrajectorySnapshot {
  steps: Array<{ step: number; observation_summary: string; action: { type: string; [k: string]: unknown }; latency_ms: number; tokens_in: number; tokens_out: number; cost_usd: number; screenshot_path: string | null; verifier_state: Record<string, unknown> | null }>;
  llmCalls: Array<{ model: string; prompt_hash: string; prompt_tokens: number; completion_tokens: number; latency_ms: number; cost_usd: number; cached: boolean }>;
  metadata: {
    agent_id: string;
    task_id: string;
    seed: number;
    start_time: string;
    end_time: string | null;
    terminal_state: string | null;
    decline_reason: string | null;
  };
}

function trajectorySnapshot(ctx: VerifyContext): TrajectorySnapshot {
  if (!ctx.trajectory) {
    return {
      steps: [],
      llmCalls: [],
      metadata: {
        agent_id: "",
        task_id: "",
        seed: 0,
        start_time: "",
        end_time: null,
        terminal_state: null,
        decline_reason: null,
      },
    };
  }
  const m = ctx.trajectory.metadata;
  return {
    steps: ctx.trajectory.snapshotSteps(),
    llmCalls: ctx.trajectory.snapshotLlmCalls(),
    metadata: {
      agent_id: m.agent_id,
      task_id: m.task_id,
      seed: m.seed,
      start_time: m.start_time,
      end_time: m.end_time,
      terminal_state: m.terminal_state,
      decline_reason: m.decline_reason,
    },
  };
}

/**
 * The page expression may be either:
 *   - a bare expression (e.g. `window.foo === 1`)
 *   - a Promise-returning expression (e.g. `fetch('/x').then(r => r.json())`)
 *   - an IIFE that ends with a statement-terminating `;` (e.g. the multi-line
 *     `(async () => { ... })();` block scalars hard-app/hard-real verifiers use)
 * We wrap as `(async () => (EXPR))()` so awaitPromise picks it up uniformly,
 * stripping any trailing statement terminator first — `(expr);` is not a
 * valid expression in JS, so a naive concat would surface as
 * `SyntaxError: Unexpected token ';'` from Runtime.evaluate.
 */
function wrapForRuntimeEvaluate(expression: string): string {
  const trimmed = expression.replace(/[\s;]+$/, "");
  return `(async () => (${trimmed}))()`;
}

function normaliseReturn(kind: string, value: unknown): Verdict {
  if (typeof value === "boolean") {
    return {
      pass: value,
      score: value ? 1 : 0,
      reason: `${kind}: ${value}`,
    };
  }
  if (value && typeof value === "object" && "pass" in value) {
    const obj = value as { pass: unknown; score?: unknown; reason?: unknown };
    if (typeof obj.pass !== "boolean") {
      return { pass: false, score: 0, reason: `${kind}: returned object missing boolean "pass"` };
    }
    const score = typeof obj.score === "number" ? clamp01(obj.score) : obj.pass ? 1 : 0;
    const reason = typeof obj.reason === "string" ? obj.reason : `${kind}: ${obj.pass}`;
    return { pass: obj.pass, score, reason };
  }
  return {
    pass: false,
    score: 0,
    reason: `${kind}: unexpected return shape ${describe(value)}`,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}
