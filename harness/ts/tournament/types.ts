// Tournament runner types (US-010).
//
// The tournament loop iterates over (agent, task, seed) cells, with per-task
// budgets enforced by difficulty, and is resumable across process restarts:
// each completed cell drops a `summary.json` next to `trajectory.jsonl.gz`,
// and any cell whose summary exists is skipped on re-entry.

import type { TerminalState } from "../agent/types.js";

export type AgentLanguage = "typescript" | "python";

/** Output of agent auto-discovery; one entry per agents/<id>/ directory. */
export interface DiscoveredAgent {
  id: string;
  language: AgentLanguage;
  /** Absolute path to agents/<id>/. */
  dir: string;
  /** Absolute path to agent.ts (TS) or agent.py (Python). */
  agentFile: string;
  /** Parsed manifest.yaml; the harness only reads a subset. */
  manifest: AgentManifest;
}

export interface AgentManifest {
  id: string;
  language: AgentLanguage;
  summary: string;
  approach_keywords: string[];
  distinct_from: string[];
  /** Manifest source (everything we parsed). */
  raw?: Record<string, unknown>;
}

/**
 * One row written to runs/<agent>/<task>/<seed>/summary.json. The presence
 * of this file is the resumable runner's done-marker; the leaderboard
 * aggregator reads it back without ever gunzipping the trajectory.
 */
export interface CellSummary {
  agent_id: string;
  task_id: string;
  seed: number;
  difficulty: string;
  /** Whether the cell was a fresh run or skipped because summary already existed. */
  reused?: boolean;
  /** ISO 8601 timestamp the cell finished. */
  completed_at: string;
  terminal_state: TerminalState | "ERROR" | null;
  pass: boolean;
  score: number;
  reason: string;
  decline_reason: string | null;
  steps: number;
  llm_calls: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  /** Wall-clock duration of run+verify, milliseconds. */
  latency_ms: number;
  /** 1-based count of attempts that ran for this cell; >=1 always. */
  attempts: number;
}

/** One row of the leaderboard, aggregated per (agent, slice). */
export interface LeaderboardRow {
  agent_id: string;
  total: number;
  passed: number;
  /** 0..1 fraction of cells where pass=true. */
  success_pct: number;
  mean_steps: number;
  mean_cost_usd: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  /** Cells that took >1 attempt to pass (retry succeeded after a failure). */
  recovery_count: number;
  /** Cells whose terminal_state is DECLINED. */
  decline_count: number;
}

/** A single matchup in a single-elimination bracket. */
export interface BracketMatch {
  a: string;
  b: string | null; // null means `a` got a bye
  winner: string;
  reason: string;
}

export interface BracketRound {
  round: number;
  matches: BracketMatch[];
}

export interface BracketResult {
  rounds: BracketRound[];
  winner: string;
}

/** Top-level shape of runs/leaderboard.json. */
export interface LeaderboardFile {
  generated_at: string;
  /** Per-slice ranked rows. Sorted desc by success_pct, asc by mean_cost_usd. */
  slices: Record<string, { rows: LeaderboardRow[]; bracket?: BracketResult | null }>;
  /** Overall ranking (combined across all slices). */
  overall?: LeaderboardRow[];
}
