// runtime-codegen browser agent (US-015, second novel slot).
//
// Mechanism: the LLM emits raw JavaScript bodies that run INSIDE the page
// via CDP Runtime.evaluate. There is no fixed action vocabulary: the agent
// hands the LLM a structural observation, the LLM writes the JS that does
// whatever it wants (click, type, dispatch synthetic mouse events, walk
// shadow roots, traverse same-origin iframes, fetch APIs, postMessage), and
// the body returns a small status object {done, message, navigate?, sleep_ms?}.
//
// Distinct in core mechanism from prior slots:
//   - baseline-a11y-react: fixed JSON action set keyed by data-gba-aid.
//   - plan-then-execute:   fixed JSON action set keyed by visible text,
//                          batched in one plan call.
//   - runtime-codegen:     NO action set; the LLM writes the action as code.
//
// This gives the agent first-class access to anything you can do with a JS
// expression in the page — pierce shadow DOM, drag canvas pixels, call
// fetch() against same-origin APIs, postMessage to iframes, etc. The cost is
// that the LLM has to write correct JS each turn. Runtime errors come back
// as the next observation, so a bad script gets one self-correcting retry
// before tripping the step budget.

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
  CodegenParseError,
  extractScript,
  runEmittedScript,
  type EmitResult,
} from "./codegen.js";
import {
  formatObservation,
  observePage,
  type PageObservation,
} from "./observe.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 12;
export const SCRIPT_LOG_LIMIT = 800;

const SYSTEM_PROMPT = `You are an autonomous browser agent. Each turn you receive a structural
observation of the current page. You reply with the BODY of an async
JavaScript function (no signature, no fences) that the harness will run
INSIDE the page. The body can do anything you can do from page JS:
querySelector, traverse shadowRoot, walk same-origin iframe.contentDocument,
dispatch synthetic events, call fetch(), postMessage, etc.

Observation schema (fields you receive each turn):
- url, title, text (first 1500 chars of body innerText)
- counts: {a, button, input, select, textarea, iframe, canvas, shadow_hosts, forms}
- frames: array of {src, id, name, sameOrigin}
- buttons: visible buttons/links — array of {tag, text}
- inputs: visible inputs — array of {type, label, placeholder}

Return contract — your body MUST return one of:
  return { done: true,  message: "<why the goal is met>" };
  return { done: false, message: "<short summary of what you did/saw>" };
  return { done: false, navigate: "https://...", message: "..." };
  return { done: false, sleep_ms: 500, message: "..." };

Rules:
- Output ONLY the function body. No \`\`\` fences, no signature, no prose.
- You MAY use \`await\` — the body runs inside async () => { ... }.
- Top-level cross-origin navigation MUST be requested via { navigate: "..." }.
  Setting location.href detaches the JS context mid-script.
- For shadow DOM: \`host.shadowRoot.querySelector(...)\` (recurse if nested).
- For same-origin iframes: \`iframe.contentDocument.querySelector(...)\`.
- For canvas drag: dispatchEvent(new MouseEvent('mousedown'/'mousemove'/
  'mouseup', {clientX, clientY, bubbles:true, button:0})).
- For typing into inputs: set \`.value = "..."\`, then dispatch \`input\` and
  \`change\` events. For form submit: \`form.requestSubmit()\` or
  \`form.submit()\`.
- For pagination/infinite scroll: programmatically scroll or modify the
  scroll container before querying.
- For fetch() of same-origin endpoints: \`await fetch(url, {...})\`.
- Keep the body short (~20 lines). If a task needs more, break it across
  multiple turns and use { done: false, message: "..." } to log progress.
- The harness records every script and its return value in the trajectory.

Example bodies:

# Click a button matching some text:
const btn = Array.from(document.querySelectorAll('button')).find(b => /Continue/i.test(b.textContent));
if (!btn) return { done: false, message: 'no Continue button' };
btn.click();
return { done: false, message: 'clicked Continue', sleep_ms: 200 };

# Submit a form inside a shadow root:
const host = document.querySelector('shadow-form');
const root = host && host.shadowRoot;
const input = root && root.querySelector('input[name="code"]');
if (!input) return { done: false, message: 'shadow input not found' };
input.value = 'XYZ-42';
input.dispatchEvent(new Event('input', {bubbles:true}));
const form = root.querySelector('form');
form.requestSubmit();
return { done: false, message: 'submitted shadow form', sleep_ms: 200 };

# Assert completion by reading the page text:
const t = (document.body.innerText || '').toLowerCase();
if (t.includes('order confirmed')) return { done: true, message: 'confirmation visible' };
return { done: false, message: 'no confirmation yet' };`;

export interface RuntimeCodegenOpts {
  /** Inject an LLM client (for tests). Default uses defaultClient(env). */
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  /** Override the model name. Defaults to gpt-4o-mini. */
  model?: string;
  /** Override the loop step cap. Defaults to 12. */
  maxSteps?: number;
}

interface HistoryItem {
  /** First N chars of the body, used in the next prompt. */
  scriptExcerpt: string;
  result: EmitResult;
}

const HISTORY_LIMIT = 4;

export default class RuntimeCodegenAgent extends Agent {
  readonly id = "runtime-codegen";

  private readonly opts: RuntimeCodegenOpts;

  constructor(opts: RuntimeCodegenOpts = {}) {
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

    const history: HistoryItem[] = [];
    let step = 0;

    try {
      while (step < maxSteps) {
        budget.check();
        step += 1;

        let observation: PageObservation;
        try {
          observation = await observePage(browser);
        } catch (err) {
          // The page evaluated badly (e.g. about:blank rejects); surface a
          // synthetic observation rather than aborting the run.
          observation = {
            url: "",
            title: "",
            text: `(observation failed: ${err instanceof Error ? err.message : String(err)})`,
            frames: [],
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
            },
            buttons: [],
            inputs: [],
            seq: step,
          };
        }

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
              observation_summary: shortObs(observation),
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
              observation_summary: shortObs(observation),
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

        let body: string;
        try {
          body = extractScript(completion);
        } catch (err) {
          const msg = err instanceof CodegenParseError ? err.message : String(err);
          await trajectory.addStep({
            step,
            observation_summary: shortObs(observation),
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
            scriptExcerpt: completion.slice(0, 200),
            result: {
              ok: false,
              done: false,
              message: `parse error: ${msg}`,
              navigate: null,
              sleep_ms: null,
              error: msg,
              stack: null,
            },
          });
          // Re-prompt next turn. The loop continues; do NOT abort on one
          // bad turn.
          continue;
        }

        const t1 = Date.now();
        let result: EmitResult;
        try {
          result = await runEmittedScript(body, browser);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Transport / syntax errors land here. Surface as a step so the
          // LLM can self-correct on the next turn.
          result = {
            ok: false,
            done: false,
            message: `script error: ${truncate(msg, 200)}`,
            navigate: null,
            sleep_ms: null,
            error: msg,
            stack: null,
          };
        }
        const stepLatency = Date.now() - t1;

        await trajectory.addStep({
          step,
          observation_summary: shortObs(observation),
          action: resultToRecord(body, result),
          latency_ms: stepLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        budget.recordStep();

        history.push({
          scriptExcerpt: body.slice(0, 200),
          result,
        });

        if (result.done) {
          await trajectory.finish({ terminal_state: "DONE" });
          return trajectory;
        }

        if (result.navigate) {
          try {
            await browser.navigate(result.navigate);
          } catch (err) {
            // Navigation failures become the next observation; do not abort.
            history[history.length - 1] = {
              scriptExcerpt: body.slice(0, 200),
              result: {
                ...result,
                ok: false,
                message: `navigate failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            };
          }
        }

        if (result.sleep_ms && result.sleep_ms > 0) {
          await new Promise<void>((r) => setTimeout(r, result.sleep_ms ?? 0));
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

function buildMessages(
  goal: string,
  observation: PageObservation,
  history: HistoryItem[],
): LLMMessage[] {
  const recent = history.slice(-HISTORY_LIMIT);
  const historyText =
    recent.length === 0
      ? "(no prior scripts)"
      : recent
          .map((h, i) => {
            const r = h.result;
            const status = r.ok ? (r.done ? "DONE" : "ok") : "fail";
            const extras: string[] = [];
            if (r.navigate) extras.push(`navigate=${truncate(r.navigate, 80)}`);
            if (r.error) extras.push(`error=${truncate(r.error, 120)}`);
            const extraStr = extras.length ? ` [${extras.join(" ")}]` : "";
            return (
              `${i + 1}. script="${truncate(h.scriptExcerpt, 120)}"\n` +
              `   -> ${status}: ${truncate(r.message, 200)}${extraStr}`
            );
          })
          .join("\n");
  const user =
    `Goal: ${goal.trim()}\n\n` +
    `Recent scripts:\n${historyText}\n\n` +
    `Current page:\n${formatObservation(observation)}\n\n` +
    `Reply with ONLY the body of an async JS function that advances toward ` +
    `the goal. The body must return one of the EmitResult shapes shown in ` +
    `the system prompt.`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

function resultToRecord(
  body: string,
  result: EmitResult,
): { type: string } & Record<string, unknown> {
  const rec: { type: string } & Record<string, unknown> = {
    type: "emit",
    ok: result.ok,
    done: result.done,
    script: truncate(body, SCRIPT_LOG_LIMIT),
    result: result.message,
  };
  if (result.navigate) rec.navigate = result.navigate;
  if (result.sleep_ms !== null) rec.sleep_ms = result.sleep_ms;
  if (result.error) rec.error = result.error;
  return rec;
}

function shortObs(o: PageObservation): string {
  return (
    `seq=${o.seq} url=${truncate(o.url, 80)} title=${truncate(o.title, 60)} ` +
    `btns=${o.buttons.length} inputs=${o.inputs.length} shadow=${o.counts.shadow_hosts} ` +
    `iframes=${o.counts.iframe}`
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
