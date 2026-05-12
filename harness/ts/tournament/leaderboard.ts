// Leaderboard aggregation: per-agent rows from a flat list of cell summaries.
//
// Schema is fixed by US-010 AC #4:
//   {success_pct, mean_steps, mean_cost_usd, p50_latency_ms,
//    p95_latency_ms, recovery_count, decline_count}
//
// Sorting: rows are sorted by success_pct desc, then mean_cost_usd asc, then
// p95_latency_ms asc — this matches the champion tiebreaker rule from US-023.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BracketResult, CellSummary, LeaderboardFile, LeaderboardRow } from "./types.js";

export function aggregate(summaries: CellSummary[]): LeaderboardRow[] {
  const byAgent = new Map<string, CellSummary[]>();
  // US-028: SKIPPED_AUTH cells are bookkeeping entries (task required env
  // vars that were unset). They count as neither pass nor fail and must
  // not skew any leaderboard metric, so they're dropped at the aggregation
  // boundary. Their summary.json still lives on disk for resumability.
  for (const s of summaries) {
    if (s.terminal_state === "SKIPPED_AUTH") continue;
    const list = byAgent.get(s.agent_id) ?? [];
    list.push(s);
    byAgent.set(s.agent_id, list);
  }
  const rows: LeaderboardRow[] = [];
  for (const [agent_id, cells] of byAgent) {
    const total = cells.length;
    const passed = cells.filter((c) => c.pass).length;
    const success_pct = total > 0 ? passed / total : 0;
    const mean_steps = mean(cells.map((c) => c.steps));
    const mean_cost_usd = mean(cells.map((c) => c.cost_usd));
    const lats = cells.map((c) => c.latency_ms).sort((a, b) => a - b);
    const p50_latency_ms = percentile(lats, 0.5);
    const p95_latency_ms = percentile(lats, 0.95);
    const recovery_count = cells.filter((c) => c.pass && c.attempts > 1).length;
    const decline_count = cells.filter((c) => c.terminal_state === "DECLINED").length;
    rows.push({
      agent_id,
      total,
      passed,
      success_pct,
      mean_steps,
      mean_cost_usd,
      p50_latency_ms,
      p95_latency_ms,
      recovery_count,
      decline_count,
    });
  }
  rows.sort((a, b) => {
    if (b.success_pct !== a.success_pct) return b.success_pct - a.success_pct;
    if (a.mean_cost_usd !== b.mean_cost_usd) return a.mean_cost_usd - b.mean_cost_usd;
    if (a.p95_latency_ms !== b.p95_latency_ms) return a.p95_latency_ms - b.p95_latency_ms;
    return a.agent_id.localeCompare(b.agent_id);
  });
  return rows;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Linear-interpolated percentile over a SORTED-asc array. Returns 0 for an
 * empty input. p must be in [0, 1].
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const clamped = Math.min(1, Math.max(0, p));
  const idx = clamped * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] as number;
  const frac = idx - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

export interface BuildLeaderboardOpts {
  /** Map slice -> cell summaries collected for that slice. */
  perSlice: Map<string, CellSummary[]>;
  /** Optional bracket result per slice. Pass null/undefined to omit. */
  bracketBySlice?: Map<string, BracketResult | null>;
}

export function buildLeaderboardFile(opts: BuildLeaderboardOpts): LeaderboardFile {
  const slices: LeaderboardFile["slices"] = {};
  const allSummaries: CellSummary[] = [];
  for (const [slice, summaries] of opts.perSlice) {
    const rows = aggregate(summaries);
    const bracket = opts.bracketBySlice?.get(slice) ?? null;
    slices[slice] = bracket ? { rows, bracket } : { rows };
    allSummaries.push(...summaries);
  }
  return {
    generated_at: new Date().toISOString(),
    slices,
    overall: aggregate(allSummaries),
  };
}

export async function writeLeaderboard(path: string, file: LeaderboardFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + "\n");
}

export function formatLeaderboard(file: LeaderboardFile): string {
  const lines: string[] = [];
  lines.push(`[tournament] generated_at=${file.generated_at}`);
  for (const [slice, body] of Object.entries(file.slices)) {
    lines.push(`  slice=${slice}`);
    for (const r of body.rows) {
      const success = (r.success_pct * 100).toFixed(1).padStart(5);
      const cost = r.mean_cost_usd.toFixed(4).padStart(7);
      const p50 = r.p50_latency_ms.toFixed(0).padStart(5);
      const p95 = r.p95_latency_ms.toFixed(0).padStart(5);
      lines.push(
        `    ${r.agent_id.padEnd(28)} ` +
          `pass=${r.passed}/${r.total} (${success}%) ` +
          `steps=${r.mean_steps.toFixed(1)} cost=$${cost} ` +
          `p50=${p50}ms p95=${p95}ms ` +
          `recovery=${r.recovery_count} decline=${r.decline_count}`,
      );
    }
    if (body.bracket) {
      lines.push(`    bracket winner=${body.bracket.winner}`);
      for (const round of body.bracket.rounds) {
        lines.push(`      round ${round.round}:`);
        for (const m of round.matches) {
          const opp = m.b ?? "(bye)";
          lines.push(`        ${m.a} vs ${opp} -> ${m.winner} (${m.reason})`);
        }
      }
    }
  }
  return lines.join("\n");
}
