// vision-som browser agent (US-031). Successor to vision-grounded.
//
// Mechanism (Set-of-Marks; the WebVoyager / SeeAct / Operator fix for the
// documented failure mode of un-augmented vision agents):
//
//   1. PERCEPTION. Each step the harness walks the page, finds visible
//      interactive elements whose bbox intersects the viewport, stamps each
//      with `data-gba-som-id="<N>"`, and overlays a numbered red
//      rectangle on the live DOM. The viewport is then captured to JPEG and
//      the overlay is torn down. The LLM sees a multimodal user message
//      with the annotated screenshot AND a small text mark table
//      (`[N] role "name" bbox=x,y,wxh`).
//
//   2. ACTION. The LLM picks one mark id and one action verb; the harness
//      translates that to a CDP `Input.*` event dispatched at the centre
//      of the mark's recomputed bounding box. The LLM never emits raw
//      pixel coordinates.
//
// What this fixes vs vision-grounded (US-018, hard 0/10): the published
// failure analysis showed gpt-4o-mini and gpt-4o systematically
// centre-bias their (x,y) estimates and miss small targets. WebVoyager
// (2024) introduced Set-of-Marks specifically to remove that failure mode
// — by integer indirection through the DOM, the LLM only ever needs to
// pick a number, never localise a pixel. Operator and SeeAct followed.

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
  formatMarks,
  observePage,
  toDataUrl,
  type SomObservation,
  type Mark,
} from "./observe.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 12;
const HISTORY_LIMIT = 4;
/**
 * Brief settle after each state-changing action. Without it, the next
 * observation's overlay is drawn against a half-mutated DOM and we
 * occasionally screenshot before a banner reveal lands.
 */
const POST_ACTION_SETTLE_MS = 200;

const SYSTEM_PROMPT = `You are a Set-of-Marks browser-automation agent. You see ONE annotated
JPEG screenshot of the current viewport. Numbered red rectangles overlay
every interactive element the harness identified; each label is the
element's MARK ID. You also see a small text "Marks" table listing the
same ids alongside role/name/bbox.

You DO NOT emit pixel coordinates. You DO NOT emit CSS selectors. You
only ever name a target by its integer mark id. The harness translates
"click mark 7" to a CDP Input event dispatched at the centre of mark
7's recomputed bounding box.

Reply with ONLY this JSON object (no fences, no prose):

  {"type": "click",    "mark": <int>,                      "thought": "<short>"}
  {"type": "type",     "mark": <int>, "text": "<string>", "submit": false, "thought": "<short>"}
  {"type": "scroll",   "direction": "down",  "pixels": 400, "thought": "<short>"}
  {"type": "wait",     "ms": 400,                            "thought": "<short>"}
  {"type": "navigate", "url": "https://...",                 "thought": "<short>"}
  {"type": "done",     "reason": "<why goal is met>"}
  {"type": "decline",  "reason": "<why you cannot proceed>"}

Rules:
- Mark ids are FRESH each step. The id you see in this screenshot may not
  exist next step. Always pick an id from the CURRENT marks table.
- Use "type" for any text input (it focuses + clears the field, types,
  optionally presses Enter when "submit": true).
- Use "scroll" with direction="down" or "up" to bring more marks into
  view if the target is not labelled.
- Issue "done" only when the visible page state confirms the goal. If
  no progress is possible after several attempts, issue "decline".`;

export interface VisionSomOpts {
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  model?: string;
  maxSteps?: number;
  jpegQuality?: number;
  imageDetail?: "low" | "high" | "auto";
}

interface HistoryItem {
  label: string;
  result: ActionResult;
}

export default class VisionSomAgent extends Agent {
  readonly id = "vision-som";
  private readonly opts: VisionSomOpts;

  constructor(opts: VisionSomOpts = {}) {
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
    const jpegQuality = this.opts.jpegQuality ?? 70;
    const imageDetail = this.opts.imageDetail ?? "high";

    const history: HistoryItem[] = [];

    try {
      let step = 0;
      while (step < maxSteps) {
        budget.check();
        step += 1;

        const obs = await safeObserve(browser, jpegQuality);

        const messages = buildMessages(goal, obs, history, imageDetail, step);

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
          });
          budget.recordStep();
          continue;
        }

        const tExec = Date.now();
        let result: ActionResult;
        try {
          result = await executeAction(action, browser, obs.marks);
        } catch (err) {
          result = {
            ok: false,
            message: `execute threw: ${truncate(err instanceof Error ? err.message : String(err), 200)}`,
          };
        }
        if (action.type !== "wait" && action.type !== "done" && action.type !== "decline") {
          await new Promise<void>((r) => setTimeout(r, POST_ACTION_SETTLE_MS));
        }
        const execLatency = Date.now() - tExec;

        await trajectory.addStep({
          step,
          observation_summary: digestObservation(obs),
          action: actionToRecord(action, result),
          latency_ms: execLatency,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        budget.recordStep();

        history.push({ label: actionLabel(action), result });

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

async function safeObserve(
  browser: BrowserSession,
  jpegQuality: number,
): Promise<SomObservation> {
  try {
    return await observePage(browser, { jpegQuality });
  } catch (err) {
    return {
      url: "",
      title: `(observation failed: ${err instanceof Error ? err.message : String(err)})`,
      viewport: { width: 800, height: 600 },
      seq: -1,
      screenshot_jpeg: Buffer.alloc(0),
      marks: [],
      text: "",
    };
  }
}

export function buildMessages(
  goal: string,
  obs: SomObservation,
  history: HistoryItem[],
  imageDetail: "low" | "high" | "auto" = "high",
  step?: number,
): LLMMessage[] {
  const recent = history.slice(-HISTORY_LIMIT);
  const historyText =
    recent.length === 0
      ? "(no prior actions)"
      : recent
          .map((h, i) => {
            const ok = h.result.ok ? "ok" : "fail";
            return `${i + 1}. ${h.label} → ${ok}: ${truncate(h.result.message, 100)}`;
          })
          .join("\n");
  const stepLabel = step !== undefined ? `Step ${step}\n` : "";
  const banner =
    `${stepLabel}URL: ${obs.url}\n` +
    `Title: ${obs.title}\n` +
    `Viewport: ${obs.viewport.width} x ${obs.viewport.height}`;
  const marksText = formatMarks(obs.marks);
  const textBlock = obs.text ? `Page text: ${truncate(obs.text, 400)}\n\n` : "";
  const userText =
    `Goal: ${goal.trim()}\n\n` +
    `${banner}\n\n` +
    `Recent actions:\n${historyText}\n\n` +
    `${textBlock}` +
    `Marks (${obs.marks.length}):\n${marksText}\n\n` +
    `The annotated screenshot below shows the same marks. Decide the next action.`;

  if (obs.screenshot_jpeg.length === 0) {
    return [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `${userText}\n\n(SCREENSHOT UNAVAILABLE — observation failed.)`,
      },
    ];
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: toDataUrl(obs), detail: imageDetail } },
      ],
    },
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
  switch (action.type) {
    case "click":
      base.mark = action.mark;
      break;
    case "type":
      base.mark = action.mark;
      base.text = action.text;
      if (action.submit) base.submit = true;
      break;
    case "scroll":
      base.direction = action.direction;
      if (action.pixels !== undefined) base.pixels = action.pixels;
      break;
    case "wait":
      base.ms = action.ms;
      break;
    case "navigate":
      base.url = action.url;
      break;
    case "done":
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
  obs: SomObservation,
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

export type { Mark };
