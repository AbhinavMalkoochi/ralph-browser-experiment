// codegen-predicate agent (US-032, ninth novel slot).
//
// COMPOSED mechanism. Two existing axes:
//
//   1. Action substrate from runtime-codegen (US-015):
//      the action LLM emits the BODY of an async JS function each step. The
//      harness wraps it in an async IIFE with an in-page try/catch and runs
//      it via CDP Runtime.evaluate. The body has first-class DOM access
//      (shadowRoot, contentDocument, fetch(), synthetic events, postMessage).
//
//   2. Termination from predicate-driven (US-017):
//      ONE upfront synthesis LLM call emits a JS predicate that returns true
//      in the page when the goal is satisfied. The harness polls it after
//      every action; the loop exits with terminal_state='DONE_BY_PREDICATE'
//      the moment it fires true. The action LLM has NO `done` action — its
//      `done` field is IGNORED. Termination is owned by code that runs in
//      the page itself.
//
// The composition is the novelty. Neither parent in isolation has BOTH a
// free-form action substrate AND a code-terminated loop:
//   - runtime-codegen lets the LLM author the action as code but lets the
//     LLM also declare itself done via the body's return value.
//   - predicate-driven owns termination from code but constrains actions to
//     a fixed CSS-selector vocabulary.
//   - speculative-rollback (the predecessor this composition replaces) also
//     decouples termination from the action LLM, but at the cost of 2 LLM
//     calls per step (proposer + judge). This agent uses ONE LLM call per
//     step plus a cheap in-page predicate eval, closing the cost gap.
//
// Cost shape per step: 1 action LLM call + 1 browser.evaluate for the script
// + 1 browser.evaluate for the predicate. The predicate is pure in-page JS
// (no LLM); it is essentially free compared to the LLM call.

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
  CodegenParseError,
  extractScript,
  runEmittedScript,
  type EmitResult,
} from "../runtime-codegen/codegen.js";
import {
  formatObservation,
  observePage,
  type PageObservation,
} from "../runtime-codegen/observe.js";
import {
  PredicateParseError,
  evaluatePredicate,
  parsePredicate,
} from "../predicate-driven/predicate.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 12;
export const SCRIPT_LOG_LIMIT = 800;

const HISTORY_LIMIT = 4;

const PREDICATE_PROMPT = `You are the PREDICATE-SYNTHESISER half of a composed browser agent.
Given the goal and an observation of the starting page, emit a single
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
  innerText. You may use \`await\`.
- Prefer SPECIFIC, OBSERVABLE evidence (e.g. "the URL contains /done", or
  "document.body.innerText includes 'submission accepted'"). Avoid being
  true at the START — the harness checks BEFORE every action.
- Be defensive: wrap brittle accesses (\`document.querySelector(...).value\`)
  in optional chaining or short-circuit checks.
- The expression MUST be valid JavaScript. Do NOT include surrounding
  function declarations or \`return\`; just the expression.`;

const ACTION_PROMPT = `You are the ACTION-PICKER half of a composed browser agent. Each turn you
receive a structural observation of the current page. You reply with the BODY
of an async JavaScript function (no signature, no fences) that the harness
will run INSIDE the page. The body can do anything you can do from page JS:
querySelector, traverse shadowRoot, walk same-origin iframe.contentDocument,
dispatch synthetic events, call fetch(), postMessage, etc.

IMPORTANT — termination is NOT yours to declare. A previously-synthesised
predicate is polled in the page AFTER every action; the harness exits the
loop the moment the predicate returns TRUE. You do NOT see the predicate.
There is NO \`done\` field; even if you set \`done: true\`, the harness IGNORES
it. Your job is purely "advance the page state toward the goal".

Observation schema (fields you receive each turn):
- url, title, text (first 1500 chars of body innerText)
- counts: {a, button, input, select, textarea, iframe, canvas, shadow_hosts, forms}
- frames: array of {src, id, name, sameOrigin}
- buttons: visible buttons/links — array of {tag, text}
- inputs: visible inputs — array of {type, label, placeholder}

Return contract — your body MUST return one of these shapes:
  return { message: "<short summary of what you did/saw>" };
  return { navigate: "https://...", message: "..." };
  return { sleep_ms: 500, message: "..." };

Rules:
- Output ONLY the function body. No \`\`\` fences, no signature, no prose.
- You MAY use \`await\` — the body runs inside async () => { ... }.
- Top-level cross-origin navigation MUST be requested via { navigate: "..." }.
- For shadow DOM: \`host.shadowRoot.querySelector(...)\` (recurse if nested).
- For same-origin iframes: \`iframe.contentDocument.querySelector(...)\`.
- For canvas drag: dispatchEvent(new MouseEvent('mousedown'/'mousemove'/
  'mouseup', {clientX, clientY, bubbles:true, button:0})).
- For typing into inputs: set \`.value = "..."\`, then dispatch \`input\` and
  \`change\` events. For form submit: \`form.requestSubmit()\` or \`form.submit()\`.
- For pagination/infinite scroll: programmatically scroll or modify the
  scroll container before querying.
- For fetch() of same-origin endpoints: \`await fetch(url, {...})\`.
- Keep the body short (~20 lines). If a task needs more, break it across
  multiple turns and use { message: "..." } to log progress; the predicate
  will fire when the page actually reaches the goal state.

Example bodies:

# Click a button matching some text:
const btn = Array.from(document.querySelectorAll('button')).find(b => /Continue/i.test(b.textContent));
if (!btn) return { message: 'no Continue button' };
btn.click();
return { message: 'clicked Continue', sleep_ms: 200 };

# Submit a form inside a shadow root:
const host = document.querySelector('shadow-form');
const root = host && host.shadowRoot;
const input = root && root.querySelector('input[name="code"]');
if (!input) return { message: 'shadow input not found' };
input.value = 'XYZ-42';
input.dispatchEvent(new Event('input', {bubbles:true}));
root.querySelector('form').requestSubmit();
return { message: 'submitted shadow form', sleep_ms: 200 };`;

export interface CodegenPredicateOpts {
  /** Inject an LLM client (for tests). Default uses defaultClient(env). */
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  /** Override the model name. Defaults to gpt-4o-mini. */
  model?: string;
  /** Override the loop step cap. Defaults to 12. */
  maxSteps?: number;
}

interface HistoryItem {
  scriptExcerpt: string;
  result: EmitResult;
  predicateAfter: { satisfied: boolean; error?: string };
}

export default class CodegenPredicateAgent extends Agent {
  readonly id = "codegen-predicate";

  private readonly opts: CodegenPredicateOpts;

  constructor(opts: CodegenPredicateOpts = {}) {
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
    const model = this.opts.model ?? process.env.GBA_MODEL ?? DEFAULT_MODEL;
    const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;

    let predicateExpr: string | null = null;
    const history: HistoryItem[] = [];

    try {
      const initialObs = await safeObserve(browser);

      // ----- 1) Synthesise the predicate (ONE upfront call) -----
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
          observation_summary: shortObs(initialObs),
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
          observation_summary: shortObs(initialObs),
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
          observation_summary: shortObs(initialObs),
          action: { type: "predicate_check", satisfied: true, phase: "initial" },
          latency_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        await trajectory.finish({ terminal_state: "DONE_BY_PREDICATE" });
        return trajectory;
      }

      // ----- 3) Action loop: ONE LLM call/step; code decides termination -----
      let step = 0;
      while (step < maxSteps) {
        budget.check();
        step += 1;

        const observation = await safeObserve(browser);
        const messages = buildActionMessages(goal, observation, history);
        const t0 = Date.now();
        let completion: string;
        try {
          const r = await llm.call(model, messages, { temperature: 0 });
          completion = r.text;
        } catch (err) {
          if (await declineOnLlmError(err, trajectory, step, observation, Date.now() - t0, "action")) {
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
            predicateAfter: { satisfied: false, error: "skipped" },
          });
          continue;
        }

        const tExec = Date.now();
        let result: EmitResult;
        try {
          result = await runEmittedScript(body, browser);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
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
        const execLatency = Date.now() - tExec;

        if (result.navigate) {
          try {
            await browser.navigate(result.navigate);
          } catch (err) {
            result = {
              ...result,
              ok: false,
              message: `navigate failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        if (result.sleep_ms && result.sleep_ms > 0) {
          await new Promise<void>((r) => setTimeout(r, result.sleep_ms ?? 0));
        }

        // The body's `done` field is IGNORED. The predicate decides.
        const check = await evaluatePredicate(predicateExpr, browser);

        await trajectory.addStep({
          step,
          observation_summary: shortObs(observation),
          action: {
            ...resultToRecord(body, result),
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
          scriptExcerpt: body.slice(0, 200),
          result,
          predicateAfter: check,
        });

        if (check.satisfied) {
          await trajectory.finish({ terminal_state: "DONE_BY_PREDICATE" });
          return trajectory;
        }

        budget.check();
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
            const status = r.ok ? "ok" : "fail";
            const pred = h.predicateAfter.satisfied
              ? "PRED=true"
              : h.predicateAfter.error
                ? `PRED=err(${truncate(h.predicateAfter.error, 60)})`
                : "PRED=false";
            const extras: string[] = [];
            if (r.navigate) extras.push(`navigate=${truncate(r.navigate, 80)}`);
            if (r.error) extras.push(`error=${truncate(r.error, 120)}`);
            const extraStr = extras.length ? ` [${extras.join(" ")}]` : "";
            return (
              `${i + 1}. script="${truncate(h.scriptExcerpt, 120)}"\n` +
              `   -> ${status}: ${truncate(r.message, 200)}${extraStr} [${pred}]`
            );
          })
          .join("\n");
  const user =
    `Goal: ${goal.trim()}\n\n` +
    `Recent scripts (with predicate verdict afterward):\n${historyText}\n\n` +
    `Current page:\n${formatObservation(observation)}\n\n` +
    `Reply with ONLY the body of an async JS function that advances toward ` +
    `the goal. Remember: there is NO done field — the predicate decides ` +
    `termination. Return one of: {message}, {navigate,message}, or ` +
    `{sleep_ms,message}.`;
  return [
    { role: "system", content: ACTION_PROMPT },
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
    script: truncate(body, SCRIPT_LOG_LIMIT),
    result: result.message,
  };
  if (result.navigate) rec.navigate = result.navigate;
  if (result.sleep_ms !== null) rec.sleep_ms = result.sleep_ms;
  if (result.error) rec.error = result.error;
  return rec;
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
      observation_summary: shortObs(obs),
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
      observation_summary: shortObs(obs),
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
