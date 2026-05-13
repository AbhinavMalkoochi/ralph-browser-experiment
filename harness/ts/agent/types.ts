// Agent / trajectory / browser primitives shared across the harness and any
// individual agent under agents/.
//
// US-002 nails down the contract; US-003 will replace BrowserSession's stub
// with a pooled implementation, US-004 layers Budget cost accounting onto the
// LLMClient, US-005 fills in VerifierVerdict.

import type { CdpSession } from "../cdp/client.js";

/** Why a trajectory ended. */
export type TerminalState =
  | "DONE" // agent finished and believes the goal is met
  | "DONE_BY_PREDICATE" // codegen-predicate (US-032): loop exited because the agent-synthesised predicate fired true
  | "DECLINED" // agent gave up explicitly (e.g. cannot proceed)
  | "BUDGET_EXCEEDED" // budget axis tripped
  | "ERROR" // unrecoverable internal failure
  | "SESSION_TIMEOUT" // hard wall enforced by harness (US-003)
  | "SKIPPED_AUTH"; // task requires env vars that were not set (US-028)

export interface VerifierVerdict {
  pass: boolean;
  score: number; // 0..1
  reason: string;
}

export interface BudgetLimits {
  tokens: number;
  usd: number;
  wallSeconds: number;
  steps: number;
}

export interface BudgetUsage {
  tokens: number;
  usd: number;
  wallSeconds: number;
  steps: number;
}

export type BudgetAxis = keyof BudgetLimits;

export class BudgetExceeded extends Error {
  readonly axis: BudgetAxis;
  readonly limit: number;
  readonly used: number;
  constructor(axis: BudgetAxis, limit: number, used: number) {
    super(`budget exceeded on ${axis}: used ${used} > limit ${limit}`);
    this.name = "BudgetExceeded";
    this.axis = axis;
    this.limit = limit;
    this.used = used;
  }
}

/**
 * Per-task budget. Agents must call recordStep() / recordTokens() and check()
 * before performing expensive work; check() throws BudgetExceeded which the
 * harness records as TerminalState=BUDGET_EXCEEDED.
 */
export class Budget {
  readonly limits: BudgetLimits;
  readonly used: BudgetUsage = { tokens: 0, usd: 0, wallSeconds: 0, steps: 0 };
  private readonly startedAt: number = Date.now();

  constructor(limits: BudgetLimits) {
    this.limits = limits;
  }

  recordTokens(tokensIn: number, tokensOut: number, usd: number): void {
    this.used.tokens += tokensIn + tokensOut;
    this.used.usd += usd;
  }

  recordStep(): void {
    this.used.steps += 1;
    this.used.wallSeconds = (Date.now() - this.startedAt) / 1000;
  }

  /** Throws BudgetExceeded if any axis is over limit. */
  check(): void {
    this.used.wallSeconds = (Date.now() - this.startedAt) / 1000;
    const { tokens, usd, wallSeconds, steps } = this.used;
    if (tokens > this.limits.tokens) throw new BudgetExceeded("tokens", this.limits.tokens, tokens);
    if (usd > this.limits.usd) throw new BudgetExceeded("usd", this.limits.usd, usd);
    if (wallSeconds > this.limits.wallSeconds)
      throw new BudgetExceeded("wallSeconds", this.limits.wallSeconds, wallSeconds);
    if (steps > this.limits.steps) throw new BudgetExceeded("steps", this.limits.steps, steps);
  }

  remaining(): BudgetUsage {
    return {
      tokens: Math.max(0, this.limits.tokens - this.used.tokens),
      usd: Math.max(0, this.limits.usd - this.used.usd),
      wallSeconds: Math.max(0, this.limits.wallSeconds - this.used.wallSeconds),
      steps: Math.max(0, this.limits.steps - this.used.steps),
    };
  }
}

export interface Action {
  type: string;
  [k: string]: unknown;
}

export interface TrajectoryStep {
  step: number;
  observation_summary: string;
  action: Action;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  screenshot_path: string | null;
  verifier_state: Record<string, unknown> | null;
}

export interface TrajectoryMetadata {
  agent_id: string;
  task_id: string;
  seed: number;
  start_time: string; // ISO 8601
  end_time: string | null;
  terminal_state: TerminalState | null;
  verifier_verdict: VerifierVerdict | null;
  decline_reason: string | null;
}

/**
 * Per-task isolated browser handle handed to an Agent. US-003 will back this
 * with a pool, snapshot/restore, and crash-replace; US-002 defines only the
 * contract every agent codes against.
 */
export interface BrowserSession {
  readonly id: string;
  /** Escape hatch for raw CDP. Most agents should use the high-level methods. */
  readonly cdp: CdpSession;
  navigate(url: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(): Promise<Buffer>;
}
