// Markdown report generator types (US-011).
//
// The report module reads `runs/leaderboard.json` (US-010 output) plus the
// per-cell `summary.json` sidecars under `runs/<agent>/<task>/<seed>/` and
// renders a single human-friendly markdown file at `docs/leaderboard.md`.
//
// Per-cell summaries carry the failure metadata (terminal_state,
// decline_reason) the leaderboard rows do NOT, so the failure-cluster section
// loads them directly rather than re-deriving from aggregate metrics.

import type { CellSummary, LeaderboardFile } from "../tournament/types.js";
import type { Task } from "../verifier/types.js";

export interface ReportInputs {
  /** Parsed runs/leaderboard.json. */
  leaderboard: LeaderboardFile;
  /** Every per-cell summary discovered under runs/. */
  summaries: CellSummary[];
  /**
   * Task lookup by id; used to attach tags to failure clusters. Tasks not in
   * the map are reported with `tags: []` rather than omitted.
   */
  tasksById: Map<string, Task>;
}

export interface RenderOptions {
  /**
   * Path prefix prepended to repo-relative links (agents/..., runs/...).
   * Defaults to "../" because docs/leaderboard.md sits one level below the
   * repo root.
   */
  linkPrefix?: string;
}

export interface BestTrajectory {
  agent_id: string;
  task_id: string;
  seed: number;
  pass: boolean;
  score: number;
  cost_usd: number;
  latency_ms: number;
}

export interface FailureClusters {
  /** Failed cells (pass=false). */
  failed: CellSummary[];
  /** Count grouped by terminal_state (treats null as "UNKNOWN"). */
  byErrorClass: Map<string, number>;
  /** Count grouped by task tag. A failed cell contributes once per tag. */
  byTag: Map<string, number>;
  /** Per-task failure rollup. */
  byTask: Map<string, { failures: number; tags: string[]; difficulty: string | null }>;
}
