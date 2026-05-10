// Action substrate for the speculative-rollback agent.
//
// The action set itself is small and CSS-selector-keyed (intentionally
// different from baseline's integer aids and plan-then-execute's visible-text
// resolver). The proposer LLM emits a JSON envelope holding a list of K
// candidate actions; the executor runs one at a time and the agent's judge
// loop decides whether to commit it or revert.
//
// We tolerate the usual LLM quirks (```json fences, leading prose, optional
// trailing prose, single object vs envelope). Unknown action types are
// rejected so the agent does not silently no-op on hallucinated verbs.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export type CandidateAction =
  | { type: "click"; selector: string; rationale?: string }
  | { type: "type"; selector: string; text: string; submit?: boolean; rationale?: string }
  | { type: "scroll"; direction: "up" | "down"; pixels?: number; rationale?: string }
  | { type: "wait"; ms: number; rationale?: string }
  | { type: "navigate"; url: string; rationale?: string }
  | { type: "finish"; reason: string; rationale?: string };

export class ActionParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "ActionParseError";
    this.raw = raw;
  }
}

const KNOWN_TYPES = new Set(["click", "type", "scroll", "wait", "navigate", "finish"]);

/**
 * Parse the LLM's proposer completion into an ordered list of candidate
 * actions. Accepts:
 *   - {"candidates":[{...}, ...]}    (the preferred envelope)
 *   - [{...}, {...}]                 (bare array, no envelope)
 *   - {...}                          (a single candidate)
 * Anything wrapped in ```json``` fences is unwrapped. Leading/trailing prose
 * is stripped.
 *
 * Throws ActionParseError on anything else, on an empty list, or on an
 * unknown action type.
 */
export function parseCandidates(raw: string): CandidateAction[] {
  if (raw == null) throw new ActionParseError("empty completion", "");
  const text = stripFences(String(raw).trim());
  if (!text) throw new ActionParseError("empty completion", raw);
  const parsed = extractFirstJson(text);
  if (parsed === null) {
    throw new ActionParseError("no JSON value in completion", raw);
  }
  let arr: unknown[];
  if (Array.isArray(parsed)) {
    arr = parsed as unknown[];
  } else if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { candidates?: unknown }).candidates)) {
    arr = (parsed as { candidates: unknown[] }).candidates;
  } else if (typeof parsed === "object" && parsed !== null) {
    arr = [parsed as unknown];
  } else {
    throw new ActionParseError(`expected object or array, got ${typeof parsed}`, raw);
  }
  if (arr.length === 0) {
    throw new ActionParseError("candidate list is empty", raw);
  }
  return arr.map((c, i) => normaliseCandidate(c, raw, i));
}

function normaliseCandidate(obj: unknown, raw: string, index: number): CandidateAction {
  if (typeof obj !== "object" || obj === null) {
    throw new ActionParseError(`candidate #${index} is not an object`, raw);
  }
  const o = obj as Record<string, unknown>;
  // Allow {action:{...},rationale:"..."} wrappers too.
  if (typeof o.action === "object" && o.action !== null && typeof o.type === "undefined") {
    const inner = o.action as Record<string, unknown>;
    const rationale = typeof o.rationale === "string" ? o.rationale : undefined;
    return normaliseCandidate({ ...inner, rationale }, raw, index);
  }
  const t = String(o.type ?? o.action ?? "").toLowerCase();
  if (!KNOWN_TYPES.has(t)) {
    throw new ActionParseError(
      `candidate #${index} has unknown type ${JSON.stringify(t)}`,
      raw,
    );
  }
  const rationale = typeof o.rationale === "string" ? o.rationale : typeof o.thought === "string" ? o.thought : undefined;
  if (t === "click") {
    const selector = String(o.selector ?? o.target ?? "").trim();
    if (!selector) throw new ActionParseError(`click candidate #${index} missing selector`, raw);
    return rationale !== undefined
      ? { type: "click", selector, rationale }
      : { type: "click", selector };
  }
  if (t === "type") {
    const selector = String(o.selector ?? o.target ?? "").trim();
    if (!selector) throw new ActionParseError(`type candidate #${index} missing selector`, raw);
    const text = String(o.text ?? o.value ?? "");
    const submit = o.submit === true;
    const out: CandidateAction = submit
      ? { type: "type", selector, text, submit: true }
      : { type: "type", selector, text };
    return rationale !== undefined ? { ...out, rationale } : out;
  }
  if (t === "scroll") {
    const direction = o.direction === "up" ? "up" : "down";
    const pixels = typeof o.pixels === "number" && Number.isFinite(o.pixels)
      ? Math.max(0, Math.floor(o.pixels))
      : undefined;
    const out: CandidateAction = pixels !== undefined
      ? { type: "scroll", direction, pixels }
      : { type: "scroll", direction };
    return rationale !== undefined ? { ...out, rationale } : out;
  }
  if (t === "wait") {
    const msRaw = typeof o.ms === "number"
      ? o.ms
      : typeof o.seconds === "number"
        ? o.seconds * 1000
        : 500;
    const ms = Math.max(0, Math.min(10_000, Math.floor(msRaw)));
    return rationale !== undefined ? { type: "wait", ms, rationale } : { type: "wait", ms };
  }
  if (t === "navigate") {
    const url = String(o.url ?? "").trim();
    if (!url) throw new ActionParseError(`navigate candidate #${index} missing url`, raw);
    return rationale !== undefined ? { type: "navigate", url, rationale } : { type: "navigate", url };
  }
  // finish
  const reason = String(o.reason ?? o.message ?? o.text ?? "agent finished");
  return rationale !== undefined ? { type: "finish", reason, rationale } : { type: "finish", reason };
}

function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (m) return (m[1] ?? "").trim();
  return text;
}

/** Walk the string and locate the first balanced { ... } or [ ... ] JSON value. */
function extractFirstJson(text: string): unknown {
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  let start = -1;
  if (objStart === -1 && arrStart === -1) return null;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);
  const open = text[start];
  const close = open === "{" ? "}" : "]";
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
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Result of executing one candidate. Always returned — never thrown. */
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
  action: CandidateAction,
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
    case "finish": {
      return { ok: true, message: `finished: ${action.reason}` };
    }
  }
}

/** Short stable label used in prompts, blacklist entries, and step records. */
export function actionLabel(a: CandidateAction): string {
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
    case "finish":
      return `finish(${truncate(a.reason, 40)})`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
