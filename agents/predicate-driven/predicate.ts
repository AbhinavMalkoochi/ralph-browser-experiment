// Predicate synthesis + in-page evaluation.
//
// The predicate-driven agent's distinguishing mechanism: instead of letting
// the LLM emit a `finish` action, we ask the LLM (ONCE, upfront) to author a
// JavaScript expression that evaluates to TRUE in the page when the goal is
// satisfied. The agent loop polls this predicate after every action; the
// loop terminates from CODE, not from an LLM verdict.
//
// Compared to the harness verifier (harness/ts/verifier/), the predicate is
// AGENT-OWNED: it is not the success criterion the tournament scores against,
// just the agent's internal "are we there yet?" probe. The harness verifier
// runs after agent.run() returns and may use a different predicate / endpoint
// entirely. This isolation is by design — the agent's predicate may be
// over-eager or over-specific; that costs the agent steps but never leaks
// signal into the harness.
//
// Predicate body shape (what the LLM is asked to emit):
//
//   The LLM emits a JS expression returned in JSON: {"predicate": "<expr>"}.
//   The expression is wrapped as
//     (async () => { try { return Boolean(<expr>); }
//                    catch (e) { return { __predicate_error: String(e) }; } })()
//   so it runs as a single awaited promise via Runtime.evaluate. The
//   harness's BrowserSession.evaluate already passes awaitPromise=true.
//
//   The LLM may use any in-page JS: document.* DOM queries, fetch() against
//   same-origin endpoints, shadowRoot traversal — same surface a code-emitting
//   agent would have, but used only for testing not acting.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export class PredicateParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "PredicateParseError";
    this.raw = raw;
  }
}

export interface ParsedPredicate {
  /** The raw JS expression text. */
  expression: string;
  /** Optional rationale the LLM may have included alongside. */
  rationale?: string;
}

/**
 * Parse the LLM's predicate-synthesis completion into a ParsedPredicate.
 *
 * Accepts:
 *   - {"predicate": "<expr>", "rationale": "..."}
 *   - ```json fences
 *   - leading prose
 *
 * Throws PredicateParseError on:
 *   - missing JSON object
 *   - missing `predicate` field
 *   - non-string `predicate` field
 *   - empty / whitespace-only predicate
 */
export function parsePredicate(raw: string): ParsedPredicate {
  if (raw == null) throw new PredicateParseError("empty completion", "");
  const text = stripFences(String(raw).trim());
  if (!text) throw new PredicateParseError("empty completion", raw);
  const obj = extractFirstObject(text);
  if (!obj) throw new PredicateParseError("no JSON object in completion", raw);
  const exprField = obj.predicate ?? obj.expression ?? obj.expr ?? obj.test;
  if (typeof exprField !== "string") {
    throw new PredicateParseError(
      "predicate field missing or not a string",
      raw,
    );
  }
  const expression = exprField.trim();
  if (!expression) throw new PredicateParseError("predicate is empty", raw);
  const rationaleField = obj.rationale ?? obj.thought ?? obj.why;
  const rationale =
    typeof rationaleField === "string" && rationaleField.trim()
      ? rationaleField.trim()
      : undefined;
  return rationale !== undefined ? { expression, rationale } : { expression };
}

/** Wrap a predicate expression so it runs in-page with structured error capture. */
export function wrapPredicate(expression: string): string {
  // Using JSON.stringify(...).slice(1,-1) would lose newlines; we instead
  // embed the expression as the body of an async IIFE and rely on the
  // expression itself being syntactically valid JS. Wrapping in Boolean()
  // forces a strict bool result; the in-page try/catch surfaces any throw.
  return `(async () => { try { return Boolean(${expression}); } catch (e) { return { __predicate_error: (e && e.message) ? e.message : String(e) }; } })()`;
}

export interface PredicateResult {
  /** True if the predicate held; false otherwise. */
  satisfied: boolean;
  /** If the predicate threw in-page, the message is captured here. */
  error?: string;
}

/** Evaluate a previously-parsed predicate against the current page. */
export async function evaluatePredicate(
  expression: string,
  browser: BrowserSession,
): Promise<PredicateResult> {
  const script = wrapPredicate(expression);
  let value: unknown;
  try {
    value = await browser.evaluate(script);
  } catch (err) {
    // Syntax errors throw OUT of evaluate (parse fails before try/catch
    // is entered). Surface as a structured error rather than re-throwing,
    // so the agent loop can record the failure and proceed.
    return {
      satisfied: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "__predicate_error" in value
  ) {
    const msg = (value as { __predicate_error: unknown }).__predicate_error;
    return { satisfied: false, error: typeof msg === "string" ? msg : String(msg) };
  }
  return { satisfied: Boolean(value) };
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
