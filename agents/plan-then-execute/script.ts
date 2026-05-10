// Plan-then-execute DSL: script primitives, parser, and per-op browser executor.
//
// Where the baseline agent emits one action per LLM turn keyed by integer
// aids on a snapshot, this agent emits the WHOLE plan in one turn keyed by
// intent text (link copy, button label, input placeholder). Selector
// resolution happens at execute time inside the page so the LLM never has
// to track an aid across turns.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export type PlanOp =
  | { op: "goto"; url: string; thought?: string }
  | { op: "click_text"; text: string; thought?: string }
  | {
      op: "type";
      label: string;
      value: string;
      submit?: boolean;
      thought?: string;
    }
  | { op: "wait_for_text"; text: string; timeout_ms?: number; thought?: string }
  | { op: "assert_text"; text: string; thought?: string }
  | { op: "scroll"; direction: "up" | "down"; pixels?: number; thought?: string }
  | { op: "extract"; query: string; thought?: string }
  | { op: "finish"; reason: string; thought?: string };

export type PlanOpType = PlanOp["op"];

const KNOWN_OPS = new Set<PlanOpType>([
  "goto",
  "click_text",
  "type",
  "wait_for_text",
  "assert_text",
  "scroll",
  "extract",
  "finish",
]);

export class PlanParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "PlanParseError";
  }
}

/**
 * Parse a plan from an LLM completion. The plan is expected to be a JSON
 * array of operations. Tolerates ```json fences, leading/trailing prose,
 * single-object replies (auto-wrapped into a one-element array), and the
 * field aliases `action`/`type` for `op`. Throws PlanParseError if the
 * plan does not contain at least one valid op.
 */
export function parsePlan(raw: string): PlanOp[] {
  const stripped = stripFences(raw.trim());
  const arr = extractArrayOrSingleObject(stripped);
  if (!arr) {
    throw new PlanParseError("no JSON array of plan ops in completion", raw);
  }
  if (arr.length === 0) {
    throw new PlanParseError("plan is empty", raw);
  }
  const ops: PlanOp[] = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new PlanParseError(`plan[${i}] is not an object`, raw);
    }
    ops.push(parseOp(item as Record<string, unknown>, i, raw));
  }
  return ops;
}

function parseOp(o: Record<string, unknown>, idx: number, raw: string): PlanOp {
  const opName = String(o.op ?? o.action ?? o.type ?? "").toLowerCase() as PlanOpType;
  if (!KNOWN_OPS.has(opName)) {
    throw new PlanParseError(
      `plan[${idx}] unknown op ${JSON.stringify(opName)}`,
      raw,
    );
  }
  const thought = typeof o.thought === "string" ? o.thought : undefined;
  const withThought = <T extends PlanOp>(op: T): T =>
    thought !== undefined ? ({ ...op, thought } as T) : op;
  if (opName === "goto") {
    const url = stringField(o, ["url", "href", "target"], "url");
    if (!url) throw new PlanParseError(`plan[${idx}] goto missing url`, raw);
    return withThought({ op: "goto", url });
  }
  if (opName === "click_text") {
    const text = stringField(o, ["text", "label", "target", "name"], "text");
    if (!text) throw new PlanParseError(`plan[${idx}] click_text missing text`, raw);
    return withThought({ op: "click_text", text });
  }
  if (opName === "type") {
    const label = stringField(o, ["label", "target", "selector", "name", "placeholder"], "label");
    const value = stringField(o, ["value", "text", "input"], "value");
    if (!label) throw new PlanParseError(`plan[${idx}] type missing label`, raw);
    if (value === null) throw new PlanParseError(`plan[${idx}] type missing value`, raw);
    const submit = o.submit === true;
    return withThought(
      submit
        ? { op: "type", label, value, submit: true }
        : { op: "type", label, value },
    );
  }
  if (opName === "wait_for_text") {
    const text = stringField(o, ["text", "label", "target"], "text");
    if (!text) throw new PlanParseError(`plan[${idx}] wait_for_text missing text`, raw);
    const timeoutRaw = o.timeout_ms ?? o.timeout ?? o.ms;
    const timeout_ms =
      typeof timeoutRaw === "number" && timeoutRaw >= 0
        ? Math.min(15_000, Math.floor(timeoutRaw))
        : undefined;
    return withThought(
      timeout_ms !== undefined
        ? { op: "wait_for_text", text, timeout_ms }
        : { op: "wait_for_text", text },
    );
  }
  if (opName === "assert_text") {
    const text = stringField(o, ["text", "expect", "target"], "text");
    if (!text) throw new PlanParseError(`plan[${idx}] assert_text missing text`, raw);
    return withThought({ op: "assert_text", text });
  }
  if (opName === "scroll") {
    const direction = o.direction === "up" ? "up" : "down";
    const pixels = typeof o.pixels === "number" ? o.pixels : undefined;
    return withThought(
      pixels !== undefined
        ? { op: "scroll", direction, pixels }
        : { op: "scroll", direction },
    );
  }
  if (opName === "extract") {
    const query = stringField(o, ["query", "text", "target"], "query") ?? "";
    return withThought({ op: "extract", query });
  }
  // finish
  const reason = stringField(o, ["reason", "text", "message"], "reason") ?? "agent finished";
  return withThought({ op: "finish", reason });
}

function stringField(
  o: Record<string, unknown>,
  keys: string[],
  _label: string,
): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function stripFences(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch) return (fenceMatch[1] ?? "").trim();
  return text;
}

/**
 * Find the first balanced JSON value in the text. Accepts an array (the
 * normal plan form) or a single object (auto-wrapped into a singleton
 * array). Returns null when no balanced value is found.
 */
function extractArrayOrSingleObject(text: string): unknown[] | null {
  const idxArr = text.indexOf("[");
  const idxObj = text.indexOf("{");
  let start = -1;
  if (idxArr === -1 && idxObj === -1) return null;
  if (idxArr === -1) start = idxObj;
  else if (idxObj === -1) start = idxArr;
  else start = Math.min(idxArr, idxObj);
  const open = text[start];
  const close = open === "[" ? "]" : "}";
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
        const slice = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice) as unknown;
          if (Array.isArray(parsed)) return parsed;
          if (typeof parsed === "object" && parsed !== null) return [parsed];
          return null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------------

export interface OpResult {
  ok: boolean;
  message: string;
  /** Optional captured text (extract op). */
  extracted?: string;
}

/**
 * Result classes for the agent to decide whether to keep going or repair.
 *  - ok: succeeded; advance to next op.
 *  - soft_fail: continue on (e.g. extract finds nothing); record but don't repair.
 *  - hard_fail: stop the script; agent decides whether to repair.
 */
export type OpOutcome = "ok" | "soft_fail" | "hard_fail";

export function classify(op: PlanOp, r: OpResult): OpOutcome {
  if (r.ok) return "ok";
  // extract is informational; missing text is not a control-flow failure.
  if (op.op === "extract") return "soft_fail";
  // scroll / wait are best-effort.
  if (op.op === "scroll" || op.op === "wait_for_text") return "soft_fail";
  return "hard_fail";
}

const CLICK_BY_TEXT = `(needle) => {
  const lc = needle.toLowerCase();
  const INTERACTIVE_TAGS = new Set(["a","button","input","select","textarea","summary"]);
  const INTERACTIVE_ROLES = new Set(["button","link","checkbox","radio","menuitem","tab","switch","combobox","textbox","searchbox","option","treeitem"]);
  function isInteractive(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute && el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
    if (el.hasAttribute && el.hasAttribute("contenteditable")) return true;
    if (typeof el.onclick === "function") return true;
    if (el.hasAttribute && el.hasAttribute("tabindex")) {
      const t = el.getAttribute("tabindex");
      if (t !== null && t !== "-1") return true;
    }
    return false;
  }
  function visible(el) {
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    const s = w ? w.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) return false;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(r) && r.width > 0 && r.height > 0;
  }
  function nameOf(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const lb = el.getAttribute && el.getAttribute("aria-labelledby");
    if (lb) {
      const ids = lb.split(/\\s+/).filter(Boolean);
      const parts = [];
      for (const id of ids) {
        const ref = el.ownerDocument && el.ownerDocument.getElementById(id);
        if (ref && ref.textContent) parts.push(ref.textContent.trim());
      }
      if (parts.length) return parts.join(" ");
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.id) {
        const lab = el.ownerDocument && el.ownerDocument.querySelector('label[for="' + el.id + '"]');
        if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim();
      }
      const ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return ph.trim();
      if (el.value && typeof el.value === "string" && el.value.trim()) return el.value.trim();
    }
    if (el.tagName === "IMG") {
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim();
    }
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text) return text;
    const title = el.getAttribute && el.getAttribute("title");
    if (title) return title.trim();
    return "";
  }
  const all = document.querySelectorAll("*");
  let exact = null;
  let prefix = null;
  let contains = null;
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!isInteractive(el)) continue;
    if (el.disabled) continue;
    if (!visible(el)) continue;
    const name = nameOf(el).toLowerCase();
    if (!name) continue;
    if (name === lc) { exact = el; break; }
    if (!prefix && name.startsWith(lc)) prefix = el;
    if (!contains && name.indexOf(lc) !== -1) contains = el;
  }
  const target = exact || prefix || contains;
  if (!target) return { ok: false, message: 'no element matching ' + JSON.stringify(needle) };
  if (target.scrollIntoView) target.scrollIntoView({ block: 'center', inline: 'center' });
  target.click();
  return { ok: true, message: 'clicked ' + JSON.stringify(needle) };
}`;

const TYPE_BY_LABEL = `(needle, value, submit) => {
  const lc = needle.toLowerCase();
  function visible(el) {
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    const s = w ? w.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) return false;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(r) && r.width > 0 && r.height > 0;
  }
  function labelText(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    if (el.id) {
      const lab = el.ownerDocument && el.ownerDocument.querySelector('label[for="' + el.id + '"]');
      if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim();
    }
    const closeLab = el.closest && el.closest("label");
    if (closeLab && closeLab.textContent && closeLab.textContent.trim()) return closeLab.textContent.trim();
    const ph = el.getAttribute && el.getAttribute("placeholder");
    if (ph && ph.trim()) return ph.trim();
    const nm = el.getAttribute && el.getAttribute("name");
    if (nm) return nm;
    return "";
  }
  const inputs = document.querySelectorAll('input, textarea, select, [contenteditable]');
  let exact = null;
  let contains = null;
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i];
    if (el.disabled) continue;
    if (!visible(el)) continue;
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "hidden" || t === "submit" || t === "button" || t === "reset") continue;
    }
    const lab = labelText(el).toLowerCase();
    if (!lab) continue;
    if (lab === lc) { exact = el; break; }
    if (!contains && lab.indexOf(lc) !== -1) contains = el;
  }
  const target = exact || contains;
  if (!target) return { ok: false, message: 'no input matching label ' + JSON.stringify(needle) };
  if (target.scrollIntoView) target.scrollIntoView({ block: 'center', inline: 'center' });
  if (target.focus) target.focus();
  if ('value' in target) {
    target.value = value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (target.isContentEditable) {
    target.textContent = value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    return { ok: false, message: 'label ' + JSON.stringify(needle) + ' did not match a text input' };
  }
  if (submit) {
    const form = target.form || (target.closest && target.closest('form'));
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    else if (form) form.submit();
  }
  return { ok: true, message: 'typed into ' + JSON.stringify(needle) + (submit ? ' and submitted' : '') };
}`;

const WAIT_FOR_TEXT = `async (needle, timeoutMs) => {
  const lc = needle.toLowerCase();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
    if (body.indexOf(lc) !== -1) {
      return { ok: true, message: 'saw text after ' + (Date.now() - start) + 'ms' };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: false, message: 'timed out after ' + timeoutMs + 'ms waiting for text' };
}`;

const ASSERT_TEXT = `(needle) => {
  const lc = needle.toLowerCase();
  const body = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
  return body.indexOf(lc) !== -1
    ? { ok: true, message: 'page contains ' + JSON.stringify(needle) }
    : { ok: false, message: 'page does NOT contain ' + JSON.stringify(needle) };
}`;

const EXTRACT_SCRIPT = `(query) => {
  const text = (document.body && document.body.innerText) ? document.body.innerText : '';
  if (!query) return { ok: true, message: 'no query', extracted: text.slice(0, 1200) };
  const keywords = String(query).split(/\\s+/).filter(Boolean).map(w => w.toLowerCase());
  const lines = text.split(/\\n+/);
  const matches = [];
  for (const line of lines) {
    const lc = line.toLowerCase();
    if (keywords.every(k => lc.indexOf(k) !== -1)) matches.push(line.trim());
    if (matches.length >= 5) break;
  }
  if (matches.length === 0) return { ok: false, message: 'no lines matched query', extracted: '' };
  return { ok: true, message: 'matched ' + matches.length + ' line(s)', extracted: matches.join('\\n').slice(0, 1200) };
}`;

export async function executePlanOp(
  op: PlanOp,
  browser: BrowserSession,
): Promise<OpResult> {
  switch (op.op) {
    case "goto": {
      try {
        await browser.navigate(op.url);
        return { ok: true, message: `navigated to ${op.url}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `navigate failed: ${msg}` };
      }
    }
    case "click_text": {
      const r = await browser.evaluate<OpResult>(
        `(${CLICK_BY_TEXT})(${JSON.stringify(op.text)})`,
      );
      return r;
    }
    case "type": {
      const r = await browser.evaluate<OpResult>(
        `(${TYPE_BY_LABEL})(${JSON.stringify(op.label)}, ${JSON.stringify(op.value)}, ${op.submit ? "true" : "false"})`,
      );
      return r;
    }
    case "wait_for_text": {
      const timeoutMs = op.timeout_ms ?? 3000;
      const r = await browser.evaluate<OpResult>(
        `(${WAIT_FOR_TEXT})(${JSON.stringify(op.text)}, ${timeoutMs})`,
      );
      return r;
    }
    case "assert_text": {
      return await browser.evaluate<OpResult>(
        `(${ASSERT_TEXT})(${JSON.stringify(op.text)})`,
      );
    }
    case "scroll": {
      const px = op.pixels ?? 600;
      const dy = op.direction === "up" ? -px : px;
      await browser.evaluate(`window.scrollBy(0, ${dy})`);
      return { ok: true, message: `scrolled ${op.direction} ${px}px` };
    }
    case "extract": {
      return await browser.evaluate<OpResult>(
        `(${EXTRACT_SCRIPT})(${JSON.stringify(op.query)})`,
      );
    }
    case "finish": {
      return { ok: true, message: `finished: ${op.reason}` };
    }
  }
}

export function opLabel(op: PlanOp): string {
  switch (op.op) {
    case "goto":
      return `goto(${truncate(op.url, 60)})`;
    case "click_text":
      return `click_text(${truncate(op.text, 40)})`;
    case "type":
      return `type(${truncate(op.label, 30)}=${truncate(op.value, 30)}${op.submit ? ", submit" : ""})`;
    case "wait_for_text":
      return `wait_for_text(${truncate(op.text, 40)})`;
    case "assert_text":
      return `assert_text(${truncate(op.text, 40)})`;
    case "scroll":
      return `scroll(${op.direction}${op.pixels ? `, ${op.pixels}` : ""})`;
    case "extract":
      return `extract(${truncate(op.query, 40)})`;
    case "finish":
      return `finish(${truncate(op.reason, 40)})`;
  }
}

export function opToRecord(
  op: PlanOp,
  result: OpResult,
): { type: string } & Record<string, unknown> {
  const base: { type: string } & Record<string, unknown> = {
    type: op.op,
    ok: result.ok,
    result: result.message,
  };
  if ("thought" in op && op.thought !== undefined) base.thought = op.thought;
  if (op.op === "goto") base.url = op.url;
  if (op.op === "click_text") base.text = op.text;
  if (op.op === "type") {
    base.label = op.label;
    base.value = op.value;
    if (op.submit) base.submit = true;
  }
  if (op.op === "wait_for_text") {
    base.text = op.text;
    if (op.timeout_ms !== undefined) base.timeout_ms = op.timeout_ms;
  }
  if (op.op === "assert_text") base.text = op.text;
  if (op.op === "scroll") {
    base.direction = op.direction;
    if (op.pixels !== undefined) base.pixels = op.pixels;
  }
  if (op.op === "extract") {
    base.query = op.query;
    if (result.extracted) base.extracted = result.extracted;
  }
  if (op.op === "finish") base.reason = op.reason;
  return base;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
