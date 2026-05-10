// Action union + parser + in-page dispatcher for the network-shadow agent.
//
// The LLM's primary action is `fetch`: execute an HTTP request from inside
// the page so cookies and origin are preserved AND the same monkey-patch
// logs the call uniformly with the page's own traffic. UI clicks are a
// fallback for when no API path is visible. There is a `done` action
// (LLM declares completion) because the network-shadow mechanism has no
// natural code-side termination signal — the agent CAN look at recent
// response bodies to decide, but the LLM still owns "is the goal met?"

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export class ActionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionParseError";
  }
}

export type AgentAction =
  | {
      type: "fetch";
      method: string;
      url: string;
      body?: string | null;
      content_type?: string | null;
      thought?: string;
    }
  | { type: "click"; selector: string; thought?: string }
  | { type: "navigate"; url: string; thought?: string }
  | { type: "wait"; ms: number; thought?: string }
  | { type: "done"; reason: string; thought?: string }
  | { type: "decline"; reason: string; thought?: string };

export interface ActionResult {
  ok: boolean;
  message: string;
}

const MAX_WAIT_MS = 5_000;

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
  const t = a.type;
  if (typeof t !== "string") throw new ActionParseError("missing string field `type`");
  const thought = typeof a.thought === "string" ? a.thought : undefined;

  switch (t) {
    case "fetch": {
      const method = typeof a.method === "string" ? a.method.toUpperCase() : "GET";
      const url = a.url;
      if (typeof url !== "string" || !url) throw new ActionParseError("fetch: missing `url`");
      const body =
        a.body == null
          ? null
          : typeof a.body === "string"
            ? a.body
            : JSON.stringify(a.body);
      const ct =
        typeof a.content_type === "string"
          ? a.content_type
          : typeof a.contentType === "string"
            ? a.contentType
            : null;
      return { type: "fetch", method, url, body, content_type: ct, thought };
    }
    case "click": {
      const sel = a.selector;
      if (typeof sel !== "string" || !sel) throw new ActionParseError("click: missing `selector`");
      return { type: "click", selector: sel, thought };
    }
    case "navigate": {
      const url = a.url;
      if (typeof url !== "string" || !url) throw new ActionParseError("navigate: missing `url`");
      return { type: "navigate", url, thought };
    }
    case "wait": {
      let ms = typeof a.ms === "number" ? a.ms : Number(a.ms);
      if (!Number.isFinite(ms) || ms < 0) ms = 0;
      if (ms > MAX_WAIT_MS) ms = MAX_WAIT_MS;
      return { type: "wait", ms: Math.round(ms), thought };
    }
    case "done": {
      const reason = typeof a.reason === "string" ? a.reason : "goal reached";
      return { type: "done", reason, thought };
    }
    case "decline": {
      const reason = typeof a.reason === "string" ? a.reason : "cannot proceed";
      return { type: "decline", reason, thought };
    }
    default:
      throw new ActionParseError(`unknown action type: ${t}`);
  }
}

export function actionLabel(a: AgentAction): string {
  switch (a.type) {
    case "fetch":
      return `fetch(${a.method} ${a.url})`;
    case "click":
      return `click(${a.selector})`;
    case "navigate":
      return `navigate(${a.url})`;
    case "wait":
      return `wait(${a.ms}ms)`;
    case "done":
      return `done(${truncate(a.reason, 40)})`;
    case "decline":
      return `decline(${truncate(a.reason, 40)})`;
  }
}

const IN_PAGE_FETCH = (method: string, url: string, body: string | null, ct: string | null): string => {
  const headers: Record<string, string> = {};
  if (ct) headers["content-type"] = ct;
  else if (body && (body.trim().startsWith("{") || body.trim().startsWith("["))) {
    headers["content-type"] = "application/json";
  }
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers,
  };
  if (body != null && !["GET", "HEAD"].includes(method)) init.body = body;
  return `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});
      let txt = "";
      try { txt = await res.text(); } catch (e) { txt = "(unreadable)"; }
      return {
        ok: res.ok,
        status: res.status,
        content_type: (res.headers && res.headers.get && res.headers.get("content-type")) || "",
        body: typeof txt === "string" && txt.length > 800 ? txt.slice(0, 800) + "…" : txt,
      };
    } catch (e) {
      return { ok: false, status: 0, error: String(e && e.message ? e.message : e) };
    }
  })()`;
};

const IN_PAGE_CLICK = (selector: string): string => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, message: "no element matches selector" };
  try {
    el.scrollIntoView && el.scrollIntoView({ block: "center", inline: "center" });
  } catch (e) {}
  try {
    el.click ? el.click() : el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { ok: true, message: "click dispatched" };
  } catch (e) {
    return { ok: false, message: "click threw: " + String(e && e.message ? e.message : e) };
  }
})()`;

export async function executeAction(action: AgentAction, browser: BrowserSession): Promise<ActionResult> {
  switch (action.type) {
    case "fetch": {
      const script = IN_PAGE_FETCH(action.method, action.url, action.body ?? null, action.content_type ?? null);
      const r = await browser.evaluate<{
        ok: boolean;
        status: number;
        body?: string;
        content_type?: string;
        error?: string;
      }>(script);
      if (r.error) return { ok: false, message: `fetch error: ${truncate(r.error, 160)}` };
      const sample = r.body ? truncate(r.body, 240) : "";
      return {
        ok: r.ok,
        message: `${action.method} ${action.url} → ${r.status} ${r.content_type ?? ""} ${sample}`.trim(),
      };
    }
    case "click": {
      const r = await browser.evaluate<{ ok: boolean; message: string }>(IN_PAGE_CLICK(action.selector));
      return r;
    }
    case "navigate": {
      try {
        await browser.navigate(action.url);
        return { ok: true, message: `navigated to ${action.url}` };
      } catch (err) {
        return { ok: false, message: `navigate threw: ${truncate(err instanceof Error ? err.message : String(err), 160)}` };
      }
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, action.ms));
      return { ok: true, message: `waited ${action.ms}ms` };
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
