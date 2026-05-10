// runtime-codegen DSL: extract the LLM-emitted JavaScript body, wrap it in an
// async IIFE, run it through CDP Runtime.evaluate, and normalise the result.
//
// Where the baseline emits a JSON action object and plan-then-execute emits a
// JSON plan, this agent emits *raw JavaScript* that runs INSIDE the page. The
// LLM is the action vocabulary; there is no fixed verb set. The body's return
// value (a JSON-serialisable object) is the contract:
//
//   return { done: true,  message: "..." }            // task complete
//   return { done: false, message: "..." }            // continue, look at the
//                                                     //   next observation
//   return { done: false, navigate: "https://...", message: "..." }
//   return { done: false, sleep_ms: 500, message: "..." }
//
// The body runs as `(async () => { try { <body> } catch (e) { return {__error: e} } })()`
// so it MAY use `await`. Runtime errors are caught in-page and surfaced as the
// next observation. Syntax errors throw out of browser.evaluate and are
// caught by the agent at the boundary.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export class CodegenParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "CodegenParseError";
  }
}

/** Normalised result the agent loop consumes. */
export interface EmitResult {
  /** True if browser.evaluate did not throw AND the body did not return {__error:...}. */
  ok: boolean;
  /** Body asked the agent to finish the run. */
  done: boolean;
  /** Short progress note, surfaced as the next-step observation. */
  message: string;
  /** Body asked the harness to top-level-navigate (cross-origin nav detaches the JS ctx). */
  navigate: string | null;
  /** Body asked the agent to pause this long before the next step. Clamped 0..5000. */
  sleep_ms: number | null;
  /** In-page exception message when the body threw. */
  error: string | null;
  /** Stack trace excerpt when the body threw. Useful in the trajectory. */
  stack: string | null;
}

/**
 * Extract a JavaScript body from the raw LLM completion.
 *
 * Tolerates:
 *   - ```js / ```javascript / ```ts / bare ``` fences (first one wins).
 *   - Leading or trailing prose (the part NOT inside the fence is discarded).
 *   - A bare body (no fence) — taken verbatim.
 *
 * Rejects:
 *   - Empty/whitespace-only body.
 *   - Body with no `return` statement at top level — the body MUST return an
 *     EmitResult-shaped object, so no return = the LLM misunderstood the task.
 *
 * Note: we do NOT parse the JS. The wrapper IIFE wraps whatever string we get,
 * so syntax errors land at evaluate-time as a CDP exception which the agent
 * catches and feeds back as the next observation. Tolerance is intentional.
 */
export function extractScript(raw: string): string {
  if (raw == null) throw new CodegenParseError("empty completion", "");
  const trimmed = String(raw).trim();
  if (!trimmed) throw new CodegenParseError("empty completion", raw);
  const fenced = matchFirstFence(trimmed);
  const body = (fenced ?? trimmed).trim();
  if (!body) throw new CodegenParseError("empty script body", raw);
  if (!/\breturn\b/.test(body)) {
    throw new CodegenParseError(
      "script body must contain a top-level return; see the prompt for the EmitResult schema",
      raw,
    );
  }
  return body;
}

function matchFirstFence(text: string): string | null {
  const m = text.match(/```(?:[A-Za-z0-9_+\-]*)\s*\n([\s\S]*?)```/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Wrap the body in an async IIFE with an in-page try/catch and run it via
 * CDP Runtime.evaluate. Returns a normalised EmitResult — does NOT throw
 * for runtime errors in the body (those come back as {__error,__stack});
 * DOES throw for transport / syntax errors (the agent loop catches them).
 */
export async function runEmittedScript(
  body: string,
  browser: BrowserSession,
): Promise<EmitResult> {
  const wrapped = wrapBody(body);
  const raw = await browser.evaluate<unknown>(wrapped);
  return normaliseResult(raw);
}

/**
 * Build the IIFE the page evaluates. Pulled out for unit testing — the
 * wrapper has subtle bits (no top-level `await`; in-page catch must
 * stringify errors safely; the result must be JSON-serialisable).
 */
export function wrapBody(body: string): string {
  return [
    "(async () => {",
    "  try {",
    body,
    "  } catch (__err) {",
    "    var __msg = (__err && __err.message) ? String(__err.message) : String(__err);",
    "    var __stk = (__err && __err.stack) ? String(__err.stack) : null;",
    "    return {__error: __msg.slice(0, 500), __stack: __stk ? __stk.slice(0, 800) : null};",
    "  }",
    "})()",
  ].join("\n");
}

/**
 * Normalise the in-page return value into the EmitResult shape. The body may
 * return anything (or nothing); we are defensive. Unknown / non-JSON-serialisable
 * returns degrade to ok:false with a descriptive message — the agent surfaces
 * that to the LLM as the next observation so a retry can self-correct.
 */
export function normaliseResult(raw: unknown): EmitResult {
  if (raw === null || raw === undefined) {
    return blank("script returned no value (expected an object)");
  }
  if (typeof raw !== "object") {
    return blank(
      `script returned a ${typeof raw}; expected an object like {done:false,message:"..."}`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if ("__error" in obj) {
    const err = typeof obj.__error === "string" ? obj.__error : "in-page error";
    const stk = typeof obj.__stack === "string" ? obj.__stack : null;
    return {
      ok: false,
      done: false,
      message: `script threw: ${truncate(err, 300)}`,
      navigate: null,
      sleep_ms: null,
      error: err,
      stack: stk,
    };
  }
  const done = obj.done === true;
  const message = typeof obj.message === "string" ? obj.message : "";
  const navigate =
    typeof obj.navigate === "string" && obj.navigate.length > 0
      ? obj.navigate
      : null;
  let sleep_ms: number | null = null;
  if (typeof obj.sleep_ms === "number" && Number.isFinite(obj.sleep_ms)) {
    sleep_ms = Math.max(0, Math.min(5_000, Math.floor(obj.sleep_ms)));
  }
  return {
    ok: true,
    done,
    message: message || (done ? "done" : "continuing"),
    navigate,
    sleep_ms,
    error: null,
    stack: null,
  };
}

function blank(message: string): EmitResult {
  return {
    ok: false,
    done: false,
    message,
    navigate: null,
    sleep_ms: null,
    error: null,
    stack: null,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
