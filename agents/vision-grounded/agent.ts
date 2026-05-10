// vision-grounded browser agent (US-018, fifth novel slot).
//
// Distinguishing mechanism (two axes both novel within this repo):
//
//   1. OBSERVATION MODALITY: the LLM sees a JPEG screenshot of the viewport.
//      No DOM walk, no a11y tree, no element list, no Set-of-Marks overlay.
//      Pure raw pixels. Every prior agent in this repo serialises the page
//      as text (a11y aids, button/input lists, body innerText, JS observation
//      script output). This one inverts that: the page is an image and the
//      LLM has to localise targets visually.
//
//   2. ACTION SUBSTRATE: actions never touch the DOM. Every action is
//      dispatched via CDP Input.* events at absolute (x,y) viewport
//      coordinates: Input.dispatchMouseEvent for clicks/moves/drag/wheel,
//      Input.dispatchKeyEvent for special keys, Input.insertText for typing.
//      No querySelector, no shadowRoot traversal, no in-page JS. The page
//      receives synthetic OS-level events as if a human moved a mouse.
//
// Compared to existing slots:
//   - baseline-a11y-react: aid-tagged a11y snapshot + JSON action set on aids.
//   - plan-then-execute:   text-keyed selectors resolved by an in-page DOM walk.
//   - runtime-codegen:     LLM emits raw JS bodies; manipulation via the DOM.
//   - speculative-rollback: CSS selectors + judge LLM; manipulation via DOM.
//   - predicate-driven:     CSS selectors + code-evaluated termination predicate.
//
// All five priors share a "DOM-mediated" substrate. This one has neither
// DOM observation nor DOM action, which is qualitatively different.
//
// Public-framework comparison (see README §Novelty for the long form):
//   - WebVoyager / SeeAct / Operator: also vision-flavoured but augment the
//     screenshot with Set-of-Marks overlays (numbered DOM-derived bounding
//     boxes); the LLM picks an id, which the framework resolves DOM-side.
//     This agent skips that — pure pixels in, pixel coordinates out.
//   - browser-use / Stagehand: DOM-grounded.
//
// Cost shape: 1 vision LLM call per step. JPEG quality=70 keeps a viewport
// at ~30-60 KB, billed at OpenAI vision rates (currently $.000425 per image
// for gpt-4o-mini at "auto" detail). Roughly 10-20× a text-only call;
// budgeted accordingly via maxSteps.

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
  observePage,
  toDataUrl,
  type VisionObservation,
} from "./observe.js";

// Default model. gpt-4o-mini and gpt-4o both struggle with sub-100px
// pixel localisation on the harness's typical 780×441 viewport — they
// know what to click ("Submit order") but the x-coordinate they emit
// is consistently centre-biased. The bigger model is no better
// empirically on the hard slice, so we use the cheaper one by default
// and leave the choice as a constructor option for future tuning.
// See README.md §Failure analysis for the full empirical write-up.
export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_MAX_STEPS = 10;
const HISTORY_LIMIT = 4;
/**
 * After an action, wait briefly before re-observing. Network responses,
 * banner reveals, and post-click DOM mutations are async and a screenshot
 * grabbed too eagerly will miss them. 200ms is short enough not to dent
 * the wall budget but long enough to let the typical fetch + paint settle.
 */
const POST_ACTION_SETTLE_MS = 200;

const SYSTEM_PROMPT = `You are a vision-grounded browser-automation agent. You see ONLY a JPEG
screenshot of the current browser viewport and a small text banner with the
URL, page title, and viewport dimensions. There is NO DOM dump, NO element
list, NO Set-of-Marks overlay. You must visually identify targets in the
image and emit absolute (x, y) viewport pixel coordinates.

The action layer dispatches your moves at the OS event level (Chrome
DevTools Input.* commands), not via DOM querySelector. This means clicks
work on canvas, shadow DOM, iframes, and ordinary HTML uniformly — but it
also means you have to localise carefully. The viewport's origin (0,0) is
the TOP-LEFT corner; +x is right, +y is down. Coordinates are clamped to
the viewport at execution time.

Reply with ONLY this JSON object (no prose, no fences):

  {"type": "click",        "x": <int>, "y": <int>, "thought": "<short>"}
  {"type": "double_click", "x": <int>, "y": <int>}
  {"type": "move",         "x": <int>, "y": <int>}      // mouse move (hover)
  {"type": "drag",         "x1": <int>, "y1": <int>, "x2": <int>, "y2": <int>}
  {"type": "type",         "text": "<string>"}          // sends keystrokes to focused element
  {"type": "press",        "key": "Enter"}              // Enter, Tab, Escape, Arrow*, Backspace, etc.
  {"type": "scroll",       "x": <int>, "y": <int>, "delta_y": 400}
  {"type": "wait",         "ms": 500}
  {"type": "navigate",     "url": "https://..."}
  {"type": "finish",       "reason": "<short>"}

Rules:
- "type" sends keystrokes to whatever element is focused. To enter text in a
  field, FIRST click into the field at its visible centre, THEN emit type.
- After typing in a search/text field, "press":"Enter" submits.
- "scroll" with positive delta_y scrolls DOWN; negative scrolls UP. The
  (x, y) is the cursor position the wheel event is anchored at — usually the
  middle of the area you want to scroll.
- "drag" is one mouse press at (x1, y1), motion to (x2, y2), then release at
  (x2, y2). Use it for HTML5 drag-and-drop and canvas dragging.
- "navigate" is for URL changes only (typing into the address bar). Use it
  sparingly; clicking links in the page is usually better.
- "finish" terminates the run with terminal_state=DONE. Only emit it once
  the visible state of the page makes it obvious the goal is met.
- Output ONLY the JSON object.`;

export interface VisionGroundedOpts {
  /** Inject an LLM client (used by tests). Default: defaultClient(env). */
  llmFactory?: (budget: Budget, trajectory: Trajectory) => LLMClient;
  /** Vision-capable model name. Defaults to gpt-4o-mini. */
  model?: string;
  /** Loop step cap. Each step issues 1 vision LLM call. */
  maxSteps?: number;
  /** Override viewport dimensions for action coordinate clamping. */
  viewport?: { width: number; height: number };
  /** JPEG quality (1-100). Lower = cheaper tokens, less detail. */
  jpegQuality?: number;
  /**
   * OpenAI vision detail tier. "low" charges a flat 85 tokens per image
   * regardless of resolution; "high" charges 85 + (n_tiles × 170) using a
   * 512×512 tile grid. For a typical ~800×600 viewport that is roughly
   * 4 tiles → ~765 tokens per image. "auto" picks one based on size.
   *
   * Default "high" because pixel-localisation at "low" is too coarse for
   * normal-sized buttons (a 100×30 button on an 800×600 page is below the
   * effective resolution after the 512×512 thumbnail "low" applies); the
   * extra ~700 tokens per call is well within the per-task token budget.
   */
  imageDetail?: "low" | "high" | "auto";
}

interface HistoryItem {
  label: string;
  result: ActionResult;
}

export default class VisionGroundedAgent extends Agent {
  readonly id = "vision-grounded";
  private readonly opts: VisionGroundedOpts;

  constructor(opts: VisionGroundedOpts = {}) {
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
    const jpegQuality = this.opts.jpegQuality ?? 70;
    const imageDetail = this.opts.imageDetail ?? "high";

    const history: HistoryItem[] = [];

    try {
      let step = 0;
      while (step < maxSteps) {
        budget.check();
        step += 1;

        const obs = await safeObserve(browser, {
          viewport: this.opts.viewport,
          jpegQuality,
        });

        // The step number is part of the prompt so an unchanged screenshot
        // doesn't trap the agent in a cached-reply loop. Two identical
        // observations N steps apart will still hash to different cache
        // keys, forcing the LLM to reconsider rather than serve a stale
        // action that already failed.
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
          result = await executeAction(action, browser, obs.viewport);
        } catch (err) {
          result = {
            ok: false,
            message: `execute threw: ${truncate(err instanceof Error ? err.message : String(err), 200)}`,
          };
        }
        // Settle: let async post-action effects (fetch, banner reveal, DOM
        // mutation) finish before the next observation captures the page.
        // Skip after `wait` (no extra delay needed) and `finish` (loop ends
        // anyway). Fixed delay regardless of action — keeps trajectory
        // timing predictable.
        if (action.type !== "wait" && action.type !== "finish") {
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

        if (action.type === "finish") {
          await trajectory.finish({ terminal_state: "DONE" });
          return trajectory;
        }
      }

      await trajectory.finish({
        terminal_state: "DECLINED",
        decline_reason: `max steps (${maxSteps}) exhausted without finish action`,
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
  opts: { viewport?: { width: number; height: number }; jpegQuality?: number },
): Promise<VisionObservation> {
  try {
    return await observePage(browser, opts);
  } catch (err) {
    // Synthesise a placeholder observation so the loop can still report a
    // step and let the LLM see the failure as the next observation.
    const w = opts.viewport?.width ?? 800;
    const h = opts.viewport?.height ?? 600;
    const stub = Buffer.alloc(0);
    return {
      url: "",
      title: `(observation failed: ${err instanceof Error ? err.message : String(err)})`,
      viewport: { width: w, height: h },
      seq: -1,
      screenshot_jpeg: stub,
    };
  }
}

export function buildMessages(
  goal: string,
  obs: VisionObservation,
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
            return `${i + 1}. ${h.label} → ${ok}: ${truncate(h.result.message, 90)}`;
          })
          .join("\n");
  const stepLabel = step !== undefined ? `Step ${step}\n` : "";
  const banner =
    `${stepLabel}URL: ${obs.url}\n` +
    `Title: ${obs.title}\n` +
    `Viewport: ${obs.viewport.width} x ${obs.viewport.height} (top-left is 0,0)`;
  const userText =
    `Goal: ${goal.trim()}\n\n` +
    `${banner}\n\n` +
    `Recent actions:\n${historyText}\n\n` +
    `The screenshot below shows the current viewport. Decide the next action; ` +
    `reply with ONLY the JSON object.`;

  // If we have an actual screenshot, send a multimodal message; otherwise
  // fall back to text so the loop still moves (e.g. observation failed).
  if (obs.screenshot_jpeg.length === 0) {
    return [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `${userText}\n\n(SCREENSHOT UNAVAILABLE — observation failed; the title banner above contains the failure message.)`,
      },
    ];
  }

  const dataUrl = toDataUrl(obs);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: dataUrl, detail: imageDetail } },
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
    case "double_click":
    case "move":
      base.x = action.x;
      base.y = action.y;
      break;
    case "drag":
      base.x1 = action.x1;
      base.y1 = action.y1;
      base.x2 = action.x2;
      base.y2 = action.y2;
      break;
    case "type":
      base.text = action.text;
      break;
    case "press":
      base.key = action.key;
      break;
    case "scroll":
      base.x = action.x;
      base.y = action.y;
      base.delta_y = action.delta_y;
      if (action.delta_x !== undefined) base.delta_x = action.delta_x;
      break;
    case "wait":
      base.ms = action.ms;
      break;
    case "navigate":
      base.url = action.url;
      break;
    case "finish":
      base.reason = action.reason;
      break;
  }
  return base;
}

async function declineOnLlmError(
  err: unknown,
  trajectory: Trajectory,
  step: number,
  obs: VisionObservation,
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
