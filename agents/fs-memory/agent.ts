// fs-memory: filesystem-as-working-memory browser agent (US-021, slot 12).
//
// MECHANISM (single sentence): the prompt contains only the current page
// banner + the scratch directory's file tree + the result of the last
// action, and the LLM curates all observation history by writing/reading
// files in a per-task scratch directory at <trajectoryDir>/scratch/.
//
// Distinctness axis: OBSERVATION STORAGE. Every prior agent stores
// observation history in the LLM context window (HISTORY_LIMIT N actions
// of trace per step). This agent's prompt is constant-shape regardless of
// step number — observations the LLM wants to remember MUST be persisted
// to disk via fs.write/fs.append and re-read via fs.read on a future step.
// The scratch tree is the entire externalised memory.
//
// Action substrate: named JSON actions, split into three families.
//   fs.write / fs.append / fs.read / fs.list / fs.delete   (scratch IO)
//   browser.observe / browser.click / browser.type /        (browser ops)
//   browser.navigate / browser.scroll / browser.wait
//   done / decline                                          (terminate)
//
// browser.observe is the single channel for getting page state into the
// agent — it returns interactive elements + page text for one turn, after
// which the agent must persist what it wants to keep. The prompt does NOT
// fold prior observations forward.

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
  actionLabel,
  ActionParseError,
  parseAction,
  type AgentAction,
} from "./actions.js";
import { ScratchFs, ScratchPathError } from "./scratch.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 18;
const POST_ACTION_SETTLE_MS = 150;
const OBSERVE_TEXT_LIMIT = 1500;
const OBSERVE_ELEMENTS_LIMIT = 25;
const LAST_RESULT_DISPLAY = 600;

const SYSTEM_PROMPT = `You are a browser agent whose working memory is a small FILESYSTEM, not the
prompt. Each turn the prompt shows you only:
  - the current page banner (URL + title),
  - the file tree of your scratch directory (with byte sizes),
  - the result of your LAST action (truncated).
There is NO rolling action history. If you want to remember something past
the next turn, WRITE it to a file. To recall it, READ the file.

Emit EXACTLY ONE JSON object per turn (no fences, no prose).

ACTIONS — filesystem (scoped to scratch/, paths must be relative):
  {"type":"fs.write",  "path":"notes.md", "content":"..."}
  {"type":"fs.append", "path":"log.txt",  "content":"..."}
  {"type":"fs.read",   "path":"notes.md"}              ← result shows in next prompt
  {"type":"fs.list"}                                    ← re-prints the tree
  {"type":"fs.delete", "path":"notes.md"}

ACTIONS — browser:
  {"type":"browser.observe"}                            ← page text + interactive elements
  {"type":"browser.observe", "selector":"form#login"}
  {"type":"browser.click",   "selector":"button.submit"}
  {"type":"browser.type",    "selector":"input[name=q]", "text":"...", "submit":true}
  {"type":"browser.navigate","url":"https://..."}
  {"type":"browser.scroll",  "direction":"down", "pixels":400}
  {"type":"browser.wait",    "ms":500}

ACTIONS — terminate:
  {"type":"done",    "reason":"goal met"}
  {"type":"decline", "reason":"cannot proceed"}

WORKFLOW (typical):
  1. fs.write plan.md with your decomposition of the goal.
  2. browser.observe to see the page. The result will be in the NEXT prompt's
     "last action result" — if you want it later, fs.append it to observations.md.
  3. Perform browser actions one at a time. After each, observe again if the
     page may have changed.
  4. When the page confirms success, emit done.

Discipline: prompt context is constant-shape — DO NOT rely on prior turns'
text being visible. The scratch directory is your only durable memory.`;

export interface FsMemoryOpts {
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  model?: string;
  maxSteps?: number;
}

export default class FsMemoryAgent extends Agent {
  readonly id = "fs-memory";
  private readonly opts: FsMemoryOpts;

  constructor(opts: FsMemoryOpts = {}) {
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

    const scratch = new ScratchFs(`${trajectory.dir}/scratch`);
    let lastResult: { ok: boolean; summary: string; output?: string } = {
      ok: true,
      summary: "(no actions yet — start by writing your plan to scratch/plan.md)",
    };

    try {
      let step = 0;
      while (step < maxSteps) {
        budget.check();
        step += 1;

        const tree = await scratch.tree();
        const messages = await buildMessages(goal, browser, tree, lastResult, step);

        const t0 = Date.now();
        let completion: string;
        try {
          const r = await llm.call(model, messages, { temperature: 0 });
          completion = r.text;
        } catch (err) {
          if (await declineOnLlmError(err, trajectory, step, Date.now() - t0)) {
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
            observation_summary: `tree=${tree.length} entries`,
            action: { type: "parse_error", raw: completion.slice(0, 200), error: msg },
            latency_ms: llmLatency,
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            screenshot_path: null,
            verifier_state: null,
          });
          lastResult = { ok: false, summary: `parse error: ${msg}` };
          budget.recordStep();
          continue;
        }

        const tExec = Date.now();
        const execResult = await executeAction(action, browser, scratch);
        const execLatency = Date.now() - tExec;

        if (
          action.type !== "browser.wait" &&
          action.type !== "done" &&
          action.type !== "decline" &&
          action.type.startsWith("browser.")
        ) {
          await new Promise<void>((r) => setTimeout(r, POST_ACTION_SETTLE_MS));
        }

        await trajectory.addStep({
          step,
          observation_summary: `tree=${tree.length} entries`,
          action: {
            type: "fs_memory",
            kind: action.type,
            label: actionLabel(action),
            ok: execResult.ok,
            summary: truncate(execResult.summary, 400),
            ...(execResult.output !== undefined
              ? { output: truncate(execResult.output, 400) }
              : {}),
          },
          latency_ms: execLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        budget.recordStep();

        lastResult = execResult;

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

export interface ExecResult {
  ok: boolean;
  summary: string;
  /**
   * Body returned to the LLM as the next prompt's last-action output (e.g.
   * file contents on fs.read, observe payload on browser.observe). Distinct
   * from `summary` (one-line headline).
   */
  output?: string;
}

export async function executeAction(
  action: AgentAction,
  browser: BrowserSession,
  scratch: ScratchFs,
): Promise<ExecResult> {
  try {
    switch (action.type) {
      case "fs.write": {
        const r = await scratch.write(action.path, action.content);
        return { ok: true, summary: `wrote ${r.path} (${r.bytes} bytes)` };
      }
      case "fs.append": {
        const r = await scratch.append(action.path, action.content);
        return { ok: true, summary: `appended ${action.path} → ${r.bytes} bytes` };
      }
      case "fs.read": {
        const r = await scratch.read(action.path);
        const head = r.truncated
          ? `${action.path} (${r.bytes} bytes, truncated to ${ScratchFs.MAX_READ_BYTES}):`
          : `${action.path} (${r.bytes} bytes):`;
        return { ok: true, summary: `read ${action.path}`, output: `${head}\n${r.content}` };
      }
      case "fs.list": {
        const tree = await scratch.tree();
        const body = tree.length === 0 ? "(empty)" : tree.join("\n");
        return { ok: true, summary: `listed ${tree.length} entries`, output: body };
      }
      case "fs.delete": {
        await scratch.remove(action.path);
        return { ok: true, summary: `deleted ${action.path}` };
      }
      case "browser.observe": {
        const ob = await observePage(browser, action.selector);
        return { ok: true, summary: ob.summary, output: ob.body };
      }
      case "browser.click": {
        const r = await runClick(browser, action.selector);
        return r;
      }
      case "browser.type": {
        const r = await runType(browser, action.selector, action.text, action.submit === true);
        return r;
      }
      case "browser.navigate": {
        await browser.navigate(action.url);
        return { ok: true, summary: `navigated to ${action.url}` };
      }
      case "browser.scroll": {
        const px = action.pixels ?? 400;
        const dy = (action.direction ?? "down") === "up" ? -px : px;
        await browser.evaluate(`window.scrollBy(0, ${dy})`);
        return { ok: true, summary: `scrolled ${action.direction ?? "down"} ${px}px` };
      }
      case "browser.wait": {
        const ms = action.ms ?? 400;
        await new Promise<void>((r) => setTimeout(r, ms));
        return { ok: true, summary: `waited ${ms}ms` };
      }
      case "done":
        return { ok: true, summary: `done: ${action.reason}` };
      case "decline":
        return { ok: true, summary: `decline: ${action.reason}` };
    }
  } catch (err) {
    if (err instanceof ScratchPathError) {
      return { ok: false, summary: `scratch error: ${err.message}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `action threw: ${msg}` };
  }
  return { ok: false, summary: "unreachable" };
}

async function runClick(browser: BrowserSession, selector: string): Promise<ExecResult> {
  const script = `(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, summary: 'no element matches selector' };
      if (el.disabled) return { ok: false, summary: 'element is disabled' };
      el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true, summary: 'clicked ' + (el.tagName||'').toLowerCase() };
    } catch (e) { return { ok: false, summary: 'click threw: ' + (e && e.message || e) }; }
  })()`;
  return await browser.evaluate<ExecResult>(script);
}

async function runType(
  browser: BrowserSession,
  selector: string,
  text: string,
  submit: boolean,
): Promise<ExecResult> {
  const script = `(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, summary: 'no element matches selector' };
      if (el.disabled) return { ok: false, summary: 'element is disabled' };
      el.focus && el.focus();
      if ('value' in el) {
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        return { ok: false, summary: 'element is not a text input' };
      }
      if (${submit ? "true" : "false"}) {
        const form = el.form || (el.closest && el.closest('form'));
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
        else if (form) form.submit();
      }
      return { ok: true, summary: 'typed into ' + (el.tagName||'').toLowerCase() + (${submit ? "true" : "false"} ? ' and submitted' : '') };
    } catch (e) { return { ok: false, summary: 'type threw: ' + (e && e.message || e) }; }
  })()`;
  return await browser.evaluate<ExecResult>(script);
}

/**
 * Single-turn page observation: interactive element list + truncated body
 * text. Scoped to `selector` if provided. The agent must fs.write the parts
 * it wants to remember — the OUTPUT only appears in the very next prompt.
 */
async function observePage(
  browser: BrowserSession,
  selector?: string,
): Promise<{ summary: string; body: string }> {
  const script = `(() => {
    const scope = ${selector ? `document.querySelector(${JSON.stringify(selector)}) || document` : "document"};
    if (!scope || scope === null) return { url:'', title:'', text:'', elements: [], scope_missing: true };
    const root = (scope.nodeType === 9 /* Document */) ? document.body : scope;
    const sels = ['button','a[href]','input:not([type=hidden])','select','textarea','[role="button"]','[role="link"]'];
    const seen = new Set();
    const els = [];
    (root || document.body).querySelectorAll(sels.join(',')).forEach((el) => {
      if (seen.has(el)) return; seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const name = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').toString().trim().slice(0, 60);
      const type = el.type || '';
      const id = el.id || '';
      const className = (typeof el.className === 'string' ? el.className : '').toString().slice(0, 40);
      els.push({ tag, role, name, type, id, class: className });
    });
    const txt = (root && root.innerText ? root.innerText : '').slice(0, ${OBSERVE_TEXT_LIMIT});
    return {
      url: document.location ? document.location.href : '',
      title: document.title || '',
      text: txt,
      elements: els.slice(0, ${OBSERVE_ELEMENTS_LIMIT}),
    };
  })()`;
  const obs = await browser.evaluate<{
    url: string;
    title: string;
    text: string;
    elements: Array<{ tag: string; role: string; name: string; type: string; id: string; class: string }>;
    scope_missing?: boolean;
  }>(script);

  if (obs.scope_missing) {
    return { summary: `selector ${selector} matched nothing`, body: "" };
  }

  const lines = obs.elements.map((e) => {
    const idPart = e.id ? `#${e.id}` : "";
    const classPart = e.class ? `.${e.class.split(/\s+/).slice(0, 2).join(".")}` : "";
    const typePart = e.type ? `[type=${e.type}]` : "";
    const rolePart = e.role ? `[role=${e.role}]` : "";
    return `- <${e.tag}${idPart}${classPart}${typePart}${rolePart}> "${e.name}"`;
  });
  const body =
    `URL: ${obs.url}\nTitle: ${obs.title}\n` +
    `Interactive elements (${obs.elements.length}):\n` +
    (lines.length === 0 ? "(none)" : lines.join("\n")) +
    `\n\nPage text (first ${OBSERVE_TEXT_LIMIT} chars):\n${obs.text}`;
  return {
    summary: `observed ${obs.elements.length} interactive elements, ${obs.text.length} chars of text`,
    body,
  };
}

async function buildMessages(
  goal: string,
  browser: BrowserSession,
  tree: string[],
  lastResult: { ok: boolean; summary: string; output?: string },
  step: number,
): Promise<LLMMessage[]> {
  const banner = await pageBanner(browser);
  const treeText = tree.length === 0 ? "(empty)" : tree.join("\n");
  const resultTag = lastResult.ok ? "ok" : "FAIL";
  const summaryLine = `${resultTag}: ${lastResult.summary}`;
  const outputText = lastResult.output
    ? `\n--- last action output ---\n${truncate(lastResult.output, LAST_RESULT_DISPLAY)}\n--- end output ---`
    : "";
  const user =
    `Goal: ${goal.trim()}\n\n` +
    `Step ${step}\n` +
    `${banner}\n\n` +
    `scratch/ tree:\n${treeText}\n\n` +
    `Last action result:\n${summaryLine}${outputText}\n\n` +
    `Emit ONE JSON action.`;
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
  latency: number,
): Promise<boolean> {
  if (err instanceof LLMProviderUnavailableError) {
    await trajectory.addStep({
      step,
      observation_summary: "(no LLM provider)",
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
      observation_summary: "(LLM replay miss)",
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
