// US-012: enforce manifest.distinct_from claims via approach_keywords overlap.
//
// An agent declaring distinct_from=['agent-x'] is asserting that its core
// mechanism is qualitatively different from agent-x's. We validate that
// claim by computing the Jaccard overlap of the two approach_keywords
// lists; if it exceeds the threshold (default 0.5, matching the PRD's
// ">50% overlap" rule) the claim is treated as false and the violator is
// flagged.
//
// Discovery (discoverAgents) drops violators with a warning by default, so
// a tournament never silently runs an agent whose distinctness claim is
// untrue. validateDistinctness is also exported for direct use in tests
// and any future tooling that wants to lint manifests without going
// through discovery.
//
// Notes:
// - Comparison is case-insensitive (keywords are conceptual labels, not
//   identifiers; "ReAct" and "react" are treated as the same).
// - distinct_from references to agent ids that are not in the current
//   discovery set are skipped silently — those agents may simply not be
//   loaded in the current tournament.
// - Self-references (distinct_from=[<own id>]) are skipped silently.
// - When either keyword list is empty, the Jaccard overlap is defined as
//   0 (no shared mechanism can be inferred) so the claim passes.

import type { DiscoveredAgent } from "./types.js";

export const DISTINCTNESS_THRESHOLD = 0.5;

/**
 * Jaccard overlap between two keyword lists, case-insensitive.
 * Returns a value in [0, 1]; empty inputs return 0.
 */
export function jaccardOverlap(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a.map((s) => s.toLowerCase()));
  const B = new Set(b.map((s) => s.toLowerCase()));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface DistinctnessIssue {
  /** The agent whose distinct_from claim was violated. */
  agent_id: string;
  /** The agent it claimed distinctness from. */
  conflicts_with: string;
  /** Computed Jaccard overlap of the two approach_keywords lists. */
  overlap: number;
  /** Threshold the overlap exceeded. */
  threshold: number;
  /** Keywords that appear in both lists (preserves the violator's casing). */
  shared_keywords: string[];
}

export interface ValidateDistinctnessOpts {
  /** Override the default 0.5 threshold. */
  threshold?: number;
}

/**
 * Walk every (agent, target) pair where the agent's manifest declares
 * distinct_from including target, and compute Jaccard overlap. Returns
 * one DistinctnessIssue per violation; an agent that violates against
 * multiple targets contributes multiple issues.
 */
export function validateDistinctness(
  agents: readonly DiscoveredAgent[],
  opts: ValidateDistinctnessOpts = {},
): DistinctnessIssue[] {
  const threshold = opts.threshold ?? DISTINCTNESS_THRESHOLD;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const issues: DistinctnessIssue[] = [];
  for (const a of agents) {
    for (const target of a.manifest.distinct_from) {
      if (target === a.id) continue;
      const t = byId.get(target);
      if (!t) continue;
      const overlap = jaccardOverlap(a.manifest.approach_keywords, t.manifest.approach_keywords);
      if (overlap > threshold) {
        const lc = new Set(t.manifest.approach_keywords.map((s) => s.toLowerCase()));
        const shared = a.manifest.approach_keywords.filter((k) => lc.has(k.toLowerCase()));
        issues.push({
          agent_id: a.id,
          conflicts_with: target,
          overlap,
          threshold,
          shared_keywords: shared,
        });
      }
    }
  }
  return issues;
}

/**
 * Format a DistinctnessIssue as the warning string discovery prints when it
 * drops a violator. Stable across calls so tests can match it.
 */
export function formatDistinctnessWarning(issue: DistinctnessIssue): string {
  const pct = (issue.overlap * 100).toFixed(0);
  const shared = issue.shared_keywords.join(",") || "(none — both lists empty?)";
  return (
    `distinctness violation: agents/${issue.agent_id} claims distinct_from=` +
    `[${issue.conflicts_with}] but their approach_keywords overlap ${pct}% ` +
    `(>${(issue.threshold * 100).toFixed(0)}%): shared=${shared}`
  );
}
