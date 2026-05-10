// Action substrate for the vision-grounded agent.
//
// Distinguishing detail: actions do NOT touch the DOM. Every action is
// dispatched as an OS-level Chrome DevTools Protocol Input.* event:
//
//   click(x,y)         → Input.dispatchMouseEvent {pressed,released}
//   double_click(x,y)  → two presses with clickCount:1 then 2
//   move(x,y)          → Input.dispatchMouseEvent {moved}  (used for hover/drag)
//   drag(x1,y1,x2,y2)  → press at (x1,y1), move to (x2,y2), release at (x2,y2)
//   type(text)         → Input.insertText (text goes to focused element)
//   press(key)         → Input.dispatchKeyEvent for special keys
//   scroll(x,y,dy)     → Input.dispatchMouseEvent {wheel} with deltaY
//   wait(ms)           → setTimeout
//   navigate(url)      → browser.navigate
//   finish(reason)     → terminate loop with terminal_state=DONE
//
// The page receives these as if a human had moved a mouse and pressed keys.
// No CSS selector resolution, no querySelector, no DOM walk. This makes the
// substrate uniform across shadow DOM, canvas, iframe and ordinary HTML —
// the trade-off is that the LLM must localise targets in PIXELS, with no
// DOM crutch.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export type AgentAction =
  | { type: "click"; x: number; y: number; thought?: string }
  | { type: "double_click"; x: number; y: number; thought?: string }
  | { type: "move"; x: number; y: number; thought?: string }
  | {
      type: "drag";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      thought?: string;
    }
  | { type: "type"; text: string; thought?: string }
  | { type: "press"; key: string; thought?: string }
  | {
      type: "scroll";
      x: number;
      y: number;
      delta_y: number;
      delta_x?: number;
      thought?: string;
    }
  | { type: "wait"; ms: number; thought?: string }
  | { type: "navigate"; url: string; thought?: string }
  | { type: "finish"; reason: string; thought?: string };

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
  "double_click",
  "move",
  "drag",
  "type",
  "press",
  "scroll",
  "wait",
  "navigate",
  "finish",
]);

const ACTION_ALIASES: Record<string, string> = {
  doubleclick: "double_click",
  dblclick: "double_click",
  hover: "move",
  mouse_move: "move",
  mousemove: "move",
  keypress: "press",
  key: "press",
  text: "type",
  insert_text: "type",
  done: "finish",
  goto: "navigate",
};

/** Parse one action from an LLM completion. Tolerates ```json fences and prose. */
export function parseAction(raw: string): AgentAction {
  if (raw == null) throw new ActionParseError("empty completion", "");
  const text = stripFences(String(raw).trim());
  if (!text) throw new ActionParseError("empty completion", raw);
  const obj = extractFirstObject(text);
  if (!obj) throw new ActionParseError("no JSON object in completion", raw);
  const inner =
    typeof obj.action === "object" && obj.action !== null && typeof obj.type === "undefined"
      ? (obj.action as Record<string, unknown>)
      : obj;
  const wrapperThought =
    obj !== inner && typeof obj.thought === "string" ? obj.thought : undefined;
  const rawType = String(inner.type ?? inner.action ?? "")
    .toLowerCase()
    .replace(/[\s-]/g, "_");
  const t = ACTION_ALIASES[rawType] ?? rawType;
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

  if (t === "click" || t === "double_click" || t === "move") {
    const { x, y } = parseXY(inner, raw);
    return withThought({ type: t, x, y } as AgentAction);
  }
  if (t === "drag") {
    const x1 = parseCoord(inner.x1 ?? inner.from_x ?? inner.fromX, "x1", raw);
    const y1 = parseCoord(inner.y1 ?? inner.from_y ?? inner.fromY, "y1", raw);
    const x2 = parseCoord(inner.x2 ?? inner.to_x ?? inner.toX, "x2", raw);
    const y2 = parseCoord(inner.y2 ?? inner.to_y ?? inner.toY, "y2", raw);
    return withThought({ type: "drag", x1, y1, x2, y2 });
  }
  if (t === "type") {
    const text = inner.text ?? inner.value ?? inner.string;
    if (typeof text !== "string") {
      throw new ActionParseError("type action missing text", raw);
    }
    if (!text) throw new ActionParseError("type action: text is empty", raw);
    return withThought({ type: "type", text });
  }
  if (t === "press") {
    const key = String(inner.key ?? inner.name ?? "").trim();
    if (!key) throw new ActionParseError("press action missing key", raw);
    return withThought({ type: "press", key });
  }
  if (t === "scroll") {
    const { x, y } = parseXY(inner, raw, /*defaultCenter*/ true);
    const dyRaw = inner.delta_y ?? inner.deltaY ?? inner.dy ?? inner.amount;
    const dxRaw = inner.delta_x ?? inner.deltaX ?? inner.dx;
    const direction = String(inner.direction ?? "").toLowerCase();
    let delta_y: number;
    if (typeof dyRaw === "number" && Number.isFinite(dyRaw)) {
      delta_y = clampDelta(dyRaw);
    } else if (direction === "up") {
      delta_y = -400;
    } else if (direction === "down" || direction === "") {
      delta_y = 400;
    } else if (direction === "left" || direction === "right") {
      delta_y = 0;
    } else {
      delta_y = 400;
    }
    let delta_x: number | undefined;
    if (typeof dxRaw === "number" && Number.isFinite(dxRaw)) {
      delta_x = clampDelta(dxRaw);
    } else if (direction === "left") {
      delta_x = -400;
    } else if (direction === "right") {
      delta_x = 400;
    }
    return withThought(
      delta_x !== undefined
        ? { type: "scroll", x, y, delta_y, delta_x }
        : { type: "scroll", x, y, delta_y },
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
  // finish
  const reason = String(inner.reason ?? inner.message ?? "agent declares goal met").trim();
  return withThought({ type: "finish", reason });
}

function parseXY(
  inner: Record<string, unknown>,
  raw: string,
  defaultCenter = false,
): { x: number; y: number } {
  // Some LLMs nest coordinates under a `position` / `target` object. Handle both.
  let xRaw: unknown = inner.x;
  let yRaw: unknown = inner.y;
  if ((xRaw === undefined || yRaw === undefined) && typeof inner.position === "object" && inner.position) {
    const p = inner.position as Record<string, unknown>;
    xRaw = xRaw ?? p.x;
    yRaw = yRaw ?? p.y;
  }
  if ((xRaw === undefined || yRaw === undefined) && Array.isArray(inner.coords)) {
    const c = inner.coords as unknown[];
    xRaw = xRaw ?? c[0];
    yRaw = yRaw ?? c[1];
  }
  if (xRaw === undefined && yRaw === undefined && defaultCenter) {
    return { x: 400, y: 300 };
  }
  return { x: parseCoord(xRaw, "x", raw), y: parseCoord(yRaw, "y", raw) };
}

function parseCoord(v: unknown, name: string, raw: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ActionParseError(`${name} must be a number`, raw);
  }
  return Math.max(0, Math.floor(v));
}

function clampDelta(v: number): number {
  // Wheel deltas larger than ~5000 just churn; clamp.
  return Math.max(-5000, Math.min(5000, Math.floor(v)));
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

/** Soft execution outcome surfaced back to the LLM for the next turn. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Stable label used in step records and history. */
export function actionLabel(a: AgentAction): string {
  switch (a.type) {
    case "click":
      return `click(${a.x},${a.y})`;
    case "double_click":
      return `double_click(${a.x},${a.y})`;
    case "move":
      return `move(${a.x},${a.y})`;
    case "drag":
      return `drag(${a.x1},${a.y1}→${a.x2},${a.y2})`;
    case "type":
      return `type(${JSON.stringify(truncate(a.text, 40))})`;
    case "press":
      return `press(${a.key})`;
    case "scroll": {
      const dx = a.delta_x ? `,dx=${a.delta_x}` : "";
      return `scroll(${a.x},${a.y},dy=${a.delta_y}${dx})`;
    }
    case "wait":
      return `wait(${a.ms}ms)`;
    case "navigate":
      return `navigate(${truncate(a.url, 80)})`;
    case "finish":
      return `finish(${truncate(a.reason, 60)})`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Dispatch an action against the live page using ONLY CDP Input.* commands.
 * Never mutates the DOM via Runtime.evaluate. Returns a soft ActionResult so
 * the LLM can see "out of viewport" / "no element under cursor" as the next
 * observation rather than a thrown exception.
 */
export async function executeAction(
  action: AgentAction,
  browser: BrowserSession,
  viewport: { width: number; height: number },
): Promise<ActionResult> {
  const cdp = browser.cdp;
  switch (action.type) {
    case "click": {
      const { x, y } = clampPoint(action.x, action.y, viewport);
      await mouseClick(cdp, x, y, 1);
      return { ok: true, message: `clicked at (${x},${y})` };
    }
    case "double_click": {
      const { x, y } = clampPoint(action.x, action.y, viewport);
      await mouseClick(cdp, x, y, 1);
      await mouseClick(cdp, x, y, 2);
      return { ok: true, message: `double-clicked at (${x},${y})` };
    }
    case "move": {
      const { x, y } = clampPoint(action.x, action.y, viewport);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
      });
      return { ok: true, message: `moved to (${x},${y})` };
    }
    case "drag": {
      const a = clampPoint(action.x1, action.y1, viewport);
      const b = clampPoint(action.x2, action.y2, viewport);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: a.x,
        y: a.y,
        button: "none",
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: a.x,
        y: a.y,
        button: "left",
        clickCount: 1,
      });
      // Intermediate moves so HTML5 drag/drop libraries see motion events.
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const ix = a.x + Math.round(((b.x - a.x) * i) / steps);
        const iy = a.y + Math.round(((b.y - a.y) * i) / steps);
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: ix,
          y: iy,
          button: "left",
        });
      }
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: b.x,
        y: b.y,
        button: "left",
        clickCount: 1,
      });
      return { ok: true, message: `dragged (${a.x},${a.y})→(${b.x},${b.y})` };
    }
    case "type": {
      // Input.insertText is the keystrokes-equivalent that reaches whatever
      // element currently has focus. The LLM must have clicked into a field
      // first; if nothing has focus the keystrokes go nowhere — surface that
      // as ok:true with a hint so the LLM gets one cheap observation.
      await cdp.send("Input.insertText", { text: action.text });
      return { ok: true, message: `typed ${JSON.stringify(truncate(action.text, 60))}` };
    }
    case "press": {
      await dispatchKey(cdp, action.key);
      return { ok: true, message: `pressed ${action.key}` };
    }
    case "scroll": {
      const { x, y } = clampPoint(action.x, action.y, viewport);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: action.delta_x ?? 0,
        deltaY: action.delta_y,
      });
      return { ok: true, message: `scrolled at (${x},${y}) dy=${action.delta_y}` };
    }
    case "wait": {
      await new Promise<void>((r) => setTimeout(r, action.ms));
      return { ok: true, message: `waited ${action.ms}ms` };
    }
    case "navigate": {
      await browser.navigate(action.url);
      return { ok: true, message: `navigated to ${action.url}` };
    }
    case "finish":
      return { ok: true, message: `finish: ${action.reason}` };
  }
}

function clampPoint(
  x: number,
  y: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const cx = Math.max(0, Math.min(viewport.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(viewport.height - 1, Math.round(y)));
  return { x: cx, y: cy };
}

async function mouseClick(
  cdp: BrowserSession["cdp"],
  x: number,
  y: number,
  clickCount: number,
): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount,
  });
}

// Minimal CDP key-name → {key, code, vk, text} mapping. The LLM usually
// emits W3C UI-event names ("Enter", "Tab", "ArrowDown"); raw single
// characters are dispatched via insertText for a stable round-trip.
//
// `text` is what Chrome uses to decide whether to fire `keypress`. For
// Enter that means `text:"\r"` is required to trigger implicit form
// submission — the puppeteer/playwright code paths follow the same rule.
// Pure control keys (Tab, Escape, Backspace, Arrows…) leave text empty.
interface KeyDescriptor {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

const KEY_TABLE: Record<string, KeyDescriptor> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
};

async function dispatchKey(cdp: BrowserSession["cdp"], key: string): Promise<void> {
  const lookup = KEY_TABLE[key.toLowerCase().replace(/\s+/g, "")];
  if (lookup) {
    const downParams: Record<string, unknown> = {
      type: lookup.text ? "keyDown" : "rawKeyDown",
      key: lookup.key,
      code: lookup.code,
      windowsVirtualKeyCode: lookup.vk,
    };
    if (lookup.text) downParams.text = lookup.text;
    await cdp.send("Input.dispatchKeyEvent", downParams);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: lookup.key,
      code: lookup.code,
      windowsVirtualKeyCode: lookup.vk,
    });
    return;
  }
  // Unknown / printable: fall back to insertText so single-character "press"
  // calls still produce visible output rather than no-op.
  if (key.length === 1) {
    await cdp.send("Input.insertText", { text: key });
    return;
  }
  // Best effort: send the raw name; chrome will mostly drop it.
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key });
}
