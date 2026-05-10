// Agent action set + LLM response parser.
//
// The ReAct loop expects each LLM turn to emit a single JSON object
// describing the next action. Strict JSON is required, but we tolerate
// a few common LLM quirks: optional ```json fences, leading prose
// before/after the object, and either `target` (numeric aid) or
// `target_aid` (alternate name) for the element id. Keep the parser
// permissive but the action set strict — unknown action types are
// rejected so the agent does not get stuck on hallucinated tools.

import type { BrowserSession } from "../../harness/ts/agent/types.js";
import type { InteractiveElement, PageSnapshot } from "./snapshot.js";

export type AgentAction =
  | { type: "click"; target: number; thought?: string }
  | { type: "type"; target: number; text: string; submit?: boolean; thought?: string }
  | { type: "scroll"; direction: "up" | "down"; pixels?: number; thought?: string }
  | { type: "wait"; ms: number; thought?: string }
  | { type: "navigate"; url: string; thought?: string }
  | { type: "extract"; query: string; thought?: string }
  | { type: "finish"; reason: string; thought?: string };

export class ActionParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "ActionParseError";
  }
}

const KNOWN_TYPES = new Set([
  "click",
  "type",
  "scroll",
  "wait",
  "navigate",
  "extract",
  "finish",
]);

/**
 * Parse a single action from an LLM completion. Tolerates ```json fences,
 * leading/trailing prose, and either `target` or `target_aid`. Throws
 * ActionParseError on unparseable or invalid output.
 */
export function parseAction(raw: string): AgentAction {
  const trimmed = raw.trim();
  const jsonText = stripFences(trimmed);
  const obj = extractFirstObject(jsonText);
  if (!obj) {
    throw new ActionParseError("no JSON object in completion", raw);
  }
  const type = String(obj.type ?? obj.action ?? "").toLowerCase();
  if (!KNOWN_TYPES.has(type)) {
    throw new ActionParseError(`unknown action type ${JSON.stringify(type)}`, raw);
  }
  const thought = typeof obj.thought === "string" ? obj.thought : undefined;
  const targetField = (obj.target ?? obj.target_aid ?? obj.aid) as unknown;
  const target = typeof targetField === "number"
    ? targetField
    : typeof targetField === "string" && /^\d+$/.test(targetField)
      ? Number(targetField)
      : undefined;

  if (type === "click") {
    if (target === undefined) throw new ActionParseError("click action missing target", raw);
    return thought !== undefined
      ? { type: "click", target, thought }
      : { type: "click", target };
  }
  if (type === "type") {
    if (target === undefined) throw new ActionParseError("type action missing target", raw);
    const text = String(obj.text ?? obj.value ?? "");
    const submit = obj.submit === true;
    const action: AgentAction = submit
      ? { type: "type", target, text, submit: true }
      : { type: "type", target, text };
    return thought !== undefined ? { ...action, thought } : action;
  }
  if (type === "scroll") {
    const direction = obj.direction === "up" ? "up" : "down";
    const pixels = typeof obj.pixels === "number" ? obj.pixels : undefined;
    const action: AgentAction = pixels !== undefined
      ? { type: "scroll", direction, pixels }
      : { type: "scroll", direction };
    return thought !== undefined ? { ...action, thought } : action;
  }
  if (type === "wait") {
    const msRaw = typeof obj.ms === "number"
      ? obj.ms
      : typeof obj.seconds === "number"
        ? obj.seconds * 1000
        : 500;
    const ms = Math.max(0, Math.min(10_000, msRaw));
    return thought !== undefined ? { type: "wait", ms, thought } : { type: "wait", ms };
  }
  if (type === "navigate") {
    const url = String(obj.url ?? "").trim();
    if (!url) throw new ActionParseError("navigate action missing url", raw);
    return thought !== undefined ? { type: "navigate", url, thought } : { type: "navigate", url };
  }
  if (type === "extract") {
    const query = String(obj.query ?? obj.text ?? "");
    return thought !== undefined ? { type: "extract", query, thought } : { type: "extract", query };
  }
  // finish
  const reason = String(obj.reason ?? obj.text ?? obj.message ?? "agent finished");
  return thought !== undefined ? { type: "finish", reason, thought } : { type: "finish", reason };
}

function stripFences(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch) return (fenceMatch[1] ?? "").trim();
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
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Result of executing an action — surfaced to the LLM as the next observation. */
export interface ActionResult {
  ok: boolean;
  message: string;
  /** Optional extracted text the LLM asked for. */
  extracted?: string;
}

const CLICK_BY_AID = `(aid) => {
  const el = document.querySelector('[data-gba-aid="' + aid + '"]');
  if (!el) return { ok: false, message: 'no element with aid=' + aid };
  if (el.disabled) return { ok: false, message: 'aid=' + aid + ' is disabled' };
  el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { ok: true, message: 'clicked aid=' + aid };
}`;

const TYPE_BY_AID = `(aid, text, submit) => {
  const el = document.querySelector('[data-gba-aid="' + aid + '"]');
  if (!el) return { ok: false, message: 'no element with aid=' + aid };
  if (el.disabled) return { ok: false, message: 'aid=' + aid + ' is disabled' };
  el.focus && el.focus();
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
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    else if (form) form.submit();
  }
  return { ok: true, message: 'typed ' + JSON.stringify(text) + ' into aid=' + aid + (submit ? ' and submitted' : '') };
}`;

/**
 * Execute an action against the browser session. Always returns an
 * ActionResult — even soft failures (missing element, disabled button)
 * surface as `ok=false` so the LLM sees them as observations rather
 * than the run aborting.
 */
export async function executeAction(
  action: AgentAction,
  browser: BrowserSession,
  snapshot: PageSnapshot,
): Promise<ActionResult> {
  switch (action.type) {
    case "click": {
      const target = findElement(snapshot, action.target);
      if (!target) {
        return { ok: false, message: `no element with aid=${action.target} in last snapshot` };
      }
      const result = await browser.evaluate<ActionResult>(
        `(${CLICK_BY_AID})(${JSON.stringify(String(action.target))})`,
      );
      return result;
    }
    case "type": {
      const target = findElement(snapshot, action.target);
      if (!target) {
        return { ok: false, message: `no element with aid=${action.target} in last snapshot` };
      }
      const result = await browser.evaluate<ActionResult>(
        `(${TYPE_BY_AID})(${JSON.stringify(String(action.target))}, ${JSON.stringify(action.text)}, ${action.submit ? "true" : "false"})`,
      );
      return result;
    }
    case "scroll": {
      const px = action.pixels ?? 600;
      const dy = action.direction === "up" ? -px : px;
      await browser.evaluate(`window.scrollBy(0, ${dy})`);
      return { ok: true, message: `scrolled ${action.direction} ${px}px` };
    }
    case "wait": {
      await new Promise<void>((resolve) => setTimeout(resolve, action.ms));
      return { ok: true, message: `waited ${action.ms}ms` };
    }
    case "navigate": {
      await browser.navigate(action.url);
      return { ok: true, message: `navigated to ${action.url}` };
    }
    case "extract": {
      // Run the extract query against the current page text. If the query is
      // empty, return the first 800 chars of body text.
      const text = await browser.evaluate<string>(
        `(() => (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : "")()`,
      );
      const query = action.query.trim();
      let extracted = text;
      if (query) {
        // Best-effort: scan for the first line containing each whitespace-
        // separated keyword.
        const keywords = query.split(/\s+/).filter(Boolean);
        const lines = text.split(/\n+/);
        const matches = lines.filter((line) =>
          keywords.every((k) => line.toLowerCase().includes(k.toLowerCase())),
        );
        if (matches.length > 0) extracted = matches.slice(0, 5).join("\n");
      }
      return {
        ok: true,
        message: `extracted ${extracted.length} chars`,
        extracted: extracted.slice(0, 1200),
      };
    }
    case "finish": {
      return { ok: true, message: `finished: ${action.reason}` };
    }
  }
}

function findElement(s: PageSnapshot, aid: number): InteractiveElement | undefined {
  return s.elements.find((e) => e.aid === aid);
}
