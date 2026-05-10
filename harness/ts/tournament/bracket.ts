// Single-elimination bracket. Pairs leaderboard rows top-vs-bottom (snake
// seeding) and progresses winners through rounds. Tiebreak rules match the
// leaderboard sort: success_pct desc, mean_cost_usd asc, p95_latency_ms asc.

import type { BracketMatch, BracketResult, BracketRound, LeaderboardRow } from "./types.js";

export interface BracketOptions {
  /**
   * Seeding strategy. "leaderboard" preserves the input order (already sorted
   * by aggregate()). "alphabetical" re-sorts by id to make brackets stable
   * across reruns even if metrics shift; useful for tests.
   */
  seeding?: "leaderboard" | "alphabetical";
}

/**
 * Returns null when fewer than 2 agents are present (no bracket to build).
 * Otherwise produces a deterministic single-elimination bracket: rounds[0]
 * pairs the top seed with the bottom, second with second-from-bottom, etc.
 * (snake seeding). An odd count gives the top seed a bye.
 */
export function buildBracket(
  rows: LeaderboardRow[],
  opts: BracketOptions = {},
): BracketResult | null {
  if (rows.length < 2) return null;
  const seeding = opts.seeding ?? "leaderboard";
  let seeds = rows.slice();
  if (seeding === "alphabetical") {
    seeds = seeds.slice().sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  }

  const rowById = new Map<string, LeaderboardRow>();
  for (const r of seeds) rowById.set(r.agent_id, r);

  const rounds: BracketRound[] = [];
  let active = seeds.map((r) => r.agent_id);
  let roundNo = 1;
  while (active.length > 1) {
    const matches: BracketMatch[] = [];
    const next: string[] = [];
    const half = Math.floor(active.length / 2);
    for (let i = 0; i < half; i++) {
      const a = active[i] as string;
      const b = active[active.length - 1 - i] as string;
      if (a === b) {
        // Should not happen given snake pairing on unique ids.
        matches.push({ a, b: null, winner: a, reason: "bye (self-pair guard)" });
        next.push(a);
        continue;
      }
      const ar = rowById.get(a);
      const br = rowById.get(b);
      if (!ar || !br) throw new Error(`bracket: row missing for ${a} or ${b}`);
      const winner = pickWinner(ar, br);
      matches.push({
        a,
        b,
        winner: winner.agent_id,
        reason: explainWinner(ar, br, winner),
      });
      next.push(winner.agent_id);
    }
    if (active.length % 2 === 1) {
      // Top seed (middle of the list when paired snake-style) gets a bye.
      const byeId = active[half] as string;
      matches.push({ a: byeId, b: null, winner: byeId, reason: "bye" });
      next.push(byeId);
    }
    rounds.push({ round: roundNo, matches });
    active = next;
    roundNo++;
  }
  return { rounds, winner: active[0] as string };
}

function pickWinner(a: LeaderboardRow, b: LeaderboardRow): LeaderboardRow {
  if (a.success_pct !== b.success_pct) return a.success_pct > b.success_pct ? a : b;
  if (a.mean_cost_usd !== b.mean_cost_usd) return a.mean_cost_usd < b.mean_cost_usd ? a : b;
  if (a.p95_latency_ms !== b.p95_latency_ms) return a.p95_latency_ms < b.p95_latency_ms ? a : b;
  // Last-resort deterministic tiebreak.
  return a.agent_id.localeCompare(b.agent_id) <= 0 ? a : b;
}

function explainWinner(a: LeaderboardRow, b: LeaderboardRow, w: LeaderboardRow): string {
  if (a.success_pct !== b.success_pct) {
    return `success_pct ${(w.success_pct * 100).toFixed(1)}% > ${((w === a ? b : a).success_pct * 100).toFixed(1)}%`;
  }
  if (a.mean_cost_usd !== b.mean_cost_usd) {
    return `cost $${w.mean_cost_usd.toFixed(4)} < $${(w === a ? b : a).mean_cost_usd.toFixed(4)}`;
  }
  if (a.p95_latency_ms !== b.p95_latency_ms) {
    return `p95 ${w.p95_latency_ms.toFixed(0)}ms < ${(w === a ? b : a).p95_latency_ms.toFixed(0)}ms`;
  }
  return `id-tiebreak`;
}
