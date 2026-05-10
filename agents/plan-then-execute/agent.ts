// Plan-then-execute browser agent (US-014, first novel slot).
//
// Mechanism distinct from baseline-a11y-react:
//   - ONE LLM call emits the WHOLE plan upfront (a JSON array of ops),
//     rather than one LLM turn per step.
//   - Selectors are intent-keyed text (visible link copy, button label,
//     input label/placeholder, body-text snippet) resolved INSIDE the
//     page by the executor in script.ts. The LLM never tracks integer
//     aids across turns and never sees a numbered element list.
//   - A bounded "repair" loop kicks in only when an op hard-fails: the
//     agent asks the LLM for a NEW remaining plan from the current page,
//     then continues. With no failures, the whole task is one LLM call.
//
// Trade-off vs the ReAct baseline: fewer LLM turns and lower latency on
// straight-line tasks, at the cost of mid-plan steering. The repair
// branch is the safety valve.

import {
  Agent,
  type AgentContext,
} from "../../harness/ts/agent/agent.js";
import { Trajectory } from "../../harness/ts/agent/trajectory.js";
import {
  Budget,
  BudgetExceeded,
  type BrowserSession,
} from "../../harness/ts/agent/types.js";
import { SessionTimeoutError } from "../../harness/ts/cdp/pool.js";
import {
  defaultClient,
  LLMProviderUnavailableError,
  LLMReplayMissError,
  type LLMClient,
  type LLMMessage,
} from "../../harness/ts/llm/index.js";

import {
  classify,
  executePlanOp,
  opLabel,
  opToRecord,
  parsePlan,
  PlanParseError,
  type OpResult,
  type PlanOp,
} from "./script.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_OPS = 14;
export const DEFAULT_MAX_REPAIRS = 2;

const SYSTEM_PROMPT = `You are an autonomous browser agent that PLANS BEFORE ACTING.

You receive a goal and a short observation of the current page (URL + title).
Emit a complete, ordered PLAN as a JSON array of operations. Selectors are
intent-keyed text — visible link copy, button label, input label or
placeholder. You never reference CSS selectors, xpath, or element ids; the
executor resolves text → element in the page at run time.

Operation schema (one JSON object per array entry):

  {"op": "goto",          "url": "https://..."}
  {"op": "click_text",    "text": "<visible label or link copy>"}
  {"op": "type",          "label": "<input label or placeholder>", "value": "<text>", "submit": true|false}
  {"op": "wait_for_text", "text": "<text that should appear>",     "timeout_ms": 3000}
  {"op": "assert_text",   "text": "<text that proves the goal is met>"}
  {"op": "scroll",        "direction": "down" | "up",              "pixels": 600}
  {"op": "extract",       "query": "<keywords to harvest from the page>"}
  {"op": "finish",        "reason": "<why the goal is met>"}

Rules:
- Output ONLY a JSON ARRAY of plan operations. No prose, no fences.
- End every plan with a "finish" op.
- Prefer "assert_text" or "extract" to verify the goal before "finish".
- Keep the plan tight — typically 3–8 ops.
- When repairing, re-emit ONLY the REMAINING plan from the current page;
  do not repeat work already done.`;

export interface PlanThenExecuteOpts {
  /** Override LLM construction. Default uses defaultClient(env). */
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  /** Override the model name. Defaults to gpt-4o-mini. */
  model?: string;
  /** Cap on total executed ops across all plans for this run. */
  maxOps?: number;
  /** Number of repair LLM calls allowed after the initial plan. */
  maxRepairs?: number;
}

interface HistoryItem {
  label: string;
  ok: boolean;
  message: string;
}

interface Observation {
  url: string;
  title: string;
}

interface RepairContext {
  failedOp: PlanOp;
  failureMessage: string;
}

export default class PlanThenExecuteAgent extends Agent {
  readonly id = "plan-then-execute";

  private readonly opts: PlanThenExecuteOpts;

  constructor(opts: PlanThenExecuteOpts = {}) {
    super();
    this.opts = opts;
  }

  async run(
    goal: string,
    browser: BrowserSession,
    budget: Budget,
    ctx: AgentContext,
  ): Promise<Trajectory> {
    const trajectory = await Trajectory.open(
      { runsRoot: ctx.runs_root, agent: this.id, task: ctx.task_id, seed: ctx.seed },
      { agent_id: this.id, task_id: ctx.task_id, seed: ctx.seed },
    );

    const factory =
      this.opts.llmFactory ??
      ((b, t) => defaultClient({ budget: b, trajectory: t, paradigmSeed: this.id }));
    const llm = factory(budget, trajectory);
    const model = this.opts.model ?? DEFAULT_MODEL;
    const maxOps = this.opts.maxOps ?? DEFAULT_MAX_OPS;
    const maxRepairs = this.opts.maxRepairs ?? DEFAULT_MAX_REPAIRS;

    const history: HistoryItem[] = [];
    let stepIdx = 0;
    let executed = 0;
    let repairs = 0;

    try {
      budget.check();
      const initialObs = await snapshotObservation(browser);

      let plan: PlanOp[];
      try {
        plan = await requestPlan(llm, model, goal, initialObs, history, budget);
      } catch (err) {
        const handled = await maybeFinishOnLlmError(err, trajectory);
        if (handled) return trajectory;
        throw err;
      }

      stepIdx += 1;
      await trajectory.addStep({
        step: stepIdx,
        observation_summary: observationSummary(initialObs),
        action: { type: "plan", phase: "initial", ops: plan.map(planOpRecord), n_ops: plan.length },
        latency_ms: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        screenshot_path: null,
        verifier_state: null,
      });

      while (true) {
        if (plan.length === 0) {
          await trajectory.finish({
            terminal_state: "DECLINED",
            decline_reason: "empty plan",
          });
          return trajectory;
        }

        let failure: { op: PlanOp; result: OpResult } | null = null;

        for (const op of plan) {
          if (executed >= maxOps) break;
          budget.check();
          executed += 1;
          stepIdx += 1;

          const t0 = Date.now();
          const result = await executePlanOp(op, browser);
          const latency = Date.now() - t0;

          await trajectory.addStep({
            step: stepIdx,
            observation_summary: `op=${opLabel(op)}`,
            action: opToRecord(op, result),
            latency_ms: latency,
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            screenshot_path: null,
            verifier_state: null,
          });
          budget.recordStep();
          history.push({ label: opLabel(op), ok: result.ok, message: result.message });

          if (op.op === "finish" && result.ok) {
            await trajectory.finish({ terminal_state: "DONE" });
            return trajectory;
          }

          const outcome = classify(op, result);
          if (outcome === "hard_fail") {
            failure = { op, result };
            break;
          }
        }

        if (executed >= maxOps) {
          await trajectory.finish({
            terminal_state: "DECLINED",
            decline_reason: `max ops (${maxOps}) exceeded`,
          });
          return trajectory;
        }

        if (!failure) {
          // Plan exhausted without a hard fail and without finish. Treat
          // as DONE; the verifier decides whether the goal was actually met.
          await trajectory.finish({
            terminal_state: "DONE",
            decline_reason: "plan completed without explicit finish op",
          });
          return trajectory;
        }

        if (repairs >= maxRepairs) {
          await trajectory.finish({
            terminal_state: "DECLINED",
            decline_reason: `repair budget exhausted after ${repairs} attempt(s); last failure: ${opLabel(failure.op)} → ${truncate(failure.result.message, 200)}`,
          });
          return trajectory;
        }

        repairs += 1;
        budget.check();
        const failureObs = await snapshotObservation(browser);
        let repairPlan: PlanOp[];
        try {
          repairPlan = await requestPlan(llm, model, goal, failureObs, history, budget, {
            failedOp: failure.op,
            failureMessage: failure.result.message,
          });
        } catch (err) {
          const handled = await maybeFinishOnLlmError(err, trajectory);
          if (handled) return trajectory;
          throw err;
        }

        stepIdx += 1;
        await trajectory.addStep({
          step: stepIdx,
          observation_summary: observationSummary(failureObs),
          action: {
            type: "plan",
            phase: "repair",
            attempt: repairs,
            failed_op: opLabel(failure.op),
            failure_reason: truncate(failure.result.message, 200),
            ops: repairPlan.map(planOpRecord),
            n_ops: repairPlan.length,
          },
          latency_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });

        plan = repairPlan;
      }
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        if (!trajectory.isFinished) {
          await trajectory.finish({
            terminal_state: "BUDGET_EXCEEDED",
            decline_reason: err.message,
          });
        }
        return trajectory;
      }
      if (err instanceof SessionTimeoutError) {
        if (!trajectory.isFinished) {
          await trajectory.finish({
            terminal_state: "SESSION_TIMEOUT",
            decline_reason: err.message,
          });
        }
        return trajectory;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!trajectory.isFinished) {
        await trajectory.finish({ terminal_state: "ERROR", decline_reason: msg });
      }
      return trajectory;
    }
  }
}

async function snapshotObservation(browser: BrowserSession): Promise<Observation> {
  try {
    const r = await browser.evaluate<Observation>(
      `(() => ({url: location.href, title: document.title || ''}))()`,
    );
    return {
      url: typeof r?.url === "string" ? r.url : "",
      title: typeof r?.title === "string" ? r.title : "",
    };
  } catch {
    return { url: "", title: "" };
  }
}

function observationSummary(obs: Observation): string {
  return `url=${truncate(obs.url || "(blank)", 80)} title=${truncate(obs.title || "(none)", 60)}`;
}

async function requestPlan(
  llm: LLMClient,
  model: string,
  goal: string,
  obs: Observation,
  history: HistoryItem[],
  budget: Budget,
  repair?: RepairContext,
): Promise<PlanOp[]> {
  budget.check();
  const messages = buildMessages(goal, obs, history, repair);
  const r = await llm.call(model, messages, { temperature: 0 });
  budget.check();
  try {
    return parsePlan(r.text);
  } catch (firstErr) {
    if (!(firstErr instanceof PlanParseError)) throw firstErr;
    // Single retry: tell the LLM the previous reply was malformed.
    const retryMessages: LLMMessage[] = [
      ...messages,
      { role: "assistant", content: r.text.slice(0, 4000) },
      {
        role: "user",
        content: `Your previous reply was not a valid plan: ${firstErr.message}. Re-emit ONLY a JSON array of operations. End with finish.`,
      },
    ];
    budget.check();
    const r2 = await llm.call(model, retryMessages, { temperature: 0 });
    return parsePlan(r2.text);
  }
}

function buildMessages(
  goal: string,
  obs: Observation,
  history: HistoryItem[],
  repair?: RepairContext,
): LLMMessage[] {
  const obsBlock = `Current page:\n  URL: ${obs.url || "(blank)"}\n  Title: ${obs.title || "(none)"}`;
  let user: string;
  if (repair) {
    const recent = history.slice(-8);
    const historyText =
      recent.length === 0
        ? "(no prior ops)"
        : recent
            .map((h, i) => `${i + 1}. ${h.label} → ${h.ok ? "ok" : "fail"}: ${truncate(h.message, 100)}`)
            .join("\n");
    user =
      `Goal: ${goal.trim()}\n\n` +
      `History so far:\n${historyText}\n\n` +
      `The last op failed:\n  ${opLabel(repair.failedOp)}\n  reason: ${truncate(repair.failureMessage, 200)}\n\n` +
      `${obsBlock}\n\n` +
      `Emit the REMAINING plan as a JSON array of operations starting from the current page. End with finish.`;
  } else {
    user =
      `Goal: ${goal.trim()}\n\n` +
      `${obsBlock}\n\n` +
      `Emit the FULL plan as a JSON array of operations. End with finish.`;
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/**
 * Convert LLM-error-shaped failures into a clean DECLINED trajectory.
 * Returns true if the trajectory was finished (caller should return).
 */
async function maybeFinishOnLlmError(err: unknown, trajectory: Trajectory): Promise<boolean> {
  if (err instanceof LLMProviderUnavailableError) {
    await trajectory.finish({
      terminal_state: "DECLINED",
      decline_reason: "no LLM provider configured",
    });
    return true;
  }
  if (err instanceof LLMReplayMissError) {
    await trajectory.finish({
      terminal_state: "DECLINED",
      decline_reason: `LLM replay miss: ${err.message}`,
    });
    return true;
  }
  if (err instanceof PlanParseError) {
    await trajectory.finish({
      terminal_state: "DECLINED",
      decline_reason: `plan parse error: ${err.message}`,
    });
    return true;
  }
  return false;
}

function planOpRecord(op: PlanOp): Record<string, unknown> {
  const rec: Record<string, unknown> = { op: op.op };
  switch (op.op) {
    case "goto":
      rec.url = op.url;
      break;
    case "click_text":
      rec.text = op.text;
      break;
    case "type":
      rec.label = op.label;
      rec.value = op.value;
      if (op.submit) rec.submit = true;
      break;
    case "wait_for_text":
      rec.text = op.text;
      if (op.timeout_ms !== undefined) rec.timeout_ms = op.timeout_ms;
      break;
    case "assert_text":
      rec.text = op.text;
      break;
    case "scroll":
      rec.direction = op.direction;
      if (op.pixels !== undefined) rec.pixels = op.pixels;
      break;
    case "extract":
      rec.query = op.query;
      break;
    case "finish":
      rec.reason = op.reason;
      break;
  }
  if (op.thought !== undefined) rec.thought = op.thought;
  return rec;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
