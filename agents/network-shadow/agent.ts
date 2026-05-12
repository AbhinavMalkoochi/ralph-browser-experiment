// network-shadow browser agent (US-019, sixth novel slot).
//
// Distinguishing mechanism: the agent's primary observation is the
// PAGE'S OWN NETWORK TRAFFIC. A fetch+XHR monkey-patch is installed
// at run start AND on every new document via
// Page.addScriptToEvaluateOnNewDocument; every request and its
// response is recorded into window.__gba_net_log. Each step the LLM
// sees a tail of recent traffic alongside a minimal page summary and
// emits one of five actions:
//
//   - fetch(method, url, body?, content_type?): execute an HTTP
//     request from inside the page; cookies and origin are preserved,
//     and the monkey-patch records it uniformly with the page's own
//     calls.
//   - click(selector): trigger a UI element so the page's own JS
//     issues whatever requests it would normally issue (used when no
//     direct API path is visible).
//   - navigate(url): change the document.
//   - wait(ms): let async post-action effects land.
//   - done(reason) / decline(reason).
//
// Distinct from every prior slot on TWO axes:
//
//   - Observation modality: network traffic (this) vs DOM (baseline,
//     plan-then-execute, runtime-codegen, speculative-rollback,
//     predicate-driven) vs pixels (vision-grounded).
//   - Action substrate: HTTP requests (this) vs DOM aids
//     (baseline) vs text selectors (plan-then-execute) vs raw JS
//     bodies (runtime-codegen) vs CSS selectors (speculative-
//     rollback, predicate-driven) vs pixel coords (vision-grounded).
//
// Why this mechanism: a lot of hostile UI patterns (shadow DOM forms,
// multi-tab popups, conditional validation, multi-attempt submits)
// reduce to a single same-origin HTTP request once the endpoint is
// visible. An agent with DevTools-style network introspection can
// short-circuit them entirely. We expect strong performance on
// fixtures where the server endpoint is the canonical success signal
// (shadow-form, conditional-form, recoverable, multi-tab, pdf-task,
// hydration) and weak performance on canvas/iframe-drag (verifiers
// check window.__test, not a server endpoint).

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
  clearNetLog,
  formatNetLog,
  installPatch,
  readNetLog,
  type NetEntry,
} from "./network.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 12;
const HISTORY_LIMIT = 4;

const SYSTEM_PROMPT = `You are an API-FIRST browser agent. Your primary signal is the page's
NETWORK TRAFFIC: every fetch and XMLHttpRequest the page makes (and every
request you yourself issue) is logged with method, URL, request body,
status, and a response-body sample.

You are NOT a UI agent. Your default action is to identify the
same-origin HTTP endpoint that drives the page's behaviour and call it
directly with \`fetch\`. UI clicks are a fallback used only when no
endpoint is visible yet — they trigger the page's own JS so its own
requests show up in your log.

Reply with ONLY this JSON object (no fences, no prose):

  {"type": "fetch",    "method": "POST", "url": "/__feature/submit", "body": "...", "content_type": "application/json", "thought": "<short>"}
  {"type": "click",    "selector": "<css>",  "thought": "<short>"}
  {"type": "navigate", "url": "https://...", "thought": "<short>"}
  {"type": "wait",     "ms": 400,            "thought": "<short>"}
  {"type": "done",     "reason": "<why goal is met>"}
  {"type": "decline",  "reason": "<why you cannot proceed>"}

Rules:
- Prefer \`fetch\` over \`click\`. A page that POSTs to /__foo/submit on
  button click will accept the same POST from your fetch — origin and
  cookies are preserved because the request runs inside the page.
- URLs may be absolute (https://…) or relative (/…). Relative URLs are
  resolved against the current document.baseURI.
- For JSON bodies set content_type to "application/json" and supply the
  body as a JSON string (e.g. body: "{\\"k\\":\\"v\\"}").
- Issue \`done\` only when the recorded response confirms the goal
  (e.g. {"ok": true} from a submit endpoint, expected substring in a
  response body). Looking at PAGE TEXT alone is not enough — your job
  is to make the page's server-side state match the goal.
- If repeated attempts fail and no endpoint is discoverable, issue
  \`decline\` rather than thrashing.
- The harness checks your budget; emit one action per response.`;

export interface NetworkShadowOpts {
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  model?: string;
  maxSteps?: number;
}

interface HistoryItem {
  label: string;
  result: ActionResult;
  netDelta: number;
}

export default class NetworkShadowAgent extends Agent {
  readonly id = "network-shadow";

  private readonly opts: NetworkShadowOpts;

  constructor(opts: NetworkShadowOpts = {}) {
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
    const model = this.opts.model ?? process.env.GBA_MODEL ?? DEFAULT_MODEL;
    const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;

    const history: HistoryItem[] = [];

    try {
      await installPatch(browser);

      let step = 0;
      while (step < maxSteps) {
        budget.check();
        step += 1;

        const obs = await safeObserve(browser);
        const log = await readNetLog(browser);

        const messages = buildMessages(goal, obs, log, history, step);

        let completion: string;
        const t0 = Date.now();
        try {
          const r = await llm.call(model, messages, { temperature: 0 });
          completion = r.text;
        } catch (err) {
          if (await declineOnLlmError(err, trajectory, step, obs, Date.now() - t0)) {
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
            action: { type: "parse_error", raw: completion.slice(0, 200), error: msg },
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
            netDelta: 0,
          });
          continue;
        }

        const beforeCount = log.length;
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

        // After every action, re-install the patch (a navigation may have
        // wiped window-level state); the install is idempotent so a no-op
        // when nothing changed.
        if (action.type === "navigate") {
          await installPatch(browser);
        }

        const afterLog = await readNetLog(browser);
        const netDelta = Math.max(0, afterLog.length - beforeCount);

        await trajectory.addStep({
          step,
          observation_summary: digestObservation(obs),
          action: actionToRecord(action, result, netDelta),
          latency_ms: execLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        budget.recordStep();

        history.push({ label: actionLabel(action), result, netDelta });

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
      // Best-effort: drop the log so subsequent runs on the same session
      // don't see ghost traffic. Pool destroy+respawn already guarantees
      // isolation, but this keeps unit tests on a single session clean.
      await clearNetLog(browser).catch(() => {});
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
      forms: [],
      counts: { a: 0, button: 0, form: 0, input: 0, iframe: 0 },
      seq: 0,
    };
  }
}

function buildMessages(
  goal: string,
  obs: PageObservation,
  log: NetEntry[],
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
            return `${i + 1}. ${h.label} → ${ok} (+${h.netDelta} net): ${truncate(h.result.message, 160)}`;
          })
          .join("\n");
  const user =
    `Step ${step}.\n` +
    `Goal: ${goal.trim()}\n\n` +
    `Recent actions:\n${historyText}\n\n` +
    `Network traffic (most recent ${Math.min(log.length, 12)} of ${log.length}):\n${formatNetLog(log)}\n\n` +
    `Page summary:\n${formatObservation(obs)}\n\n` +
    `Reply with the next action as a single JSON object.`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

function actionToRecord(
  action: AgentAction,
  result: ActionResult,
  netDelta: number,
): { type: string } & Record<string, unknown> {
  const base: { type: string } & Record<string, unknown> = {
    type: action.type,
    ok: result.ok,
    result: result.message,
    label: actionLabel(action),
    net_delta: netDelta,
  };
  if (action.thought !== undefined) base.thought = action.thought;
  if (action.type === "fetch") {
    base.method = action.method;
    base.url = action.url;
    if (action.body != null) base.body = action.body;
    if (action.content_type != null) base.content_type = action.content_type;
  }
  if (action.type === "click") base.selector = action.selector;
  if (action.type === "navigate") base.url = action.url;
  if (action.type === "wait") base.ms = action.ms;
  if (action.type === "done") base.reason = action.reason;
  if (action.type === "decline") base.reason = action.reason;
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
