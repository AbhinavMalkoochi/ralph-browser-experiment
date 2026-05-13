// Action vocabulary for the fs-memory agent.
//
// The LLM emits a single JSON object per turn. We accept a small set of
// filesystem actions (scoped to a per-task scratch directory) and a small
// set of browser actions. Observations live primarily on disk; the prompt
// shows only (a) the scratch file tree and (b) the result of the LAST
// action — there is no rolling observation history.

export type FsAction =
  | { type: "fs.write"; path: string; content: string; thought?: string }
  | { type: "fs.append"; path: string; content: string; thought?: string }
  | { type: "fs.read"; path: string; thought?: string }
  | { type: "fs.list"; thought?: string }
  | { type: "fs.delete"; path: string; thought?: string };

export type BrowserAction =
  | { type: "browser.observe"; selector?: string; thought?: string }
  | { type: "browser.click"; selector: string; thought?: string }
  | {
      type: "browser.type";
      selector: string;
      text: string;
      submit?: boolean;
      thought?: string;
    }
  | { type: "browser.navigate"; url: string; thought?: string }
  | {
      type: "browser.scroll";
      direction?: "up" | "down";
      pixels?: number;
      thought?: string;
    }
  | { type: "browser.wait"; ms?: number; thought?: string };

export type ControlAction =
  | { type: "done"; reason: string; thought?: string }
  | { type: "decline"; reason: string; thought?: string };

export type AgentAction = FsAction | BrowserAction | ControlAction;

export class ActionParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "ActionParseError";
  }
}

const KNOWN_TYPES = new Set([
  "fs.write",
  "fs.append",
  "fs.read",
  "fs.list",
  "fs.delete",
  "browser.observe",
  "browser.click",
  "browser.type",
  "browser.navigate",
  "browser.scroll",
  "browser.wait",
  "done",
  "decline",
]);

// A few easy aliases we tolerate so the LLM's natural language ("write_note",
// "navigate", "click") doesn't cost a turn.
const ALIASES: Record<string, string> = {
  write: "fs.write",
  write_file: "fs.write",
  append: "fs.append",
  read: "fs.read",
  read_file: "fs.read",
  list: "fs.list",
  ls: "fs.list",
  tree: "fs.list",
  delete: "fs.delete",
  rm: "fs.delete",
  observe: "browser.observe",
  click: "browser.click",
  type: "browser.type",
  navigate: "browser.navigate",
  goto: "browser.navigate",
  scroll: "browser.scroll",
  wait: "browser.wait",
  finish: "done",
};

export function parseAction(raw: string): AgentAction {
  const trimmed = raw.trim();
  const jsonText = stripFences(trimmed);
  const obj = extractFirstObject(jsonText);
  if (!obj) throw new ActionParseError("no JSON object in completion", raw);

  let type = String(obj.type ?? obj.action ?? "").toLowerCase().trim();
  if (ALIASES[type]) type = ALIASES[type] as string;
  if (!KNOWN_TYPES.has(type))
    throw new ActionParseError(`unknown action type ${JSON.stringify(type)}`, raw);

  const thought = typeof obj.thought === "string" ? obj.thought : undefined;
  const withThought = <T extends object>(a: T): T =>
    thought !== undefined ? ({ ...a, thought } as T) : a;

  switch (type) {
    case "fs.write": {
      const path = requireString(obj, ["path", "file"], "fs.write missing path", raw);
      const content = requireString(obj, ["content", "text", "body"], "fs.write missing content", raw);
      return withThought({ type: "fs.write", path, content });
    }
    case "fs.append": {
      const path = requireString(obj, ["path", "file"], "fs.append missing path", raw);
      const content = requireString(obj, ["content", "text", "body"], "fs.append missing content", raw);
      return withThought({ type: "fs.append", path, content });
    }
    case "fs.read": {
      const path = requireString(obj, ["path", "file"], "fs.read missing path", raw);
      return withThought({ type: "fs.read", path });
    }
    case "fs.list":
      return withThought({ type: "fs.list" });
    case "fs.delete": {
      const path = requireString(obj, ["path", "file"], "fs.delete missing path", raw);
      return withThought({ type: "fs.delete", path });
    }
    case "browser.observe": {
      const selRaw = obj.selector ?? obj.target;
      const selector = typeof selRaw === "string" && selRaw.length > 0 ? selRaw : undefined;
      return withThought(
        selector ? { type: "browser.observe", selector } : { type: "browser.observe" },
      );
    }
    case "browser.click": {
      const selector = requireString(
        obj,
        ["selector", "target", "css"],
        "browser.click missing selector",
        raw,
      );
      return withThought({ type: "browser.click", selector });
    }
    case "browser.type": {
      const selector = requireString(
        obj,
        ["selector", "target", "css"],
        "browser.type missing selector",
        raw,
      );
      const text = String(obj.text ?? obj.value ?? "");
      const submit = obj.submit === true;
      return withThought(
        submit
          ? { type: "browser.type", selector, text, submit: true }
          : { type: "browser.type", selector, text },
      );
    }
    case "browser.navigate": {
      const url = requireString(obj, ["url", "href"], "browser.navigate missing url", raw);
      return withThought({ type: "browser.navigate", url });
    }
    case "browser.scroll": {
      const dirRaw = String(obj.direction ?? "down").toLowerCase();
      const direction: "up" | "down" = dirRaw === "up" ? "up" : "down";
      const pixels = typeof obj.pixels === "number" ? Math.max(0, Math.min(4000, obj.pixels)) : undefined;
      return withThought(
        pixels !== undefined
          ? { type: "browser.scroll", direction, pixels }
          : { type: "browser.scroll", direction },
      );
    }
    case "browser.wait": {
      const msRaw = typeof obj.ms === "number" ? obj.ms : typeof obj.seconds === "number" ? obj.seconds * 1000 : 400;
      const ms = Math.max(0, Math.min(10_000, msRaw));
      return withThought({ type: "browser.wait", ms });
    }
    case "done": {
      const reason = String(obj.reason ?? obj.text ?? obj.message ?? "goal complete");
      return withThought({ type: "done", reason });
    }
    case "decline": {
      const reason = String(obj.reason ?? obj.text ?? obj.message ?? "cannot proceed");
      return withThought({ type: "decline", reason });
    }
  }
  throw new ActionParseError(`unreachable action type ${type}`, raw);
}

function requireString(
  obj: Record<string, unknown>,
  keys: string[],
  message: string,
  raw: string,
): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  throw new ActionParseError(message, raw);
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

/** Short canonical label for trajectory step records. */
export function actionLabel(a: AgentAction): string {
  switch (a.type) {
    case "fs.write":
    case "fs.append":
    case "fs.read":
    case "fs.delete":
      return `${a.type} ${a.path}`;
    case "fs.list":
      return "fs.list";
    case "browser.observe":
      return a.selector ? `browser.observe ${a.selector}` : "browser.observe";
    case "browser.click":
      return `browser.click ${a.selector}`;
    case "browser.type":
      return `browser.type ${a.selector} ${JSON.stringify(a.text).slice(0, 40)}${a.submit ? " --submit" : ""}`;
    case "browser.navigate":
      return `browser.navigate ${a.url}`;
    case "browser.scroll":
      return `browser.scroll ${a.direction ?? "down"} ${a.pixels ?? 400}`;
    case "browser.wait":
      return `browser.wait ${a.ms ?? 400}`;
    case "done":
      return `done ${a.reason}`;
    case "decline":
      return `decline ${a.reason}`;
  }
}
