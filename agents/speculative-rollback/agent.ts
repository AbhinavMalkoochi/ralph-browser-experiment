// speculative-rollback browser agent (US-016, third novel slot).
//
// Mechanism: every action is a SPECULATIVE TRIAL. Each step the agent
//
//   1. Captures the client-side state of the page (URL, localStorage,
//      sessionStorage) — see snapshot.ts.
//   2. Asks the PROPOSER LLM for an ordered list of K=2 candidate actions
//      (one call returns a JSON array).
//   3. Executes the highest-priority candidate.
//   4. Re-observes the page and asks the JUDGE LLM whether the new state
//      represents `commit` (progress), `revert` (regress / no-op), or
//      `done` (the goal is met).
//   5. On `done`, finishes the trajectory. On `commit`, the new state is
//      kept and the loop advances. On `revert`, the agent RESTORES the
//      pre-action snapshot, adds the candidate's label to a blacklist, and
//      tries the next candidate.
//   6. If every candidate from a propose call is reverted, the loop bumps
//      the step counter and re-proposes with the blacklist surfaced in the
//      prompt.
//
// Distinct in core mechanism from prior slots:
//   - baseline-a11y-react: single-shot ReAct, never rolls back.
//   - plan-then-execute:   batched upfront plan, repair on hard-fail; never
//                          reverts an action's side effects.
//   - runtime-codegen:     LLM emits raw JS bodies; no judge, no rollback.
//
// The state restore is best-effort (client-side only — server-side mutations
// are not undone), but the judge LLM operates on observed state regardless,
// so the mechanism still classifies and avoids repeating bad actions.

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
  ActionParseError,
  actionLabel,
  executeAction,
  parseCandidates,
  type ActionResult,
  type CandidateAction,
} from "./actions.js";
import {
  digestObservation,
  formatObservation,
  observePage,
  type PageObservation,
} from "./observe.js";
import {
  captureState,
  describeState,
  restoreState,
  type PageState,
} from "./snapshot.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 10;
export const DEFAULT_CANDIDATES = 2;
const HISTORY_LIMIT = 5;
const BLACKLIST_LIMIT = 12;

const PROPOSER_PROMPT = `You are the PROPOSER half of a speculative browser agent. Each turn you
receive: the page URL, title, body text, and lists of visible buttons and
inputs with selector hints. A recent history of attempted actions and their
judge verdicts is also provided.

Reply with a JSON envelope containing K candidate actions, ordered most
promising first. The harness will EXECUTE the first one; if a judge LLM
rules it a regress, it is REVERTED and the next candidate is tried.

Schema:

  {
    "candidates": [
      { "action": {"type":"click", "selector":"button#submit"},
        "rationale": "<one sentence>" },
      { "action": {"type":"type", "selector":"input[name='q']",
        "text":"<value>", "submit": true},
        "rationale": "<one sentence>" }
    ]
  }

Allowed action types:
  click(selector)                          # any valid CSS selector
  type(selector, text, submit?)            # sets .value + dispatches input/change
  scroll(direction: up|down, pixels?)
  wait(ms)                                 # short waits only
  navigate(url)                            # cross-origin allowed
  finish(reason)                           # propose ONLY if you believe the
                                           # goal is met; the judge confirms

Rules:
- Output ONLY JSON, no fences, no prose.
- Provide at most 3 candidates. They should be GENUINELY DISTINCT — picking
  two near-duplicates wastes a snapshot/restore cycle.
- Prefer selectors from the snapshot's selector_hint over guessing.
- Never propose an action whose label is in the blacklist; pick a different
  approach.`;

const JUDGE_PROMPT = `You are the JUDGE half of a speculative browser agent. You receive:
- the goal,
- the page state digest BEFORE the action,
- the action that was taken,
- the page state digest AFTER the action,
- the executor's mechanical result message.

Decide whether to KEEP this action (it made progress toward the goal), REVERT
it (it regressed or made no observable progress), or DECLARE the goal DONE.

Reply with ONLY this JSON object (no prose, no fences):

  {"verdict": "commit" | "revert" | "done", "reason": "<one sentence>"}

Guidance:
- "done" REQUIRES strong evidence in the after-state (e.g. a success message,
  a server confirmation visible in the page text, a target URL, an input value
  matching the goal). Do not declare done speculatively.
- "revert" is the right call when the action errored, when the page state is
  unchanged or worse (e.g. an error banner appeared), or when the action
  triggered an unrelated side effect that needs to be undone.
- "commit" is the default for actions that moved the URL, opened a new section,
  filled a field, or otherwise visibly advanced toward the goal even if more
  steps remain.`;

export interface SpeculativeRollbackOpts {
  /** Inject an LLM client (used by tests). Default: defaultClient(env). */
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  /** Model name. Defaults to gpt-4o-mini. */
  model?: string;
  /** Loop step cap. Defaults to 10. Each step may make 2..K+1 LLM calls. */
  maxSteps?: number;
  /** Number of candidates the proposer is asked for. Defaults to 2. */
  candidates?: number;
}

interface HistoryItem {
  /** A short label such as `click(button#submit)`. */
  label: string;
  /** What the executor returned (ok/message). */
  result: ActionResult;
  /** Judge verdict (commit | revert | done | parse_error | skip). */
  verdict: string;
  /** Judge rationale, when present. */
  reason: string;
}

export default class SpeculativeRollbackAgent extends Agent {
  readonly id = "speculative-rollback";

  private readonly opts: SpeculativeRollbackOpts;

  constructor(opts: SpeculativeRollbackOpts = {}) {
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
    const candidatesK = Math.max(1, Math.min(3, this.opts.candidates ?? DEFAULT_CANDIDATES));

    const history: HistoryItem[] = [];
    const blacklist: string[] = [];
    let step = 0;

    try {
      while (step < maxSteps) {
        budget.check();
        step += 1;

        // Observe + snapshot the state we will return to on revert.
        const beforeObs = await safeObserve(browser);
        const before = await safeCapture(browser, beforeObs.url);

        // 1) PROPOSER
        const proposerMessages = buildProposerMessages(goal, beforeObs, history, blacklist, candidatesK);
        let proposerCompletion: string;
        const t0 = Date.now();
        try {
          const r = await llm.call(model, proposerMessages, { temperature: 0 });
          proposerCompletion = r.text;
        } catch (err) {
          if (await declineOnLlmError(err, trajectory, step, beforeObs, Date.now() - t0)) {
            return trajectory;
          }
          throw err;
        }
        const proposerLatency = Date.now() - t0;

        let candidates: CandidateAction[];
        try {
          candidates = parseCandidates(proposerCompletion).slice(0, candidatesK);
        } catch (err) {
          const msg = err instanceof ActionParseError ? err.message : String(err);
          await trajectory.addStep({
            step,
            observation_summary: digestObservation(beforeObs),
            action: {
              type: "parse_error",
              raw: proposerCompletion.slice(0, 200),
              error: msg,
              phase: "propose",
            },
            latency_ms: proposerLatency,
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            screenshot_path: null,
            verifier_state: null,
          });
          history.push({
            label: "(parse_error)",
            result: { ok: false, message: `parse error: ${msg}` },
            verdict: "parse_error",
            reason: msg,
          });
          continue;
        }

        let committed = false;

        // 2) For each candidate: execute → judge → commit-or-revert.
        for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
          budget.check();
          const c = candidates[cIdx];
          if (!c) continue;
          const label = actionLabel(c);
          if (blacklist.includes(label)) {
            history.push({
              label,
              result: { ok: false, message: "skipped (blacklisted)" },
              verdict: "skip",
              reason: "in blacklist",
            });
            continue;
          }

          // Execute.
          const tExec = Date.now();
          let result: ActionResult;
          try {
            result = await executeAction(c, browser);
          } catch (err) {
            result = {
              ok: false,
              message: `execute threw: ${truncate(err instanceof Error ? err.message : String(err), 200)}`,
            };
          }
          const execLatency = Date.now() - tExec;

          // Observe after.
          const afterObs = await safeObserve(browser);

          // Short-circuit verdict for `finish` candidates: the judge confirms,
          // but we record the finish action either way.
          if (c.type === "finish") {
            await trajectory.addStep({
              step,
              observation_summary: digestObservation(beforeObs),
              action: actionToRecord(c, result, before, afterObs, candidates.length, cIdx),
              latency_ms: execLatency,
              tokens_in: 0,
              tokens_out: 0,
              cost_usd: 0,
              screenshot_path: null,
              verifier_state: null,
            });
            budget.recordStep();
            await trajectory.finish({
              terminal_state: "DONE",
              decline_reason: null,
            });
            return trajectory;
          }

          // 3) JUDGE
          const judgeMessages = buildJudgeMessages(goal, beforeObs, c, result, afterObs);
          let verdict: "commit" | "revert" | "done" = "revert";
          let judgeReason = "";
          const tJudge = Date.now();
          try {
            const r = await llm.call(model, judgeMessages, { temperature: 0 });
            const parsed = parseJudge(r.text);
            verdict = parsed.verdict;
            judgeReason = parsed.reason;
          } catch (err) {
            if (await declineOnLlmError(err, trajectory, step, beforeObs, Date.now() - tJudge)) {
              return trajectory;
            }
            // For non-decline failures (parse), default to revert so we try
            // the next candidate rather than commit blindly.
            judgeReason = `judge error: ${truncate(err instanceof Error ? err.message : String(err), 120)}`;
            verdict = "revert";
          }
          const judgeLatency = Date.now() - tJudge;

          // Record the step.
          await trajectory.addStep({
            step,
            observation_summary: digestObservation(beforeObs),
            action: {
              ...actionToRecord(c, result, before, afterObs, candidates.length, cIdx),
              verdict,
              judge_reason: judgeReason,
              judge_latency_ms: judgeLatency,
            },
            latency_ms: execLatency + judgeLatency,
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            screenshot_path: null,
            verifier_state: null,
          });
          budget.recordStep();

          history.push({
            label,
            result,
            verdict,
            reason: judgeReason,
          });

          if (verdict === "done") {
            await trajectory.finish({ terminal_state: "DONE" });
            return trajectory;
          }

          if (verdict === "commit") {
            committed = true;
            // The blacklist is per-state; once we commit, the old blacklist
            // is no longer relevant (we're in a new state).
            blacklist.length = 0;
            break;
          }

          // Revert.
          try {
            await restoreState(browser, before);
          } catch (err) {
            // Restoration is best-effort. Surface as a step note but don't
            // abort — the judge already classified the action as a regress.
            await trajectory.addStep({
              step,
              observation_summary: digestObservation(beforeObs),
              action: {
                type: "restore_failed",
                error: truncate(err instanceof Error ? err.message : String(err), 200),
                target_url: before.url,
              },
              latency_ms: 0,
              tokens_in: 0,
              tokens_out: 0,
              cost_usd: 0,
              screenshot_path: null,
              verifier_state: null,
            });
          }
          if (!blacklist.includes(label)) {
            blacklist.push(label);
            if (blacklist.length > BLACKLIST_LIMIT) blacklist.shift();
          }
          budget.check();
        }

        // If !committed, every candidate was reverted (or skipped); the
        // outer loop re-enters with the same observation but a populated
        // blacklist, so the next proposer turn must pick differently.
        // maxSteps bounds runaway loops.
        void committed;
      }

      await trajectory.finish({
        terminal_state: "DECLINED",
        decline_reason: `max steps (${maxSteps}) exhausted`,
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

async function safeCapture(browser: BrowserSession, fallbackUrl: string): Promise<PageState> {
  try {
    return await captureState(browser);
  } catch (_err) {
    return { url: fallbackUrl, localStorage: {}, sessionStorage: {} };
  }
}

interface JudgeParse {
  verdict: "commit" | "revert" | "done";
  reason: string;
}

export function parseJudge(raw: string): JudgeParse {
  const text = stripFences(String(raw).trim());
  const start = text.indexOf("{");
  if (start === -1) {
    throw new ActionParseError("judge response has no JSON object", raw);
  }
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(slice) as Record<string, unknown>;
        } catch {
          throw new ActionParseError("judge response is not valid JSON", raw);
        }
        const v = String(obj.verdict ?? obj.decision ?? "").toLowerCase();
        const reason = String(obj.reason ?? obj.rationale ?? "");
        if (v !== "commit" && v !== "revert" && v !== "done") {
          throw new ActionParseError(`judge verdict ${JSON.stringify(v)} is not commit|revert|done`, raw);
        }
        return { verdict: v as JudgeParse["verdict"], reason };
      }
    }
  }
  throw new ActionParseError("judge response had an unterminated object", raw);
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (m) return (m[1] ?? "").trim();
  return text;
}

function buildProposerMessages(
  goal: string,
  obs: PageObservation,
  history: HistoryItem[],
  blacklist: string[],
  candidatesK: number,
): LLMMessage[] {
  const recent = history.slice(-HISTORY_LIMIT);
  const historyText = recent.length === 0
    ? "(no prior attempts)"
    : recent
        .map((h, i) => {
          const verdict = h.verdict.toUpperCase();
          const reason = h.reason ? ` reason="${truncate(h.reason, 100)}"` : "";
          return `${i + 1}. ${h.label} → ${verdict}${reason}`;
        })
        .join("\n");
  const blacklistText = blacklist.length === 0
    ? "(empty)"
    : blacklist.map((b) => `- ${b}`).join("\n");
  const user =
    `Goal: ${goal.trim()}\n\n` +
    `Recent attempts (most recent last):\n${historyText}\n\n` +
    `Blacklisted action labels (do NOT propose these verbatim):\n${blacklistText}\n\n` +
    `Current page:\n${formatObservation(obs)}\n\n` +
    `Reply with a JSON envelope containing up to ${candidatesK} candidate ` +
    `actions, ordered most promising first.`;
  return [
    { role: "system", content: PROPOSER_PROMPT },
    { role: "user", content: user },
  ];
}

function buildJudgeMessages(
  goal: string,
  before: PageObservation,
  action: CandidateAction,
  result: ActionResult,
  after: PageObservation,
): LLMMessage[] {
  const user =
    `Goal: ${goal.trim()}\n\n` +
    `State BEFORE:\n${digestObservation(before)}\n\n` +
    `Action taken: ${actionLabel(action)}\n` +
    `Executor result: ok=${result.ok} message=${JSON.stringify(truncate(result.message, 200))}\n\n` +
    `State AFTER:\n${digestObservation(after)}\n\n` +
    `Reply with the verdict JSON object.`;
  return [
    { role: "system", content: JUDGE_PROMPT },
    { role: "user", content: user },
  ];
}

function actionToRecord(
  c: CandidateAction,
  result: ActionResult,
  beforeState: PageState,
  afterObs: PageObservation,
  total: number,
  index: number,
): { type: string } & Record<string, unknown> {
  const base: { type: string } & Record<string, unknown> = {
    type: c.type,
    ok: result.ok,
    result: result.message,
    candidate_index: index,
    candidates_total: total,
    label: actionLabel(c),
    before_state: describeState(beforeState),
    after_state: digestObservation(afterObs),
  };
  if (c.type === "click") base.selector = c.selector;
  if (c.type === "type") {
    base.selector = c.selector;
    base.text = c.text;
    if (c.submit) base.submit = true;
  }
  if (c.type === "scroll") {
    base.direction = c.direction;
    if (c.pixels !== undefined) base.pixels = c.pixels;
  }
  if (c.type === "wait") base.ms = c.ms;
  if (c.type === "navigate") base.url = c.url;
  if (c.type === "finish") base.reason = c.reason;
  if (c.rationale) base.rationale = c.rationale;
  return base;
}

async function declineOnLlmError(
  err: unknown,
  trajectory: Trajectory,
  step: number,
  obs: PageObservation,
  latency: number,
): Promise<boolean> {
  if (err instanceof LLMProviderUnavailableError) {
    await trajectory.addStep({
      step,
      observation_summary: digestObservation(obs),
      action: { type: "noop", reason: "no LLM provider configured" },
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
      action: { type: "noop", reason: "LLM replay miss" },
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
