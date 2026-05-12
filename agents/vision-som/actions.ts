// Action substrate for vision-som.
//
// Actions are mark-id-keyed, NEVER pixel coordinates. The harness translates
// each action against the stable element behind `data-gba-som-id="<id>"`,
// which was stamped on the page by the most recent observation.
//
// Click and type are dispatched via CDP Input.* events at the centre of the
// element's freshly-recomputed bounding box (after a scrollIntoView), so we
// retain the vision-grounded property of "synthetic OS-level events" — what
// changed vs vision-grounded is that the LLM no longer guesses pixels: the
// harness derives them from the DOM behind the mark id.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

import type { Mark } from "./observe.js";

export type AgentAction =
  | { type: "click"; mark: number; thought?: string }
  | {
      type: "type";
      mark: number;
      text: string;
      submit?: boolean;
      thought?: string;
    }
  | {
      type: "scroll";
      direction: "up" | "down" | "left" | "right";
      pixels?: number;
      thought?: string;
    }
  | { type: "wait"; ms: number; thought?: string }
  | { type: "navigate"; url: string; thought?: string }
  | { type: "done"; reason: string; thought?: string }
  | { type: "decline"; reason: string; thought?: string };

export class ActionParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "ActionParseError";
    this.raw = raw;
  }
}

const KNOWN_TYPES = new Set([
  "click",
  "type",
  "scroll",
  "wait",
  "navigate",
  "done",
  "decline",
]);

const ALIASES: Record<string, string> = {
  finish: "done",
  goto: "navigate",
  fill: "type",
  input: "type",
  text: "type",
};

export function parseAction(raw: string): AgentAction {
  if (raw == null) throw new ActionParseError("empty completion", "");
  const text = stripFences(String(raw).trim());
  if (!text) throw new ActionParseError("empty completion", raw);
  const obj = extractFirstObject(text);
  if (!obj) throw new ActionParseError("no JSON object in completion", raw);

  const inner =
    typeof obj.action === "object" && obj.action !== null && obj.type === undefined
      ? (obj.action as Record<string, unknown>)
      : obj;
  const wrapperThought =
    obj !== inner && typeof obj.thought === "string" ? obj.thought : undefined;
  const rawType = String(inner.type ?? inner.action ?? "")
    .toLowerCase()
    .replace(/[\s-]/g, "_");
  const t = ALIASES[rawType] ?? rawType;
  if (!KNOWN_TYPES.has(t)) {
    throw new ActionParseError(`unknown action type ${JSON.stringify(t)}`, raw);
  }
  const thought =
    typeof inner.thought === "string"
      ? inner.thought
      : typeof inner.rationale === "string"
        ? inner.rationale
        : wrapperThought;
  const withThought = <A extends AgentAction>(a: A): A =>
    thought !== undefined ? ({ ...a, thought } as A) : a;

  if (t === "click") {
    return withThought({ type: "click", mark: parseMark(inner, raw) });
  }
  if (t === "type") {
    const txt = inner.text ?? inner.value ?? inner.string;
    if (typeof txt !== "string") {
      throw new ActionParseError("type action missing text", raw);
    }
    if (!txt) throw new ActionParseError("type action: text is empty", raw);
    const submitRaw = inner.submit ?? inner.press_enter ?? inner.enter;
    const submit = submitRaw === true || submitRaw === "true";
    return withThought({ type: "type", mark: parseMark(inner, raw), text: txt, submit });
  }
  if (t === "scroll") {
    const dirRaw = String(inner.direction ?? "down").toLowerCase();
    if (!["up", "down", "left", "right"].includes(dirRaw)) {
      throw new ActionParseError(`scroll direction must be up/down/left/right`, raw);
    }
    const direction = dirRaw as "up" | "down" | "left" | "right";
    const pxRaw = inner.pixels ?? inner.amount ?? inner.delta;
    let pixels: number | undefined;
    if (typeof pxRaw === "number" && Number.isFinite(pxRaw)) {
      pixels = Math.max(1, Math.min(5000, Math.floor(Math.abs(pxRaw))));
    }
    return withThought(
      pixels !== undefined
        ? { type: "scroll", direction, pixels }
        : { type: "scroll", direction },
    );
  }
  if (t === "wait") {
    const msRaw =
      typeof inner.ms === "number"
        ? inner.ms
        : typeof inner.seconds === "number"
          ? inner.seconds * 1000
          : 500;
    const ms = Math.max(0, Math.min(10_000, Math.floor(msRaw)));
    return withThought({ type: "wait", ms });
  }
  if (t === "navigate") {
    const url = String(inner.url ?? "").trim();
    if (!url) throw new ActionParseError("navigate action missing url", raw);
    return withThought({ type: "navigate", url });
  }
  if (t === "done") {
    const reason = String(inner.reason ?? inner.message ?? "agent declares goal met").trim();
    return withThought({ type: "done", reason });
  }
  // decline
  const reason = String(inner.reason ?? inner.message ?? "agent cannot proceed").trim();
  return withThought({ type: "decline", reason });
}

function parseMark(inner: Record<string, unknown>, raw: string): number {
  const v = inner.mark ?? inner.id ?? inner.mark_id ?? inner.markId ?? inner.target;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ActionParseError(`action missing integer "mark" id`, raw);
  }
  const n = Math.floor(v);
  if (n < 1) throw new ActionParseError(`mark id must be >= 1`, raw);
  return n;
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (m) return (m[1] ?? "").trim();
  return text;
}

function extractFirstObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
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
        try {
          const parsed = JSON.parse(slice) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
          return null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export function actionLabel(a: AgentAction): string {
  switch (a.type) {
    case "click":
      return `click(mark=${a.mark})`;
    case "type":
      return `type(mark=${a.mark},${JSON.stringify(truncate(a.text, 40))}${a.submit ? ",submit" : ""})`;
    case "scroll":
      return `scroll(${a.direction}${a.pixels !== undefined ? `,${a.pixels}px` : ""})`;
    case "wait":
      return `wait(${a.ms}ms)`;
    case "navigate":
      return `navigate(${truncate(a.url, 80)})`;
    case "done":
      return `done(${truncate(a.reason, 60)})`;
    case "decline":
      return `decline(${truncate(a.reason, 60)})`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Resolve a mark id to its element, scroll it into view, and return the
 * recomputed viewport-relative bounding-box centre. Returns `null` if the
 * mark id is unknown to the page (e.g. the LLM picked a stale id from the
 * prior step's observation).
 */
async function locateMark(
  browser: BrowserSession,
  mark: number,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const expr = `(() => {
    const el = document.querySelector('[data-gba-som-id="${mark}"]');
    if (!el) return null;
    el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
    const r = el.getBoundingClientRect();
    return {x: r.left, y: r.top, w: r.width, h: r.height};
  })()`;
  const r = await browser.evaluate<
    { x: number; y: number; w: number; h: number } | null
  >(expr);
  return r;
}

export async function executeAction(
  action: AgentAction,
  browser: BrowserSession,
  marks: Mark[],
): Promise<ActionResult> {
  switch (action.type) {
    case "click": {
      const known = marks.find((m) => m.id === action.mark);
      if (!known) {
        return { ok: false, message: `unknown mark id ${action.mark}` };
      }
      const bb = await locateMark(browser, action.mark);
      if (!bb) {
        return { ok: false, message: `mark ${action.mark} no longer in DOM` };
      }
      const cx = Math.round(bb.x + bb.w / 2);
      const cy = Math.round(bb.y + bb.h / 2);
      await browser.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      });
      await browser.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      });
      return { ok: true, message: `clicked mark ${action.mark} at (${cx},${cy})` };
    }
    case "type": {
      const known = marks.find((m) => m.id === action.mark);
      if (!known) {
        return { ok: false, message: `unknown mark id ${action.mark}` };
      }
      const bb = await locateMark(browser, action.mark);
      if (!bb) {
        return { ok: false, message: `mark ${action.mark} no longer in DOM` };
      }
      const cx = Math.round(bb.x + bb.w / 2);
      const cy = Math.round(bb.y + bb.h / 2);
      // Click into the field so it has focus, then insertText, then optionally Enter.
      await browser.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      });
      await browser.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      });
      // Best-effort clear: select-all + delete leaves the focus put.
      await browser.evaluate(`(() => {
        const el = document.activeElement;
        if (!el) return;
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) {
          const r = document.createRange();
          r.selectNodeContents(el);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      })()`).catch(() => undefined);
      await browser.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
      await browser.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
      await browser.cdp.send("Input.insertText", { text: action.text });
      if (action.submit) {
        await browser.cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: "\r",
        });
        await browser.cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      }
      return {
        ok: true,
        message: `typed ${JSON.stringify(truncate(action.text, 40))} into mark ${action.mark}${action.submit ? " + submitted" : ""}`,
      };
    }
    case "scroll": {
      const px = action.pixels ?? 400;
      const dx = action.direction === "left" ? -px : action.direction === "right" ? px : 0;
      const dy = action.direction === "up" ? -px : action.direction === "down" ? px : 0;
      await browser.evaluate(`window.scrollBy(${dx}, ${dy})`);
      return { ok: true, message: `scrolled ${action.direction} ${px}px` };
    }
    case "wait": {
      await new Promise<void>((r) => setTimeout(r, action.ms));
      return { ok: true, message: `waited ${action.ms}ms` };
    }
    case "navigate": {
      await browser.navigate(action.url);
      return { ok: true, message: `navigated to ${action.url}` };
    }
    case "done":
      return { ok: true, message: `done: ${action.reason}` };
    case "decline":
      return { ok: true, message: `decline: ${action.reason}` };
  }
}
