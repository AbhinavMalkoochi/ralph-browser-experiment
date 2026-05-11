// Action union + parser + in-page dispatcher for the dom-mutation-stream
// agent.
//
// The action substrate is aid-keyed DOM operations (reusing baseline's
// stable integer-id approach, but tagged with a distinct attribute name
// — data-gba-stream-aid — so multiple agents in the same harness run
// don't collide). What is novel here is `await_change`: a first-class
// primitive that blocks until the mutation log grows (or the timeout
// fires). The harness uses settleAfter() automatically between every
// state-changing action, but the LLM can also issue an explicit
// await_change when it expects a longer reaction (e.g. a fetch the
// page just kicked off).
//
// Action types:
//   - click(aid)
//   - type(aid, text, submit?)
//   - scroll(direction, pixels?)
//   - wait(ms)
//   - await_change(timeout_ms)
//   - navigate(url)
//   - done(reason)
//   - decline(reason)

import type { BrowserSession } from "../../harness/ts/agent/types.js";
import type { InteractiveElement, PageSnapshot } from "./observer.js";

export class ActionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionParseError";
  }
}

export type AgentAction =
  | { type: "click"; aid: number; thought?: string }
  | { type: "type"; aid: number; text: string; submit?: boolean; thought?: string }
  | { type: "scroll"; direction: "up" | "down"; pixels?: number; thought?: string }
  | { type: "wait"; ms: number; thought?: string }
  | { type: "await_change"; timeout_ms: number; thought?: string }
  | { type: "navigate"; url: string; thought?: string }
  | { type: "done"; reason: string; thought?: string }
  | { type: "decline"; reason: string; thought?: string };

export interface ActionResult {
  ok: boolean;
  message: string;
}

const MAX_WAIT_MS = 5_000;
const MAX_AWAIT_MS = 10_000;

const KNOWN_TYPES = new Set([
  "click",
  "type",
  "scroll",
  "wait",
  "await_change",
  "navigate",
  "done",
  "decline",
]);

export function parseAction(text: string): AgentAction {
  const stripped = stripFences(text).trim();
  if (!stripped) throw new ActionParseError("empty completion");
  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch (err) {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) throw new ActionParseError(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
    try {
      obj = JSON.parse(m[0]);
    } catch (err2) {
      throw new ActionParseError(`not JSON: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }
  if (!obj || typeof obj !== "object") throw new ActionParseError("action must be a JSON object");
  const a = obj as Record<string, unknown>;
  const rawType = a.type ?? a.action;
  if (typeof rawType !== "string") throw new ActionParseError("missing string field `type`");
  const t = rawType.toLowerCase().replace(/-/g, "_");
  if (!KNOWN_TYPES.has(t)) throw new ActionParseError(`unknown action type: ${rawType}`);
  const thought = typeof a.thought === "string" ? a.thought : undefined;

  switch (t) {
    case "click": {
      const aid = parseAid(a);
      if (aid === null) throw new ActionParseError("click: missing integer `aid`");
      return thought !== undefined ? { type: "click", aid, thought } : { type: "click", aid };
    }
    case "type": {
      const aid = parseAid(a);
      if (aid === null) throw new ActionParseError("type: missing integer `aid`");
      const txt = a.text ?? a.value;
      if (typeof txt !== "string") throw new ActionParseError("type: missing string `text`");
      const submit = a.submit === true;
      const action: AgentAction = submit
        ? { type: "type", aid, text: txt, submit: true }
        : { type: "type", aid, text: txt };
      return thought !== undefined ? { ...action, thought } : action;
    }
    case "scroll": {
      const dirRaw = (typeof a.direction === "string" ? a.direction.toLowerCase() : "down").trim();
      const direction: "up" | "down" = dirRaw === "up" ? "up" : "down";
      const pixels = typeof a.pixels === "number" && Number.isFinite(a.pixels) ? Math.max(0, a.pixels) : undefined;
      const action: AgentAction = pixels !== undefined
        ? { type: "scroll", direction, pixels }
        : { type: "scroll", direction };
      return thought !== undefined ? { ...action, thought } : action;
    }
    case "wait": {
      let ms = typeof a.ms === "number" ? a.ms : Number(a.ms);
      if (!Number.isFinite(ms) || ms < 0) ms = 0;
      if (ms > MAX_WAIT_MS) ms = MAX_WAIT_MS;
      return thought !== undefined
        ? { type: "wait", ms: Math.round(ms), thought }
        : { type: "wait", ms: Math.round(ms) };
    }
    case "await_change": {
      let ms = typeof a.timeout_ms === "number"
        ? a.timeout_ms
        : typeof a.ms === "number"
          ? a.ms
          : Number(a.timeout_ms);
      if (!Number.isFinite(ms) || ms < 0) ms = 0;
      if (ms === 0) ms = 1_500;
      if (ms > MAX_AWAIT_MS) ms = MAX_AWAIT_MS;
      return thought !== undefined
        ? { type: "await_change", timeout_ms: Math.round(ms), thought }
        : { type: "await_change", timeout_ms: Math.round(ms) };
    }
    case "navigate": {
      const url = a.url;
      if (typeof url !== "string" || !url.trim()) throw new ActionParseError("navigate: missing `url`");
      return thought !== undefined ? { type: "navigate", url, thought } : { type: "navigate", url };
    }
    case "done": {
      const reason = typeof a.reason === "string" && a.reason ? a.reason : "goal reached";
      return thought !== undefined ? { type: "done", reason, thought } : { type: "done", reason };
    }
    case "decline": {
      const reason = typeof a.reason === "string" && a.reason ? a.reason : "cannot proceed";
      return thought !== undefined ? { type: "decline", reason, thought } : { type: "decline", reason };
    }
    default:
      throw new ActionParseError(`unknown action type: ${rawType}`);
  }
}

function parseAid(a: Record<string, unknown>): number | null {
  const v = a.aid ?? a.target ?? a.target_aid ?? a.id;
  if (typeof v === "number" && Number.isFinite(v) && Math.floor(v) === v && v >= 0) {
    return v;
  }
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    return Number(v.trim());
  }
  return null;
}

export function actionLabel(a: AgentAction): string {
  switch (a.type) {
    case "click":
      return `click(aid=${a.aid})`;
    case "type":
      return `type(aid=${a.aid}, ${JSON.stringify(truncate(a.text, 24))}${a.submit ? ", submit" : ""})`;
    case "scroll":
      return `scroll(${a.direction}${a.pixels !== undefined ? `, ${a.pixels}px` : ""})`;
    case "wait":
      return `wait(${a.ms}ms)`;
    case "await_change":
      return `await_change(${a.timeout_ms}ms)`;
    case "navigate":
      return `navigate(${a.url})`;
    case "done":
      return `done(${truncate(a.reason, 40)})`;
    case "decline":
      return `decline(${truncate(a.reason, 40)})`;
  }
}

/**
 * State-changing actions are followed by a settleAfter() in the main loop
 * (the agent's defining mechanism). Read-only / time-only actions skip the
 * settle to avoid burning wall-clock for no signal.
 */
export function isStateChanging(a: AgentAction): boolean {
  switch (a.type) {
    case "click":
    case "type":
    case "scroll":
    case "navigate":
      return true;
    case "wait":
    case "await_change":
    case "done":
    case "decline":
      return false;
  }
}

const CLICK_BY_AID = `(aid) => {
  const el = document.querySelector('[data-gba-stream-aid="' + aid + '"]');
  if (!el) return { ok: false, message: 'no element with aid=' + aid };
  if (el.disabled) return { ok: false, message: 'aid=' + aid + ' is disabled' };
  try { el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  try {
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true, message: 'clicked aid=' + aid };
  } catch (e) {
    return { ok: false, message: 'click threw: ' + String(e && e.message ? e.message : e) };
  }
}`;

const TYPE_BY_AID = `(aid, text, submit) => {
  const el = document.querySelector('[data-gba-stream-aid="' + aid + '"]');
  if (!el) return { ok: false, message: 'no element with aid=' + aid };
  if (el.disabled) return { ok: false, message: 'aid=' + aid + ' is disabled' };
  try { el.focus && el.focus(); } catch (e) {}
  if ('value' in el) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    return { ok: false, message: 'aid=' + aid + ' is not a text input' };
  }
  if (submit) {
    const form = el.form || (el.closest && el.closest('form'));
    if (form && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(); } catch (e) { form.submit(); }
    } else if (form && typeof form.submit === 'function') {
      try { form.submit(); } catch (e) {}
    }
  }
  return { ok: true, message: 'typed ' + JSON.stringify(text.length > 40 ? text.slice(0, 39) + '…' : text) + ' into aid=' + aid + (submit ? ' (submitted)' : '') };
}`;

export async function executeAction(
  action: AgentAction,
  browser: BrowserSession,
  snapshot: PageSnapshot | null = null,
): Promise<ActionResult> {
  switch (action.type) {
    case "click": {
      if (snapshot && !snapshot.elements.some((e) => e.aid === action.aid)) {
        return { ok: false, message: `no element with aid=${action.aid} in last snapshot` };
      }
      const r = await browser.evaluate<ActionResult>(
        `(${CLICK_BY_AID})(${JSON.stringify(String(action.aid))})`,
      );
      return r;
    }
    case "type": {
      if (snapshot && !snapshot.elements.some((e) => e.aid === action.aid)) {
        return { ok: false, message: `no element with aid=${action.aid} in last snapshot` };
      }
      const r = await browser.evaluate<ActionResult>(
        `(${TYPE_BY_AID})(${JSON.stringify(String(action.aid))}, ${JSON.stringify(action.text)}, ${action.submit ? "true" : "false"})`,
      );
      return r;
    }
    case "scroll": {
      const px = action.pixels ?? 600;
      const dy = action.direction === "up" ? -px : px;
      await browser.evaluate(`window.scrollBy(0, ${dy})`);
      return { ok: true, message: `scrolled ${action.direction} ${px}px` };
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, action.ms));
      return { ok: true, message: `waited ${action.ms}ms` };
    }
    case "await_change": {
      // Pure timing primitive — the caller observes the resulting mutation
      // delta via readMutations(); we just block here.
      await new Promise((r) => setTimeout(r, action.timeout_ms));
      return { ok: true, message: `awaited up to ${action.timeout_ms}ms for DOM change` };
    }
    case "navigate": {
      try {
        await browser.navigate(action.url);
        return { ok: true, message: `navigated to ${action.url}` };
      } catch (err) {
        return {
          ok: false,
          message: `navigate threw: ${truncate(err instanceof Error ? err.message : String(err), 160)}`,
        };
      }
    }
    case "done":
      return { ok: true, message: `done: ${action.reason}` };
    case "decline":
      return { ok: false, message: `decline: ${action.reason}` };
  }
}

export function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    const nl = t.indexOf("\n");
    if (nl > 0) t = t.slice(nl + 1);
    if (t.endsWith("```")) t = t.slice(0, -3);
  }
  return t.trim();
}

function truncate(s: string, n: number): string {
  if (typeof s !== "string") s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Silence unused-warning for the InteractiveElement import (kept for clients).
void (null as unknown as InteractiveElement);
