// predicate-driven browser agent (US-017, fourth novel slot).
//
// Distinguishing mechanism: the LLM authors a JS PREDICATE upfront that
// evaluates to TRUE in the page when the goal is satisfied. The agent loop
// terminates from CODE the moment the predicate holds — the LLM never emits
// a `finish` action and cannot lie about completion. Compared to:
//
//   - baseline-a11y-react: LLM emits `finish` to terminate.
//   - plan-then-execute:   plan terminates after its last op runs.
//   - runtime-codegen:     in-page IIFE returns {done:true}.
//   - speculative-rollback: a separate JUDGE LLM declares `done`.
//
// This agent is the only one whose termination is owned by code that runs in
// the page itself. The shape is closer to test-driven development: synthesise
// the test first, then iteratively mutate state until the test passes.
//
// Failure mode addressed: prior agents' trajectories show several variants
// of "LLM thought it was done, but the goal page state never actually
// landed" (e.g. recoverable-failure: clicks submit, page shows error, LLM
// finishes anyway thinking the second click stuck). With a predicate the
// loop simply does not exit until the page-state probe fires true.
//
// Cost shape: 1 synthesis call + 1 action call per step + 1 evaluate per
// step. Predicate evaluation is pure JS in-page (no LLM), so it is cheap.

import { Agent, type AgentContext } from "../../harness/ts/agent/agent.js";
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
  ActionParseError,
  actionLabel,
  executeAction,
  parseAction,
  type ActionResult,
  type AgentAction,
} from "./actions.js";
import {
  digestObservation,
  formatObservation,
  observePage,
  type PageObservation,
} from "./observe.js";
import {
  PredicateParseError,
  evaluatePredicate,
  parsePredicate,
} from "./predicate.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 10;
const HISTORY_LIMIT = 5;

const PREDICATE_PROMPT = `You are the PREDICATE-SYNTHESISER half of a predicate-driven browser
agent. Given the goal and an observation of the starting page, emit a single
JavaScript expression that returns TRUE in the live page when the goal is
SATISFIED, and FALSE otherwise. The harness will poll your expression in the
page after every action; the agent terminates as soon as it returns TRUE.

Reply with ONLY this JSON object:

  {"predicate": "<expression>", "rationale": "<one sentence>"}

Predicate guidance:
- The expression runs as the body of an async IIFE wrapped in Boolean(), so
  any JS expression that returns a value (or a Promise of one) works:
  document.* DOM queries, fetch() against same-origin endpoints, shadowRoot
  traversal, querySelectorAll length checks, regex matching against
  innerText. You may use \`await\` in your expression because the IIFE is async.
- Prefer SPECIFIC, OBSERVABLE evidence. "the URL contains /done" or
  "document.body.innerText includes 'submission accepted'" are good. "the
  user clicked submit" is bad — the predicate must look at PAGE state.
- AVOID predicates that are true at the START. The harness checks BEFORE
  every action including the first one; an over-eager predicate finishes
  the run with no work done.
- Be defensive: wrap brittle accesses (\`document.querySelector(...).value\`)
  in optional chaining or short-circuiting (\`document.querySelector(...)?.value === 'X'\`).
- The expression MUST be valid JavaScript. Do NOT include surrounding
  function declarations or \`return\` keywords; just the expression.`;

const ACTION_PROMPT = `You are the ACTION-PICKER half of a predicate-driven browser agent. The
loop has a fixed termination: a previously-synthesised predicate is checked
in-page after every action. You do NOT see the predicate text — it is not
your concern. Your job is to look at the goal and the current page and pick
the next move that will plausibly bring the page closer to a state in which
the predicate would hold.

Crucially: there is NO finish action. You can never declare the goal met.
If you believe the goal is already satisfied, pick the safest no-op
(\`wait\` with a small ms) — the harness will detect completion via the
predicate on the next iteration. Hallucinating completion just wastes a step.

Reply with ONLY this JSON object:

  {"type": "click",    "selector": "<css>",            "thought": "<short>"}
  {"type": "type",     "selector": "<css>", "text": "<value>", "submit": true|false}
  {"type": "scroll",   "direction": "up" | "down", "pixels": 600}
  {"type": "wait",     "ms": 500}
  {"type": "navigate", "url": "https://..."}

Rules:
- Output ONLY the JSON object. No prose, no fences.
- Selectors are raw CSS — prefer the snapshot's selector_hint when one is
  offered.
- For forms whose submit button is the natural next step, use
  type with submit:true rather than a follow-up click.
- Use wait sparingly; the harness has a step budget.`;

export interface PredicateDrivenOpts {
  /** Inject an LLM client (used by tests). Default: defaultClient(env). */
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  /** Model name. Defaults to gpt-4o-mini. */
  model?: string;
  /** Loop step cap. Each step issues 1 action LLM call + 1 predicate evaluate. */
  maxSteps?: number;
}

interface HistoryItem {
  label: string;
  result: ActionResult;
  predicateAfter: { satisfied: boolean; error?: string };
}

export default class PredicateDrivenAgent extends Agent {
  readonly id = "predicate-driven";

  private readonly opts: PredicateDrivenOpts;

  constructor(opts: PredicateDrivenOpts = {}) {
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
      ((b, t) =>
        defaultClient({ budget: b, trajectory: t, paradigmSeed: this.id }));
    const llm = factory(budget, trajectory);
    const model = this.opts.model ?? DEFAULT_MODEL;
    const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;

    let predicateExpr: string | null = null;
    const history: HistoryItem[] = [];

    try {
      // Initial observation drives predicate synthesis.
      const initialObs = await safeObserve(browser);

      // ----- 1) Synthesise the predicate -----
      budget.check();
      const synthMessages = buildSynthMessages(goal, initialObs);
      let synthCompletion: string;
      const tSynth = Date.now();
      try {
        const r = await llm.call(model, synthMessages, { temperature: 0 });
        synthCompletion = r.text;
      } catch (err) {
        if (await declineOnLlmError(err, trajectory, 0, initialObs, Date.now() - tSynth, "synthesise")) {
          return trajectory;
        }
        throw err;
      }
      const synthLatency = Date.now() - tSynth;

      try {
        const parsed = parsePredicate(synthCompletion);
        predicateExpr = parsed.expression;
        await trajectory.addStep({
          step: 0,
          observation_summary: digestObservation(initialObs),
          action: {
            type: "synthesise_predicate",
            predicate: predicateExpr,
            rationale: parsed.rationale ?? null,
          },
          latency_ms: synthLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
      } catch (err) {
        const msg = err instanceof PredicateParseError ? err.message : String(err);
        await trajectory.addStep({
          step: 0,
          observation_summary: digestObservation(initialObs),
          action: {
            type: "synthesise_predicate_failed",
            raw: synthCompletion.slice(0, 200),
            error: msg,
          },
          latency_ms: synthLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        await trajectory.finish({
          terminal_state: "DECLINED",
          decline_reason: `predicate synthesis failed: ${msg}`,
        });
        return trajectory;
      }

      // ----- 2) Pre-check predicate before any action -----
      const initialCheck = await evaluatePredicate(predicateExpr, browser);
      if (initialCheck.satisfied) {
        await trajectory.addStep({
          step: 0,
          observation_summary: digestObservation(initialObs),
          action: {
            type: "predicate_check",
            satisfied: true,
            phase: "initial",
          },
          latency_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        await trajectory.finish({ terminal_state: "DONE" });
        return trajectory;
      }

      // ----- 3) Action loop -----
      let step = 0;
      while (step < maxSteps) {
        budget.check();
        step += 1;

        const obs = await safeObserve(browser);

        const actionMessages = buildActionMessages(goal, obs, history);
        let completion: string;
        const t0 = Date.now();
        try {
          const r = await llm.call(model, actionMessages, { temperature: 0 });
          completion = r.text;
        } catch (err) {
          if (await declineOnLlmError(err, trajectory, step, obs, Date.now() - t0, "action")) {
            return trajectory;
          }
          throw err;
        }
        const llmLatency = Date.now() - t0;

        let action: AgentAction;
        try {
          action = parseAction(completion);
        } catch (err) {
          const msg = err instanceof ActionParseError ? err.message : String(err);
          await trajectory.addStep({
            step,
            observation_summary: digestObservation(obs),
            action: {
              type: "parse_error",
              raw: completion.slice(0, 200),
              error: msg,
            },
            latency_ms: llmLatency,
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            screenshot_path: null,
            verifier_state: null,
          });
          history.push({
            label: "(parse_error)",
            result: { ok: false, message: `parse error: ${msg}` },
            predicateAfter: { satisfied: false, error: "skipped" },
          });
          continue;
        }

        const tExec = Date.now();
        let result: ActionResult;
        try {
          result = await executeAction(action, browser);
        } catch (err) {
          result = {
            ok: false,
            message: `execute threw: ${truncate(err instanceof Error ? err.message : String(err), 200)}`,
          };
        }
        const execLatency = Date.now() - tExec;

        // Re-evaluate the predicate against the post-action page.
        const check = await evaluatePredicate(predicateExpr, browser);

        await trajectory.addStep({
          step,
          observation_summary: digestObservation(obs),
          action: {
            ...actionToRecord(action, result),
            predicate_satisfied: check.satisfied,
            predicate_error: check.error ?? null,
          },
          latency_ms: execLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        budget.recordStep();

        history.push({
          label: actionLabel(action),
          result,
          predicateAfter: check,
        });

        if (check.satisfied) {
          await trajectory.finish({ terminal_state: "DONE" });
          return trajectory;
        }
      }

      await trajectory.finish({
        terminal_state: "DECLINED",
        decline_reason: `max steps (${maxSteps}) exhausted with predicate still false`,
      });
      return trajectory;
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

async function safeObserve(browser: BrowserSession): Promise<PageObservation> {
  try {
    return await observePage(browser);
  } catch (err) {
    return {
      url: "",
      title: "",
      text: `(observation failed: ${err instanceof Error ? err.message : String(err)})`,
      buttons: [],
      inputs: [],
      counts: {
        a: 0,
        button: 0,
        input: 0,
        select: 0,
        textarea: 0,
        iframe: 0,
        canvas: 0,
        shadow_hosts: 0,
        forms: 0,
        modals: 0,
      },
      seq: 0,
    };
  }
}

function buildSynthMessages(goal: string, obs: PageObservation): LLMMessage[] {
  const user =
    `Goal: ${goal.trim()}\n\n` +
    `Initial page:\n${formatObservation(obs)}\n\n` +
    `Reply with the predicate JSON object.`;
  return [
    { role: "system", content: PREDICATE_PROMPT },
    { role: "user", content: user },
  ];
}

function buildActionMessages(
  goal: string,
  obs: PageObservation,
  history: HistoryItem[],
): LLMMessage[] {
  const recent = history.slice(-HISTORY_LIMIT);
  const historyText =
    recent.length === 0
      ? "(no prior actions)"
      : recent
          .map((h, i) => {
            const ok = h.result.ok ? "ok" : "fail";
            const pred = h.predicateAfter.satisfied
              ? "PRED=true"
              : h.predicateAfter.error
                ? `PRED=err(${truncate(h.predicateAfter.error, 60)})`
                : "PRED=false";
            return `${i + 1}. ${h.label} → ${ok}: ${truncate(h.result.message, 100)} [${pred}]`;
          })
          .join("\n");
  const user =
    `Goal: ${goal.trim()}\n\n` +
    `Recent actions (with predicate verdict afterward):\n${historyText}\n\n` +
    `Current page:\n${formatObservation(obs)}\n\n` +
    `Reply with the next action as a single JSON object. Remember: there is ` +
    `NO finish action; the harness terminates the loop when the predicate ` +
    `evaluates true.`;
  return [
    { role: "system", content: ACTION_PROMPT },
    { role: "user", content: user },
  ];
}

function actionToRecord(
  action: AgentAction,
  result: ActionResult,
): { type: string } & Record<string, unknown> {
  const base: { type: string } & Record<string, unknown> = {
    type: action.type,
    ok: result.ok,
    result: result.message,
    label: actionLabel(action),
  };
  if ("thought" in action && action.thought !== undefined) base.thought = action.thought;
  if (action.type === "click") base.selector = action.selector;
  if (action.type === "type") {
    base.selector = action.selector;
    base.text = action.text;
    if (action.submit) base.submit = true;
  }
  if (action.type === "scroll") {
    base.direction = action.direction;
    if (action.pixels !== undefined) base.pixels = action.pixels;
  }
  if (action.type === "wait") base.ms = action.ms;
  if (action.type === "navigate") base.url = action.url;
  return base;
}

async function declineOnLlmError(
  err: unknown,
  trajectory: Trajectory,
  step: number,
  obs: PageObservation,
  latency: number,
  phase: "synthesise" | "action",
): Promise<boolean> {
  if (err instanceof LLMProviderUnavailableError) {
    await trajectory.addStep({
      step,
      observation_summary: digestObservation(obs),
      action: { type: "noop", reason: "no LLM provider configured", phase },
      latency_ms: latency,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      screenshot_path: null,
      verifier_state: null,
    });
    await trajectory.finish({
      terminal_state: "DECLINED",
      decline_reason: "no LLM provider configured",
    });
    return true;
  }
  if (err instanceof LLMReplayMissError) {
    await trajectory.addStep({
      step,
      observation_summary: digestObservation(obs),
      action: { type: "noop", reason: "LLM replay miss", phase },
      latency_ms: latency,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      screenshot_path: null,
      verifier_state: null,
    });
    await trajectory.finish({
      terminal_state: "DECLINED",
      decline_reason: `LLM replay miss: ${err.message}`,
    });
    return true;
  }
  return false;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
