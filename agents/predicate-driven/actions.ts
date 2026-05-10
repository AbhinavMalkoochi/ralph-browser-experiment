// Action substrate for the predicate-driven agent.
//
// IMPORTANT distinguishing detail: there is NO `finish` action in this set.
// Termination is owned by the predicate evaluator (predicate.ts), not the
// LLM. Every other agent in the repo (baseline, plan-then-execute,
// runtime-codegen, speculative-rollback) lets the LLM signal completion;
// here the LLM picks an action and the harness decides whether the goal is
// met by polling the LLM-synthesised predicate against the post-action page.
//
// The action LLM also does NOT see the predicate text. Its job is purely
// "given the goal and current page, what's the next move?" — leaving the
// predicate as the agent's own invariant probe.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export type AgentAction =
  | { type: "click"; selector: string; thought?: string }
  | { type: "type"; selector: string; text: string; submit?: boolean; thought?: string }
  | { type: "scroll"; direction: "up" | "down"; pixels?: number; thought?: string }
  | { type: "wait"; ms: number; thought?: string }
  | { type: "navigate"; url: string; thought?: string };

export class ActionParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "ActionParseError";
    this.raw = raw;
  }
}

const KNOWN_TYPES = new Set(["click", "type", "scroll", "wait", "navigate"]);

/**
 * Parse one action from an LLM completion. Tolerates ```json fences and
 * leading prose; rejects unknown types and missing required fields.
 *
 * NB: explicitly rejects `finish` to preserve the agent's invariant that
 * the LLM cannot terminate the loop — only the predicate can.
 */
export function parseAction(raw: string): AgentAction {
  if (raw == null) throw new ActionParseError("empty completion", "");
  const text = stripFences(String(raw).trim());
  if (!text) throw new ActionParseError("empty completion", raw);
  const obj = extractFirstObject(text);
  if (!obj) throw new ActionParseError("no JSON object in completion", raw);
  // Allow {action:{...},thought:"..."} wrappers too.
  const inner =
    typeof obj.action === "object" && obj.action !== null && typeof obj.type === "undefined"
      ? (obj.action as Record<string, unknown>)
      : obj;
  const wrapperThought =
    obj !== inner && typeof obj.thought === "string" ? obj.thought : undefined;
  const t = String(inner.type ?? inner.action ?? "").toLowerCase();
  if (t === "finish") {
    throw new ActionParseError(
      "the predicate-driven agent does not accept a `finish` action; termination is owned by the goal predicate",
      raw,
    );
  }
  if (!KNOWN_TYPES.has(t)) {
    throw new ActionParseError(`unknown action type ${JSON.stringify(t)}`, raw);
  }
  const thought =
    typeof inner.thought === "string"
      ? inner.thought
      : typeof inner.rationale === "string"
        ? inner.rationale
        : wrapperThought;
  if (t === "click") {
    const selector = String(inner.selector ?? inner.target ?? "").trim();
    if (!selector) throw new ActionParseError("click action missing selector", raw);
    return thought !== undefined
      ? { type: "click", selector, thought }
      : { type: "click", selector };
  }
  if (t === "type") {
    const selector = String(inner.selector ?? inner.target ?? "").trim();
    if (!selector) throw new ActionParseError("type action missing selector", raw);
    const value = String(inner.text ?? inner.value ?? "");
    const submit = inner.submit === true;
    const out: AgentAction = submit
      ? { type: "type", selector, text: value, submit: true }
      : { type: "type", selector, text: value };
    return thought !== undefined ? { ...out, thought } : out;
  }
  if (t === "scroll") {
    const direction = inner.direction === "up" ? "up" : "down";
    const pixels =
      typeof inner.pixels === "number" && Number.isFinite(inner.pixels)
        ? Math.max(0, Math.floor(inner.pixels))
        : undefined;
    const out: AgentAction = pixels !== undefined
      ? { type: "scroll", direction, pixels }
      : { type: "scroll", direction };
    return thought !== undefined ? { ...out, thought } : out;
  }
  if (t === "wait") {
    const msRaw =
      typeof inner.ms === "number"
        ? inner.ms
        : typeof inner.seconds === "number"
          ? inner.seconds * 1000
          : 500;
    const ms = Math.max(0, Math.min(10_000, Math.floor(msRaw)));
    return thought !== undefined ? { type: "wait", ms, thought } : { type: "wait", ms };
  }
  // navigate
  const url = String(inner.url ?? "").trim();
  if (!url) throw new ActionParseError("navigate action missing url", raw);
  return thought !== undefined ? { type: "navigate", url, thought } : { type: "navigate", url };
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
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
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

/** Execution result. Always returned, never thrown — soft failures surface to the LLM. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

const CLICK_SCRIPT = `(sel) => {
  let el;
  try { el = document.querySelector(sel); } catch (e) { return { ok: false, message: 'invalid selector: ' + (e && e.message) }; }
  if (!el) return { ok: false, message: 'no element matches ' + sel };
  if (el.disabled) return { ok: false, message: 'element is disabled' };
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { ok: true, message: 'clicked ' + sel };
}`;

const TYPE_SCRIPT = `(sel, text, submit) => {
  let el;
  try { el = document.querySelector(sel); } catch (e) { return { ok: false, message: 'invalid selector: ' + (e && e.message) }; }
  if (!el) return { ok: false, message: 'no element matches ' + sel };
  if (el.disabled) return { ok: false, message: 'element is disabled' };
  if (el.focus) el.focus();
  if ('value' in el) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    return { ok: false, message: 'element is not a text input' };
  }
  if (submit) {
    const form = el.form || (el.closest && el.closest('form'));
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    else if (form) form.submit();
  }
  return { ok: true, message: 'typed into ' + sel + (submit ? ' and submitted' : '') };
}`;

export async function executeAction(
  action: AgentAction,
  browser: BrowserSession,
): Promise<ActionResult> {
  switch (action.type) {
    case "click": {
      return await browser.evaluate<ActionResult>(
        `(${CLICK_SCRIPT})(${JSON.stringify(action.selector)})`,
      );
    }
    case "type": {
      return await browser.evaluate<ActionResult>(
        `(${TYPE_SCRIPT})(${JSON.stringify(action.selector)}, ${JSON.stringify(action.text)}, ${action.submit ? "true" : "false"})`,
      );
    }
    case "scroll": {
      const px = action.pixels ?? 600;
      const dy = action.direction === "up" ? -px : px;
      await browser.evaluate(`window.scrollBy(0, ${dy})`);
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
  }
}

/** Stable label used in step records and history. */
export function actionLabel(a: AgentAction): string {
  switch (a.type) {
    case "click":
      return `click(${truncate(a.selector, 60)})`;
    case "type":
      return `type(${truncate(a.selector, 50)}, ${JSON.stringify(truncate(a.text, 30))}${a.submit ? ", submit" : ""})`;
    case "scroll":
      return `scroll(${a.direction}${a.pixels ? `, ${a.pixels}` : ""})`;
    case "wait":
      return `wait(${a.ms}ms)`;
    case "navigate":
      return `navigate(${truncate(a.url, 80)})`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
