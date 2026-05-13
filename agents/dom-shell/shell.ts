// dom-shell DSL — a tiny POSIX-flavoured shell over the DOM tree treated as a
// filesystem. The LLM emits ONE command per turn (e.g. `find button --interactive`
// or `click "Buy now"`); the harness tokenises it, dispatches to a small
// in-page handler via CDP Runtime.evaluate, and persists the result.
//
// Distinct from runtime-codegen (unbounded JS) and baseline (named JSON
// actions): the LLM only ever writes a single short shell line, and the cwd
// (a CSS-selector chain) PERSISTS across steps so the LLM can `cd` into a
// subtree (a shadow host, an iframe wrapper, a complex form) and then
// operate with terse local-relative selectors.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

/* ---------- types ---------- */

export type ShellCommand =
  | { cmd: "ls"; selector?: string }
  | { cmd: "cd"; target: string } // "..", "/", or a CSS selector
  | { cmd: "cat"; selector?: string }
  | { cmd: "grep"; pattern: string; selector?: string }
  | { cmd: "find"; selector: string; interactive: boolean }
  | { cmd: "attr"; name: string; selector?: string }
  | { cmd: "click"; selector: string }
  | { cmd: "type"; selector: string; text: string; submit: boolean }
  | { cmd: "scroll"; direction: "down" | "up"; pixels: number }
  | { cmd: "wait"; ms: number }
  | { cmd: "done"; reason: string }
  | { cmd: "decline"; reason: string };

export class ShellParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "ShellParseError";
  }
}

/* ---------- tokenisation ---------- */

/**
 * Tokenise a shell-style line. Supports double-quoted and single-quoted
 * strings; an unterminated quote is reported as a parse error. Comments
 * starting with `#` are dropped.
 */
export function tokenise(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  // No `#` comment handling — `#` is a CSS id selector character and the
  // ambiguity is not worth a comment syntax we don't actually need.
  while (i < n) {
    const ch = line[i]!;
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let buf = "";
      let closed = false;
      while (i < n) {
        const c = line[i]!;
        if (c === "\\" && i + 1 < n) {
          buf += line[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        buf += c;
        i += 1;
      }
      if (!closed) throw new ShellParseError(`unterminated ${quote}-quoted string`, line);
      out.push(buf);
      continue;
    }
    let buf = "";
    while (i < n) {
      const c = line[i]!;
      if (c === " " || c === "\t") break;
      buf += c;
      i += 1;
    }
    out.push(buf);
  }
  return out;
}

/* ---------- parsing ---------- */

/**
 * Parse a single shell command. Tolerates:
 *   - leading prose followed by a fenced block (```...```), in which case the
 *     first non-empty line inside the fence is the command;
 *   - leading prose followed by a bare command on its own line (last non-empty
 *     line wins — many LLMs emit "Thought: ...\n<cmd>" patterns);
 *   - inline comments (`# ...`).
 *
 * Rejects:
 *   - empty/whitespace-only input;
 *   - unknown commands;
 *   - missing required positional args.
 */
export function parseCommand(raw: string): ShellCommand {
  if (raw == null) throw new ShellParseError("empty completion", "");
  const text = String(raw).trim();
  if (!text) throw new ShellParseError("empty completion", raw);

  const fenceMatch = text.match(/```(?:[A-Za-z0-9_+\-]*)\s*\n([\s\S]*?)```/);
  const body = fenceMatch ? (fenceMatch[1] ?? "") : text;

  // pick the last non-empty line as the command line
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const line = lines[lines.length - 1];
  if (!line) throw new ShellParseError("no command line found", raw);

  let tokens: string[];
  try {
    tokens = tokenise(line);
  } catch (e) {
    if (e instanceof ShellParseError) throw new ShellParseError(e.message, raw);
    throw e;
  }
  if (tokens.length === 0) throw new ShellParseError("no tokens parsed", raw);

  const head = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1);

  switch (head) {
    case "ls": {
      const sel = rest.join(" ").trim();
      return sel ? { cmd: "ls", selector: sel } : { cmd: "ls" };
    }
    case "cd": {
      if (rest.length === 0) throw new ShellParseError("cd: missing target", raw);
      // cd accepts "..", "/", or a selector. Selectors can contain spaces, so
      // glue tokens back together when there are several.
      const target = rest.join(" ").trim();
      return { cmd: "cd", target };
    }
    case "cat": {
      const sel = rest.join(" ").trim();
      return sel ? { cmd: "cat", selector: sel } : { cmd: "cat" };
    }
    case "grep": {
      if (rest.length === 0) throw new ShellParseError("grep: missing pattern", raw);
      const pattern = rest[0]!;
      const sel = rest.slice(1).join(" ").trim();
      return sel ? { cmd: "grep", pattern, selector: sel } : { cmd: "grep", pattern };
    }
    case "find": {
      const flags = rest.filter((t) => t.startsWith("--"));
      const positional = rest.filter((t) => !t.startsWith("--"));
      const interactive = flags.includes("--interactive");
      const selector = positional.join(" ").trim() || "*";
      return { cmd: "find", selector, interactive };
    }
    case "attr": {
      if (rest.length === 0) throw new ShellParseError("attr: missing name", raw);
      const name = rest[0]!;
      const sel = rest.slice(1).join(" ").trim();
      return sel ? { cmd: "attr", name, selector: sel } : { cmd: "attr", name };
    }
    case "click": {
      if (rest.length === 0) throw new ShellParseError("click: missing selector", raw);
      return { cmd: "click", selector: rest.join(" ").trim() };
    }
    case "type": {
      if (rest.length < 2) throw new ShellParseError("type: need selector and text", raw);
      // last token may be --submit; second-to-last is the text; the rest is selector
      const flags = rest.filter((t) => t === "--submit");
      const positional = rest.filter((t) => t !== "--submit");
      if (positional.length < 2) {
        throw new ShellParseError("type: need selector and text", raw);
      }
      const text = positional[positional.length - 1]!;
      const selector = positional.slice(0, -1).join(" ").trim();
      return { cmd: "type", selector, text, submit: flags.length > 0 };
    }
    case "scroll": {
      let direction: "down" | "up" = "down";
      let pixels = 400;
      for (const t of rest) {
        if (t === "down" || t === "up") direction = t;
        else if (/^-?\d+$/.test(t)) pixels = Math.abs(parseInt(t, 10));
      }
      return { cmd: "scroll", direction, pixels };
    }
    case "wait": {
      const ms = rest[0] ? parseInt(rest[0], 10) : 400;
      const clamped = Math.max(0, Math.min(5000, Number.isFinite(ms) ? ms : 400));
      return { cmd: "wait", ms: clamped };
    }
    case "done": {
      return { cmd: "done", reason: rest.join(" ").trim() || "goal met" };
    }
    case "decline": {
      return { cmd: "decline", reason: rest.join(" ").trim() || "no path forward" };
    }
    default:
      throw new ShellParseError(`unknown command: ${head}`, raw);
  }
}

/* ---------- cwd algebra ---------- */

/** Apply `cd` to the cwd stack. Returns the NEW stack. Does NOT touch the DOM. */
export function applyCd(cwd: readonly string[], target: string): string[] {
  const t = target.trim();
  if (t === "/" || t === "") return [];
  if (t === ".") return cwd.slice();
  if (t === "..") return cwd.slice(0, Math.max(0, cwd.length - 1));
  if (t.startsWith("/")) {
    // absolute reset + push the rest
    const sub = t.slice(1).trim();
    return sub ? [sub] : [];
  }
  return [...cwd, t];
}

/** Join cwd segments into a single CSS selector. Empty stack → "" (document root). */
export function cwdSelector(cwd: readonly string[]): string {
  return cwd.join(" ").trim();
}

/** Render the cwd for display in the LLM prompt: `/`, `/form`, `/form input[name="x"]`. */
export function cwdDisplay(cwd: readonly string[]): string {
  if (cwd.length === 0) return "/";
  return "/" + cwd.join(" / ");
}

/* ---------- in-page handler ---------- */

/**
 * The in-page handler. Built once, run via Runtime.evaluate every step with
 * the cwd selector, command, and args interpolated in as a JSON arg.
 *
 * Returns a JSON-serialisable result object that always has:
 *   { ok: bool, output: string, error?: string, extras?: object }
 *
 * The cwd resolution policy:
 *   - cwd selector "" → document
 *   - cwd selector "X" → document.querySelector("X")
 *   - if cwd does not resolve, ok=false with a "cwd unresolved" message.
 *     The agent uses this signal to reset cwd to root.
 */
const IN_PAGE_HANDLER = String.raw`
function __gba_dom_shell(arg) {
  const { cwd, cmd, args } = arg;
  function resolveCwd() {
    if (!cwd || cwd.trim() === "") return document.body || document.documentElement;
    try {
      return document.querySelector(cwd);
    } catch (e) { return null; }
  }
  function listChildren(root) {
    if (!root) return [];
    const kids = Array.from(root.children || []);
    return kids.slice(0, 40).map((el, i) => {
      const tag = (el.tagName || "").toLowerCase();
      const role = el.getAttribute("role") || tag;
      const id = el.id ? "#" + el.id : "";
      const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
      const clsStr = cls.length ? "." + cls.join(".") : "";
      const txt = ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 20);
      return "[" + i + "] <" + tag + id + clsStr + "> role=" + role + " \"" + txt + "\"";
    });
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    const s = w ? w.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) return false;
    return true;
  }
  function isInteractive(el) {
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "button" || tag === "a" || tag === "input" || tag === "textarea" || tag === "select") return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "button" || role === "link" || role === "checkbox" || role === "menuitem") return true;
    if (el.hasAttribute && el.hasAttribute("onclick")) return true;
    return false;
  }
  function describe(el, idx) {
    const tag = (el.tagName || "").toLowerCase();
    const id = el.id ? "#" + el.id : "";
    const name = el.getAttribute("name") ? "[name=\"" + el.getAttribute("name") + "\"]" : "";
    const txt = ((el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim()).slice(0, 30);
    return "[" + idx + "] <" + tag + id + name + "> \"" + txt + "\"";
  }
  function resolveRel(sel) {
    const base = resolveCwd();
    if (!base) return null;
    try {
      // When cwd is the document body and selector is a tag, just queryselector
      if (base === document.body || base === document.documentElement) {
        return document.querySelector(sel);
      }
      return base.querySelector(sel);
    } catch (e) { return null; }
  }
  const root = resolveCwd();
  if (!root && cwd && cwd.trim() !== "") {
    return { ok: false, output: "", error: "cwd unresolved: " + cwd };
  }
  try {
    switch (cmd) {
      case "ls": {
        const sel = args.selector || "";
        let base = root;
        if (sel) {
          try { base = root.querySelector ? root.querySelector(sel) : null; }
          catch (e) { return { ok: false, output: "", error: "ls: bad selector: " + (e && e.message) }; }
          if (!base) return { ok: false, output: "", error: "ls: no match for " + sel };
        }
        const lines = listChildren(base);
        const count = (base && base.children) ? base.children.length : 0;
        return { ok: true, output: lines.join("\n"), extras: { count: count } };
      }
      case "cat": {
        const sel = args.selector;
        let target = root;
        if (sel) {
          try { target = root.querySelector ? root.querySelector(sel) : null; }
          catch (e) { return { ok: false, output: "", error: "cat: bad selector" }; }
          if (!target) return { ok: false, output: "", error: "cat: no match for " + sel };
        }
        const text = ((target && (target.innerText || target.textContent)) || "").replace(/\s+/g, " ").trim();
        const capped = text.slice(0, 4000);
        return { ok: true, output: capped, extras: { truncated: text.length > 4000, length: text.length } };
      }
      case "grep": {
        const pattern = args.pattern;
        const sel = args.selector;
        let target = root;
        if (sel) {
          try { target = root.querySelector ? root.querySelector(sel) : null; }
          catch (e) { return { ok: false, output: "", error: "grep: bad selector" }; }
          if (!target) return { ok: false, output: "", error: "grep: no match for " + sel };
        }
        let re;
        try { re = new RegExp(pattern, "i"); }
        catch (e) { return { ok: false, output: "", error: "grep: bad regex: " + (e && e.message) }; }
        const text = ((target && (target.innerText || target.textContent)) || "");
        const hits = [];
        const ls = text.split(/\r?\n/);
        for (let i = 0; i < ls.length && hits.length < 40; i++) {
          if (re.test(ls[i])) hits.push(ls[i].slice(0, 200));
        }
        return { ok: true, output: hits.join("\n"), extras: { matches: hits.length } };
      }
      case "find": {
        const sel = args.selector || "*";
        const interactive = !!args.interactive;
        let nodes;
        try {
          if (root === document.body || root === document.documentElement) {
            nodes = Array.from(document.querySelectorAll(sel));
          } else {
            nodes = Array.from(root.querySelectorAll(sel));
          }
        } catch (e) {
          return { ok: false, output: "", error: "find: bad selector: " + (e && e.message) };
        }
        const visibleNodes = nodes.filter(visible);
        const filtered = interactive ? visibleNodes.filter(isInteractive) : visibleNodes;
        const cap = filtered.slice(0, 40);
        const lines = cap.map((el, i) => describe(el, i));
        return { ok: true, output: lines.join("\n"), extras: { total: filtered.length, returned: cap.length } };
      }
      case "attr": {
        const name = args.name;
        const sel = args.selector;
        let target = root;
        if (sel) {
          try { target = root.querySelector ? root.querySelector(sel) : null; }
          catch (e) { return { ok: false, output: "", error: "attr: bad selector" }; }
          if (!target) return { ok: false, output: "", error: "attr: no match for " + sel };
        }
        if (!target || !target.getAttribute) return { ok: false, output: "", error: "attr: target has no attributes" };
        const v = target.getAttribute(name);
        return { ok: true, output: v === null ? "(null)" : String(v).slice(0, 500) };
      }
      case "click": {
        const sel = args.selector;
        const target = resolveRel(sel);
        if (!target) return { ok: false, output: "", error: "click: no match for " + sel };
        if (target.scrollIntoView) {
          try { target.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
        }
        if (typeof target.click === "function") {
          target.click();
        } else {
          target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
        const tag = (target.tagName || "").toLowerCase();
        const txt = ((target.innerText || target.textContent || target.value || "").replace(/\s+/g, " ").trim()).slice(0, 60);
        return { ok: true, output: "clicked <" + tag + "> \"" + txt + "\"" };
      }
      case "type": {
        const sel = args.selector;
        const text = args.text;
        const submit = !!args.submit;
        const target = resolveRel(sel);
        if (!target) return { ok: false, output: "", error: "type: no match for " + sel };
        try { target.focus(); } catch (e) {}
        if ("value" in target) {
          try { target.value = ""; } catch (e) {}
          target.value = text;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (target.isContentEditable) {
          target.textContent = text;
          target.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          return { ok: false, output: "", error: "type: target is not an input/textarea/contenteditable" };
        }
        if (submit) {
          const form = target.form || (target.closest ? target.closest("form") : null);
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
          else if (form) form.submit();
          else target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        }
        return { ok: true, output: "typed " + JSON.stringify(text) + (submit ? " (submit)" : "") };
      }
      case "scroll": {
        const dy = args.direction === "up" ? -Math.abs(args.pixels) : Math.abs(args.pixels);
        window.scrollBy(0, dy);
        return { ok: true, output: "scrolled " + args.direction + " " + Math.abs(args.pixels) + "px (y=" + window.scrollY + ")" };
      }
      case "probe-cwd": {
        return { ok: true, output: "" };
      }
      default:
        return { ok: false, output: "", error: "unknown cmd: " + cmd };
    }
  } catch (e) {
    return { ok: false, output: "", error: "in-page exception: " + (e && e.message ? e.message : String(e)) };
  }
}
`;

export interface ExecResult {
  ok: boolean;
  output: string;
  error: string | null;
  extras: Record<string, unknown>;
}

/** Compile a parsed command + cwd into a single CDP Runtime.evaluate string. */
export function compileCommand(cmd: ShellCommand, cwd: readonly string[]): {
  expression: string;
  inPage: boolean;
} {
  // Side-only commands (no in-page work): wait / done / decline.
  if (cmd.cmd === "wait" || cmd.cmd === "done" || cmd.cmd === "decline") {
    return { expression: "", inPage: false };
  }
  const sel = cwdSelector(cwd);
  let argsJson: Record<string, unknown>;
  let kind: string;
  switch (cmd.cmd) {
    case "ls":
      kind = "ls";
      argsJson = { selector: cmd.selector ?? null };
      break;
    case "cat":
      kind = "cat";
      argsJson = { selector: cmd.selector ?? null };
      break;
    case "grep":
      kind = "grep";
      argsJson = { pattern: cmd.pattern, selector: cmd.selector ?? null };
      break;
    case "find":
      kind = "find";
      argsJson = { selector: cmd.selector, interactive: cmd.interactive };
      break;
    case "attr":
      kind = "attr";
      argsJson = { name: cmd.name, selector: cmd.selector ?? null };
      break;
    case "click":
      kind = "click";
      argsJson = { selector: cmd.selector };
      break;
    case "type":
      kind = "type";
      argsJson = { selector: cmd.selector, text: cmd.text, submit: cmd.submit };
      break;
    case "scroll":
      kind = "scroll";
      argsJson = { direction: cmd.direction, pixels: cmd.pixels };
      break;
    case "cd":
      // cd is pure agent-side state; the harness still probes the new cwd
      // to surface "selector unresolved" early.
      kind = "probe-cwd";
      argsJson = {};
      break;
    default:
      throw new Error("compileCommand: unhandled command");
  }
  const arg = { cwd: sel, cmd: kind, args: argsJson };
  const argJson = JSON.stringify(arg);
  const expression = `(() => { ${IN_PAGE_HANDLER}; return __gba_dom_shell(${argJson}); })()`;
  return { expression, inPage: true };
}

/** Execute a parsed command. Mutates `cwd` in place when the command is `cd`. */
export async function execCommand(
  cmd: ShellCommand,
  cwd: string[],
  browser: BrowserSession,
): Promise<ExecResult> {
  if (cmd.cmd === "wait") {
    await new Promise<void>((r) => setTimeout(r, cmd.ms));
    return { ok: true, output: `waited ${cmd.ms}ms`, error: null, extras: {} };
  }
  if (cmd.cmd === "done" || cmd.cmd === "decline") {
    // Terminal — agent loop handles these; we return ok so the step record is clean.
    return { ok: true, output: cmd.reason, error: null, extras: {} };
  }
  if (cmd.cmd === "cd") {
    const next = applyCd(cwd, cmd.target);
    const probeSel = cwdSelector(next);
    if (probeSel) {
      const probe = await runInPage(
        compileCommand(cmd, next).expression,
        browser,
      );
      if (!probe.ok) {
        return {
          ok: false,
          output: "",
          error: `cd: selector "${probeSel}" did not resolve; cwd unchanged`,
          extras: {},
        };
      }
    }
    cwd.length = 0;
    for (const seg of next) cwd.push(seg);
    return {
      ok: true,
      output: `cwd → ${cwdDisplay(cwd)}`,
      error: null,
      extras: { cwd: cwdDisplay(cwd) },
    };
  }
  const { expression } = compileCommand(cmd, cwd);
  return runInPage(expression, browser);
}

async function runInPage(expression: string, browser: BrowserSession): Promise<ExecResult> {
  try {
    const raw = (await browser.evaluate<unknown>(expression)) as Partial<ExecResult> | null;
    if (!raw || typeof raw !== "object") {
      return { ok: false, output: "", error: "in-page handler returned non-object", extras: {} };
    }
    return {
      ok: Boolean(raw.ok),
      output: typeof raw.output === "string" ? raw.output : "",
      error: typeof raw.error === "string" ? raw.error : raw.ok ? null : "(no error message)",
      extras: (raw.extras as Record<string, unknown>) ?? {},
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: "", error: `evaluate threw: ${msg}`, extras: {} };
  }
}

/** Short label for trajectory step records. */
export function commandLabel(cmd: ShellCommand): string {
  switch (cmd.cmd) {
    case "ls":
      return cmd.selector ? `ls ${cmd.selector}` : "ls";
    case "cd":
      return `cd ${cmd.target}`;
    case "cat":
      return cmd.selector ? `cat ${cmd.selector}` : "cat";
    case "grep":
      return cmd.selector ? `grep ${cmd.pattern} ${cmd.selector}` : `grep ${cmd.pattern}`;
    case "find":
      return `find ${cmd.selector}${cmd.interactive ? " --interactive" : ""}`;
    case "attr":
      return cmd.selector ? `attr ${cmd.name} ${cmd.selector}` : `attr ${cmd.name}`;
    case "click":
      return `click ${cmd.selector}`;
    case "type":
      return `type ${cmd.selector} <text>${cmd.submit ? " --submit" : ""}`;
    case "scroll":
      return `scroll ${cmd.direction} ${cmd.pixels}`;
    case "wait":
      return `wait ${cmd.ms}`;
    case "done":
      return `done ${cmd.reason}`;
    case "decline":
      return `decline ${cmd.reason}`;
  }
}
