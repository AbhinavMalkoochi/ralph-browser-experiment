// Baseline A11y + ReAct browser agent (US-013).
//
// An honest reproduction of the dominant 2026 open-source pattern
// (browser-use, Stagehand, AgentE): each step takes an accessibility-
// flavoured snapshot of the current page, renders interactive elements
// as a numbered list, asks a single LLM to emit one action as JSON,
// executes it, and loops. Action set is intentionally small:
// click / type / scroll / wait / navigate / extract / finish.
//
// This agent is the *control* in every tournament — novel agents
// (US-014..U-021) declare distinctness against it, and the Pareto chart
// is read relative to its score.

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
  executeAction,
  parseAction,
  ActionParseError,
  type ActionResult,
  type AgentAction,
} from "./actions.js";
import {
  formatSnapshot,
  snapshotPage,
  type PageSnapshot,
} from "./snapshot.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 12;

const SYSTEM_PROMPT = `You are an autonomous browser agent. Each turn you receive
- the current page URL, title, a slice of body text, and a numbered list of
  interactive elements (each tagged with an integer aid).
- a brief history of actions you took and their results.

Reply with ONE compact JSON object describing the next action. Schema:

  {"action": "click",    "target": <aid>,           "thought": "<short>"}
  {"action": "type",     "target": <aid>, "text": "<value>", "submit": true|false}
  {"action": "scroll",   "direction": "up" | "down", "pixels": 600}
  {"action": "wait",     "ms": 500}
  {"action": "navigate", "url": "https://..."}
  {"action": "extract",  "query": "<keywords to look for in page text>"}
  {"action": "finish",   "reason": "<why the goal is met or unreachable>"}

Rules:
- Output ONLY the JSON object. No prose, no fences.
- Prefer "finish" the moment you believe the goal is met or you cannot proceed.
- Prefer "type" with submit:true for forms whose submit button is clearly the
  next aid; otherwise use a follow-up click.
- Use "wait" sparingly (e.g. for hydration); the harness has its own budget.
- Use "extract" when the goal asks for a fact and the page text already
  contains the answer.
- Always reference an element by its aid integer from the snapshot, NOT by
  CSS selector or xpath.`;

export interface BaselineOpts {
  /**
   * Override LLM construction. Default uses defaultClient(env) keyed off
   * OPENAI_API_KEY / GEMINI_API_KEY. Tests inject a mock provider.
   */
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  /** Override the model name. Defaults to gpt-4o-mini. */
  model?: string;
  /** Override the loop step cap. Defaults to 12 (under the easy budget step cap of 15). */
  maxSteps?: number;
}

export default class BaselineA11yReactAgent extends Agent {
  readonly id = "baseline-a11y-react";

  private readonly opts: BaselineOpts;

  constructor(opts: BaselineOpts = {}) {
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

    const factory = this.opts.llmFactory
      ?? ((b, t) => defaultClient({ budget: b, trajectory: t, paradigmSeed: this.id }));
    const llm = factory(budget, trajectory);
    const model = this.opts.model ?? DEFAULT_MODEL;
    const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;

    const history: HistoryItem[] = [];
    let step = 0;

    try {
      while (step < maxSteps) {
        budget.check();
        step += 1;

        const snapshot = await snapshotPage(browser);
        const observation = formatSnapshot(snapshot);

        const messages = buildMessages(goal, observation, history);
        const t0 = Date.now();
        let completion: string;
        try {
          const r = await llm.call(model, messages, { temperature: 0 });
          completion = r.text;
        } catch (err) {
          if (err instanceof LLMProviderUnavailableError) {
            await trajectory.addStep({
              step,
              observation_summary: shortObs(snapshot),
              action: { type: "noop", reason: "no LLM provider configured" },
              latency_ms: Date.now() - t0,
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
            return trajectory;
          }
          if (err instanceof LLMReplayMissError) {
            await trajectory.addStep({
              step,
              observation_summary: shortObs(snapshot),
              action: { type: "noop", reason: "LLM replay miss" },
              latency_ms: Date.now() - t0,
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
            observation_summary: shortObs(snapshot),
            action: { type: "parse_error", raw: completion.slice(0, 200), error: msg },
            latency_ms: llmLatency,
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            screenshot_path: null,
            verifier_state: null,
          });
          history.push({
            actionLabel: "parse_error",
            result: { ok: false, message: `parse error: ${msg}` },
          });
          // Try one more turn rather than aborting — LLMs occasionally
          // re-format on a second pass when explicitly told.
          continue;
        }

        const t1 = Date.now();
        const result = await executeAction(action, browser, snapshot);
        const stepLatency = Date.now() - t1;

        await trajectory.addStep({
          step,
          observation_summary: shortObs(snapshot),
          action: actionToRecord(action, result),
          latency_ms: stepLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        budget.recordStep();

        history.push({
          actionLabel: actionLabel(action),
          result,
        });

        if (action.type === "finish") {
          await trajectory.finish({ terminal_state: "DONE" });
          return trajectory;
        }

        budget.check();
      }

      await trajectory.finish({
        terminal_state: "DECLINED",
        decline_reason: `max steps (${maxSteps}) exhausted`,
      });
      return trajectory;
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        await trajectory.finish({
          terminal_state: "BUDGET_EXCEEDED",
          decline_reason: err.message,
        });
        return trajectory;
      }
      if (err instanceof SessionTimeoutError) {
        await trajectory.finish({
          terminal_state: "SESSION_TIMEOUT",
          decline_reason: err.message,
        });
        return trajectory;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await trajectory.finish({ terminal_state: "ERROR", decline_reason: msg });
      return trajectory;
    }
  }
}

interface HistoryItem {
  actionLabel: string;
  result: ActionResult;
}

const HISTORY_LIMIT = 6;

function buildMessages(goal: string, observation: string, history: HistoryItem[]): LLMMessage[] {
  const recent = history.slice(-HISTORY_LIMIT);
  const historyText = recent.length === 0
    ? "(no prior actions)"
    : recent
        .map((h, i) => {
          const ok = h.result.ok ? "ok" : "fail";
          const extra = h.result.extracted ? ` extracted="${truncate(h.result.extracted, 200)}"` : "";
          return `${i + 1}. ${h.actionLabel} → ${ok}: ${truncate(h.result.message, 120)}${extra}`;
        })
        .join("\n");
  const user =
    `Goal: ${goal.trim()}\n\n` +
    `Recent actions:\n${historyText}\n\n` +
    `Current page:\n${observation}\n\n` +
    `Reply with the next action as a single JSON object.`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function actionLabel(action: AgentAction): string {
  switch (action.type) {
    case "click":
      return `click(${action.target})`;
    case "type":
      return `type(${action.target}, ${truncate(action.text, 30)}${action.submit ? ", submit" : ""})`;
    case "scroll":
      return `scroll(${action.direction}${action.pixels ? `, ${action.pixels}` : ""})`;
    case "wait":
      return `wait(${action.ms}ms)`;
    case "navigate":
      return `navigate(${truncate(action.url, 60)})`;
    case "extract":
      return `extract(${truncate(action.query, 30)})`;
    case "finish":
      return `finish(${truncate(action.reason, 30)})`;
  }
}

function actionToRecord(
  action: AgentAction,
  result: ActionResult,
): { type: string } & Record<string, unknown> {
  const base: { type: string } & Record<string, unknown> = {
    type: action.type,
    ok: result.ok,
    result: result.message,
  };
  if ("thought" in action && action.thought !== undefined) base.thought = action.thought;
  if (action.type === "click" || action.type === "type") base.target = action.target;
  if (action.type === "type") {
    base.text = action.text;
    if (action.submit) base.submit = true;
  }
  if (action.type === "scroll") {
    base.direction = action.direction;
    if (action.pixels !== undefined) base.pixels = action.pixels;
  }
  if (action.type === "wait") base.ms = action.ms;
  if (action.type === "navigate") base.url = action.url;
  if (action.type === "extract") {
    base.query = action.query;
    if (result.extracted) base.extracted = result.extracted;
  }
  if (action.type === "finish") base.reason = action.reason;
  return base;
}

function shortObs(s: PageSnapshot): string {
  return `seq=${s.seq} url=${truncate(s.url, 80)} title=${truncate(s.title, 60)} elems=${s.elements.length}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
