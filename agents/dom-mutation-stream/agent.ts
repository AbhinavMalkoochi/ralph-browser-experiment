// dom-mutation-stream browser agent (US-020, seventh novel slot).
//
// Distinguishing mechanism: the agent's primary observation is the
// STREAM OF DOM MUTATIONS since the last action — not the current page
// state. A MutationObserver is installed at run start (and on every
// fresh document, via Page.addScriptToEvaluateOnNewDocument) and pushes
// every childList / attribute / characterData mutation into a FIFO log
// on window.__gba_dom_log with a strictly-monotonic sequence number.
//
// Each step:
//   1. read the mutation slice (entries with seq > lastSeq)
//   2. snapshot the current interactive elements (small; the LLM's main
//      signal is the delta, not the state)
//   3. LLM emits one of {click, type, scroll, wait, await_change,
//      navigate, done, decline}
//   4. for state-changing actions, the harness calls settleAfter()
//      which BLOCKS until the mutation log either grows-then-quiesces
//      or a 400ms cap fires — the LLM observes a settled post-action
//      state, not a transient mid-reaction view
//
// Distinct from every prior slot on TWO axes:
//   - Observation axis: DELTAS (DOM mutations) vs STATES. No prior
//     agent surfaces "what just changed" as the primary signal.
//     network-shadow uses network deltas; this one uses DOM deltas.
//   - First-class `await_change` action: a primitive whose semantics
//     is "block in-page until the page itself moves" — turn cadence
//     is gated by the document, not wall-clock.
//
// Why this mechanism: the harness has six fixtures whose verifier
// success depends on a TRANSITION the agent needs to observe:
// conditional-form (field set changes after each step), late-hydration
// (button re-binds), modal-stack (FSM advances), recoverable (banner
// reappears post-500), virtual-scroll (row visibility flips on
// scroll), shadow-form (DOM appears after a click). A delta-first
// observation should pick up the click→change-set or click→re-bind
// pair as a single signal rather than re-deriving it from snapshot
// diffs every turn.

import { Agent, type AgentContext } from "../../harness/ts/agent/agent.js";
import { Trajectory } from "../../harness/ts/agent/trajectory.js";
import { Budget, BudgetExceeded, type BrowserSession } from "../../harness/ts/agent/types.js";
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
  isStateChanging,
  parseAction,
  type ActionResult,
  type AgentAction,
} from "./actions.js";
import {
  awaitChange,
  clearMutations,
  digestSnapshot,
  formatMutations,
  formatSnapshot,
  installObserver,
  readCurrentSeq,
  readMutations,
  settleAfter,
  snapshotPage,
  type MutationEntry,
  type PageSnapshot,
} from "./observer.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 12;
const HISTORY_LIMIT = 4;
const MUTATION_TAIL_LIMIT = 24;

const SYSTEM_PROMPT = `You are a DELTA-FIRST browser agent. Your primary signal is the
STREAM OF DOM MUTATIONS since your last action — what just CHANGED
on the page (nodes added/removed, attributes flipped, text edited).
The current interactive-element list is provided too, but it is
secondary: focus your reasoning on the mutation tail.

Reply with ONLY this JSON object (no fences, no prose):

  {"type": "click",        "aid": 12,                       "thought": "<short>"}
  {"type": "type",         "aid": 7, "text": "...", "submit": false, "thought": "<short>"}
  {"type": "scroll",       "direction": "down", "pixels": 600,        "thought": "<short>"}
  {"type": "wait",         "ms": 400,                       "thought": "<short>"}
  {"type": "await_change", "timeout_ms": 1500,              "thought": "<short>"}
  {"type": "navigate",     "url": "https://...",            "thought": "<short>"}
  {"type": "done",         "reason": "<why goal is met>"}
  {"type": "decline",      "reason": "<why you cannot proceed>"}

Rules:
- \`aid\` is the integer in square brackets next to each interactive
  element. Never invent CSS selectors — the action layer only accepts
  aids.
- Prefer reading the MUTATION TAIL over re-reading page text. A click
  that flips a field set or reveals a banner shows up as
  "+ div ... into form" / "~ button disabled: true → ∅" in the
  mutation stream.
- Use \`await_change\` when you expect a slow reaction (network
  round-trip, hydration delay, animation) before the next observation
  would be meaningful. The harness already settles automatically after
  every state-changing action, so use this only when you want EXTRA
  patience.
- Issue \`done\` once the mutation stream (or the snapshot) confirms
  the goal state. If a fixture has a server-side success signal
  (e.g. document.title changes to "submitted"), wait for that
  mutation BEFORE declaring done.
- One action per response. The harness records the next mutation
  delta as the next observation.`;

export interface DomMutationStreamOpts {
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  model?: string;
  maxSteps?: number;
}

interface HistoryItem {
  label: string;
  result: ActionResult;
  mutationDelta: number;
}

export default class DomMutationStreamAgent extends Agent {
  readonly id = "dom-mutation-stream";

  private readonly opts: DomMutationStreamOpts;

  constructor(opts: DomMutationStreamOpts = {}) {
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
    const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;

    const history: HistoryItem[] = [];
    let lastSeq = 0;

    try {
      await installObserver(browser);
      lastSeq = await readCurrentSeq(browser);

      let step = 0;
      while (step < maxSteps) {
        budget.check();
        step += 1;

        const slice = await readMutations(browser, lastSeq);
        const snapshot = await safeSnapshot(browser);

        const messages = buildMessages(goal, snapshot, slice.entries, history, step);

        let completion: string;
        const t0 = Date.now();
        try {
          const r = await llm.call(model, messages, { temperature: 0 });
          completion = r.text;
        } catch (err) {
          if (await declineOnLlmError(err, trajectory, step, snapshot, slice.entries.length, Date.now() - t0)) {
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
            observation_summary: digestSnapshot(snapshot, slice.entries.length),
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
            mutationDelta: 0,
          });
          // Advance lastSeq so the parse_error step doesn't see stale
          // mutations on the next turn.
          lastSeq = slice.currentSeq;
          continue;
        }

        const tExec = Date.now();
        let result: ActionResult;
        try {
          result = await executeAction(action, browser, snapshot);
        } catch (err) {
          result = {
            ok: false,
            message: `execute threw: ${truncate(err instanceof Error ? err.message : String(err), 200)}`,
          };
        }
        const execLatency = Date.now() - tExec;

        // Re-install observer after navigations — the install is idempotent
        // so other action types are a no-op.
        if (action.type === "navigate") {
          await installObserver(browser);
        }

        let postSeq = slice.currentSeq;
        let settleElapsed = 0;
        if (isStateChanging(action) && result.ok) {
          const t1 = Date.now();
          const r = await settleAfter(browser, slice.currentSeq);
          postSeq = r.newSeq;
          settleElapsed = Date.now() - t1;
        } else if (action.type === "await_change") {
          const r = await awaitChange(browser, slice.currentSeq, action.timeout_ms);
          postSeq = r.newSeq;
          settleElapsed = r.elapsed;
        } else {
          postSeq = await readCurrentSeq(browser);
        }
        const mutationDelta = Math.max(0, postSeq - slice.currentSeq);

        await trajectory.addStep({
          step,
          observation_summary: digestSnapshot(snapshot, slice.entries.length),
          action: actionToRecord(action, result, mutationDelta, settleElapsed),
          latency_ms: execLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        budget.recordStep();

        history.push({ label: actionLabel(action), result, mutationDelta });
        lastSeq = postSeq;

        if (action.type === "done") {
          await trajectory.finish({ terminal_state: "DONE" });
          return trajectory;
        }
        if (action.type === "decline") {
          await trajectory.finish({
            terminal_state: "DECLINED",
            decline_reason: action.reason,
          });
          return trajectory;
        }
      }

      await trajectory.finish({
        terminal_state: "DECLINED",
        decline_reason: `max steps (${maxSteps}) exhausted without done/decline`,
      });
      return trajectory;
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        if (!trajectory.isFinished) {
          await trajectory.finish({ terminal_state: "BUDGET_EXCEEDED", decline_reason: err.message });
        }
        return trajectory;
      }
      if (err instanceof SessionTimeoutError) {
        if (!trajectory.isFinished) {
          await trajectory.finish({ terminal_state: "SESSION_TIMEOUT", decline_reason: err.message });
        }
        return trajectory;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!trajectory.isFinished) {
        await trajectory.finish({ terminal_state: "ERROR", decline_reason: msg });
      }
      return trajectory;
    } finally {
      // Best-effort cleanup; pool destroy+respawn already guarantees
      // isolation, but this keeps unit-test single-session runs clean.
      await clearMutations(browser).catch(() => {});
    }
  }
}

async function safeSnapshot(browser: BrowserSession): Promise<PageSnapshot> {
  try {
    return await snapshotPage(browser);
  } catch (err) {
    return {
      url: "",
      title: "",
      text: `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
      elements: [],
      scanned: 0,
      seq: 0,
    };
  }
}

function buildMessages(
  goal: string,
  snapshot: PageSnapshot,
  mutations: MutationEntry[],
  history: HistoryItem[],
  step: number,
): LLMMessage[] {
  const recent = history.slice(-HISTORY_LIMIT);
  const historyText =
    recent.length === 0
      ? "(no prior actions)"
      : recent
          .map((h, i) => {
            const ok = h.result.ok ? "ok" : "fail";
            return `${i + 1}. ${h.label} → ${ok} (Δmut=${h.mutationDelta}): ${truncate(h.result.message, 160)}`;
          })
          .join("\n");
  const user =
    `Step ${step}.\n` +
    `Goal: ${goal.trim()}\n\n` +
    `Recent actions:\n${historyText}\n\n` +
    `DOM mutations since last action (most recent first up to ${MUTATION_TAIL_LIMIT}):\n` +
    `${formatMutations(mutations, MUTATION_TAIL_LIMIT)}\n\n` +
    `Current page snapshot:\n${formatSnapshot(snapshot)}\n\n` +
    `Reply with the next action as a single JSON object.`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

function actionToRecord(
  action: AgentAction,
  result: ActionResult,
  mutationDelta: number,
  settleElapsed: number,
): { type: string } & Record<string, unknown> {
  const base: { type: string } & Record<string, unknown> = {
    type: action.type,
    ok: result.ok,
    result: result.message,
    label: actionLabel(action),
    mutation_delta: mutationDelta,
    settle_ms: settleElapsed,
  };
  if (action.thought !== undefined) base.thought = action.thought;
  switch (action.type) {
    case "click":
      base.aid = action.aid;
      break;
    case "type":
      base.aid = action.aid;
      base.text = truncate(action.text, 120);
      if (action.submit) base.submit = true;
      break;
    case "scroll":
      base.direction = action.direction;
      if (action.pixels !== undefined) base.pixels = action.pixels;
      break;
    case "wait":
      base.ms = action.ms;
      break;
    case "await_change":
      base.timeout_ms = action.timeout_ms;
      break;
    case "navigate":
      base.url = action.url;
      break;
    case "done":
      base.reason = action.reason;
      break;
    case "decline":
      base.reason = action.reason;
      break;
  }
  return base;
}

async function declineOnLlmError(
  err: unknown,
  trajectory: Trajectory,
  step: number,
  snapshot: PageSnapshot,
  mutationCount: number,
  latency: number,
): Promise<boolean> {
  if (err instanceof LLMProviderUnavailableError) {
    await trajectory.addStep({
      step,
      observation_summary: digestSnapshot(snapshot, mutationCount),
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
      observation_summary: digestSnapshot(snapshot, mutationCount),
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
  if (typeof s !== "string") s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
