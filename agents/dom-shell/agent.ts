// dom-shell browser agent (US-033).
//
// The DOM tree is a filesystem; the LLM is a shell user. Each turn the LLM
// emits ONE shell-style line — `ls`, `cd form[name="login"]`, `cat`,
// `grep "Total"`, `find button --interactive`, `click "Continue"`,
// `type input[name="email"] "user@example.com" --submit`, `scroll`, `wait`,
// `done`. The harness tokenises, dispatches the command to a small in-page
// handler via CDP Runtime.evaluate, and persists the result.
//
// The CWD is a CSS-selector chain (a stack of segments joined by descendant
// combinators) that PERSISTS across steps. `cd subtree` pushes; `cd ..` pops;
// `cd /` resets to root. Action commands (click/type) resolve relative to
// the cwd — so once the LLM has `cd`d into a shadow-host wrapper or a
// complex form, it can operate with terse local-relative selectors.
//
// Distinct from prior agents:
//   - baseline-a11y-react: fixed JSON action set keyed by data-gba-aid.
//   - plan-then-execute:   batch text-keyed plan.
//   - runtime-codegen:     UNBOUNDED JS bodies. We constrain the LLM to a
//                          tiny vocabulary compiled to small evaluates.
//   - predicate-driven:    code-decided termination on selectors. We have
//                          a persistent cwd which they do not.
//
// Action substrate: shell command vocabulary compiled to Runtime.evaluate.

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
  commandLabel,
  cwdDisplay,
  cwdSelector,
  execCommand,
  parseCommand,
  ShellParseError,
  type ExecResult,
  type ShellCommand,
} from "./shell.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 16;
const HISTORY_LIMIT = 6;
const POST_ACTION_SETTLE_MS = 150;

const SYSTEM_PROMPT = `You are a DOM-as-filesystem browser agent. You drive a real web page using a
TINY shell vocabulary, one command per turn. The DOM tree IS the filesystem.

Your CWD is a CSS-selector chain that PERSISTS across turns. \`cd\` into a
subtree to operate on it with short local-relative selectors; \`cd ..\` to
pop; \`cd /\` to reset to root.

VOCABULARY (one line per turn — NO prose, NO fences):

  ls [selector]                   list children of cwd (or of cwd>selector)
  cd <selector|..|/>              push / pop / reset cwd
  cat [selector]                  read innerText (capped 4000 chars)
  grep <regex> [selector]         filter cat output by regex
  find <selector> [--interactive] querySelectorAll under cwd, visible only
  attr <name> [selector]          read one attribute
  click <selector>                click an element (cwd-relative)
  type <selector> "<text>" [--submit]  fill input; --submit presses Enter
  scroll [up|down] [pixels]       scroll the viewport (default: down 400)
  wait [ms]                       sleep (default 400ms, cap 5000)
  done <reason>                   goal met
  decline <reason>                cannot proceed

RULES:
- Output ONLY the command line. No fences, no commentary.
- Quote args with spaces using double quotes.
- Selectors are CSS. Action commands resolve relative to cwd.
- find --interactive filters to button/a/input/textarea/select.
- If a cwd \`cd\` fails to resolve, cwd is unchanged — try again or \`cd /\`.
- Use \`ls\` and \`find\` to discover targets before clicking blind.
- Issue \`done\` only when the page confirms the goal. Issue \`decline\` only
  if you have tried multiple distinct approaches.

EXAMPLES:
  ls
  cd form#login
  find input --interactive
  type input[name="email"] "user@example.com"
  type input[name="password"] "hunter2" --submit
  cat
  grep "Order confirmed"
  done order placed`;

export interface DomShellOpts {
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  model?: string;
  maxSteps?: number;
}

interface HistoryItem {
  cwd: string;
  label: string;
  result: ExecResult;
}

export default class DomShellAgent extends Agent {
  readonly id = "dom-shell";
  private readonly opts: DomShellOpts;

  constructor(opts: DomShellOpts = {}) {
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

    const cwd: string[] = [];
    const history: HistoryItem[] = [];

    try {
      let step = 0;
      while (step < maxSteps) {
        budget.check();
        step += 1;

        // If cwd no longer resolves (e.g. navigation), reset to root before
        // showing the LLM a misleading cwd display.
        await this.ensureCwdResolves(cwd, browser);

        const messages = await buildMessages(goal, cwd, history, browser, step);
        const t0 = Date.now();
        let completion: string;
        try {
          const r = await llm.call(model, messages, { temperature: 0 });
          completion = r.text;
        } catch (err) {
          if (await declineOnLlmError(err, trajectory, step, cwd, Date.now() - t0)) {
            return trajectory;
          }
          throw err;
        }
        const llmLatency = Date.now() - t0;

        let cmd: ShellCommand;
        try {
          cmd = parseCommand(completion);
        } catch (err) {
          const msg = err instanceof ShellParseError ? err.message : String(err);
          await trajectory.addStep({
            step,
            observation_summary: `cwd=${cwdDisplay(cwd)}`,
            action: {
              type: "parse_error",
              cwd: cwdDisplay(cwd),
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
            cwd: cwdDisplay(cwd),
            label: "(parse_error)",
            result: { ok: false, output: "", error: `parse error: ${msg}`, extras: {} },
          });
          budget.recordStep();
          continue;
        }

        const tExec = Date.now();
        let result: ExecResult;
        try {
          result = await execCommand(cmd, cwd, browser);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { ok: false, output: "", error: `exec threw: ${msg}`, extras: {} };
        }
        const execLatency = Date.now() - tExec;

        if (cmd.cmd !== "wait" && cmd.cmd !== "done" && cmd.cmd !== "decline") {
          await new Promise<void>((r) => setTimeout(r, POST_ACTION_SETTLE_MS));
        }

        await trajectory.addStep({
          step,
          observation_summary: `cwd=${cwdDisplay(cwd)}`,
          action: actionRecord(cmd, cwd, result),
          latency_ms: execLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        budget.recordStep();

        history.push({ cwd: cwdDisplay(cwd), label: commandLabel(cmd), result });

        if (cmd.cmd === "done") {
          await trajectory.finish({ terminal_state: "DONE" });
          return trajectory;
        }
        if (cmd.cmd === "decline") {
          await trajectory.finish({
            terminal_state: "DECLINED",
            decline_reason: cmd.reason,
          });
          return trajectory;
        }
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

  /**
   * Probe the current cwd selector in-page; if it no longer resolves (e.g.
   * because of a navigation), reset cwd to root so the LLM is not misled.
   */
  private async ensureCwdResolves(cwd: string[], browser: BrowserSession): Promise<void> {
    const sel = cwdSelector(cwd);
    if (!sel) return;
    try {
      const ok = await browser.evaluate<boolean>(
        `(() => { try { return Boolean(document.querySelector(${JSON.stringify(sel)})); } catch (e) { return false; } })()`,
      );
      if (!ok) cwd.length = 0;
    } catch {
      cwd.length = 0;
    }
  }
}

function actionRecord(
  cmd: ShellCommand,
  cwd: string[],
  result: ExecResult,
): { type: string } & Record<string, unknown> {
  return {
    type: "shell",
    cmd: cmd.cmd,
    label: commandLabel(cmd),
    cwd: cwdDisplay(cwd),
    ok: result.ok,
    output: truncate(result.output, 500),
    error: result.error,
    extras: result.extras,
  };
}

async function buildMessages(
  goal: string,
  cwd: string[],
  history: HistoryItem[],
  browser: BrowserSession,
  step: number,
): Promise<LLMMessage[]> {
  const banner = await pageBanner(browser);
  const recent = history.slice(-HISTORY_LIMIT);
  const historyText =
    recent.length === 0
      ? "(no prior commands)"
      : recent
          .map((h, i) => {
            const tag = h.result.ok ? "ok" : "FAIL";
            const msg = h.result.ok
              ? truncate(h.result.output, 200)
              : truncate(h.result.error ?? "(error)", 200);
            return `${i + 1}. [cwd=${h.cwd}] $ ${h.label}\n   ${tag}: ${msg}`;
          })
          .join("\n");

  const user =
    `Goal: ${goal.trim()}\n\n` +
    `Step ${step}\n` +
    `${banner}\n` +
    `cwd: ${cwdDisplay(cwd)}\n\n` +
    `Recent shell history:\n${historyText}\n\n` +
    `Emit ONE command for the next step.`;

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

async function pageBanner(browser: BrowserSession): Promise<string> {
  try {
    const info = await browser.evaluate<{ url: string; title: string }>(
      `(() => ({ url: document.location ? document.location.href : "", title: document.title || "" }))()`,
    );
    return `URL: ${info.url}\nTitle: ${info.title}`;
  } catch {
    return `URL: (unavailable)\nTitle: (unavailable)`;
  }
}

async function declineOnLlmError(
  err: unknown,
  trajectory: Trajectory,
  step: number,
  cwd: string[],
  latency: number,
): Promise<boolean> {
  if (err instanceof LLMProviderUnavailableError) {
    await trajectory.addStep({
      step,
      observation_summary: `cwd=${cwdDisplay(cwd)}`,
      action: { type: "noop", cwd: cwdDisplay(cwd), reason: "no LLM provider configured" },
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
      observation_summary: `cwd=${cwdDisplay(cwd)}`,
      action: { type: "noop", cwd: cwdDisplay(cwd), reason: "LLM replay miss" },
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
