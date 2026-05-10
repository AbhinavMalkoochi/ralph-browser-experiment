// Render a markdown leaderboard report from a LeaderboardFile + CellSummary[]
// + task lookup. Pure function so tests can snapshot the exact output without
// touching the filesystem.
//
// Layout:
//   1. Header (generated_at, links to source files)
//   2. Per-slice ranked tables (success, cost, latency, recovery, decline)
//      + bracket section if present
//   3. Overall ranking
//   4. Pareto front (success_pct vs mean_cost_usd) — textual + ASCII
//   5. Best trajectory per agent (with link to the trajectory artefact)
//   6. Failure clusters: by error class, by tag, top failing tasks

import type {
  BracketResult,
  CellSummary,
  LeaderboardFile,
  LeaderboardRow,
} from "../tournament/types.js";
import type { Task } from "../verifier/types.js";
import type {
  BestTrajectory,
  FailureClusters,
  RenderOptions,
  ReportInputs,
} from "./types.js";

const DEFAULT_LINK_PREFIX = "../";

export function renderReport(input: ReportInputs, opts: RenderOptions = {}): string {
  const linkPrefix = opts.linkPrefix ?? DEFAULT_LINK_PREFIX;
  const lines: string[] = [];

  lines.push(`# General Browser Agent Tournament Leaderboard`);
  lines.push("");
  lines.push(
    `_Generated ${input.leaderboard.generated_at} from \`runs/leaderboard.json\` (${input.summaries.length} cells across ${countAgents(input.summaries)} agents)._`,
  );
  lines.push("");
  lines.push(
    `> Run \`make report\` to regenerate. Source data: \`runs/leaderboard.json\` and \`runs/<agent>/<task>/<seed>/summary.json\`.`,
  );
  lines.push("");

  // Per-slice tables.
  const sliceNames = orderedSliceNames(Object.keys(input.leaderboard.slices));
  for (const slice of sliceNames) {
    const body = input.leaderboard.slices[slice];
    if (!body) continue;
    lines.push(`## Slice: \`${slice}\``);
    lines.push("");
    if (body.rows.length === 0) {
      lines.push(`_No agents reported on this slice._`);
      lines.push("");
      continue;
    }
    lines.push(...renderRowsTable(body.rows, linkPrefix));
    lines.push("");
    if (body.bracket) {
      lines.push(...renderBracket(body.bracket));
      lines.push("");
    }
  }

  // Overall ranking.
  if (input.leaderboard.overall && input.leaderboard.overall.length > 0) {
    lines.push(`## Overall ranking`);
    lines.push("");
    lines.push(
      `_Combines every cell across all slices. Use the per-slice tables above for slice-specific judgment._`,
    );
    lines.push("");
    lines.push(...renderRowsTable(input.leaderboard.overall, linkPrefix));
    lines.push("");
  }

  // Pareto front.
  lines.push(...renderPareto(input.leaderboard.overall ?? collectOverall(input.leaderboard)));
  lines.push("");

  // Best trajectory per agent.
  lines.push(`## Best trajectory per agent`);
  lines.push("");
  const bestRows = bestTrajectoryPerAgent(input.summaries);
  if (bestRows.length === 0) {
    lines.push(`_No trajectories recorded yet._`);
  } else {
    lines.push(...renderBestTrajectoryTable(bestRows, linkPrefix));
  }
  lines.push("");

  // Failure clusters.
  const clusters = computeFailureClusters(input.summaries, input.tasksById);
  lines.push(...renderFailureClusters(clusters, linkPrefix));
  lines.push("");

  return lines.join("\n");
}

// --- per-slice / overall tables -------------------------------------------------

function renderRowsTable(rows: LeaderboardRow[], linkPrefix: string): string[] {
  const lines: string[] = [];
  lines.push(
    `| rank | agent | pass | success | mean steps | mean cost | p50 ms | p95 ms | recovery | decline |`,
  );
  lines.push(`|---:|---|---|---:|---:|---:|---:|---:|---:|---:|`);
  rows.forEach((r, i) => {
    const link = `[${escapeMd(r.agent_id)}](${linkPrefix}agents/${encodeURIComponent(r.agent_id)}/README.md)`;
    lines.push(
      `| ${i + 1} | ${link} | ${r.passed}/${r.total} | ` +
        `${formatPct(r.success_pct)} | ${formatNumber(r.mean_steps, 1)} | ` +
        `${formatCost(r.mean_cost_usd)} | ${formatMs(r.p50_latency_ms)} | ${formatMs(r.p95_latency_ms)} | ` +
        `${r.recovery_count} | ${r.decline_count} |`,
    );
  });
  return lines;
}

function renderBracket(bracket: BracketResult): string[] {
  const lines: string[] = [];
  lines.push(`### Bracket`);
  lines.push("");
  lines.push(`Winner: **${escapeMd(bracket.winner)}**`);
  lines.push("");
  for (const round of bracket.rounds) {
    lines.push(`- Round ${round.round}:`);
    for (const m of round.matches) {
      const opp = m.b ?? "(bye)";
      lines.push(
        `  - ${escapeMd(m.a)} vs ${escapeMd(opp)} → **${escapeMd(m.winner)}** (${escapeMd(m.reason)})`,
      );
    }
  }
  return lines;
}

// --- Pareto front ----------------------------------------------------------------

export function paretoFront(rows: LeaderboardRow[]): LeaderboardRow[] {
  if (rows.length === 0) return [];
  // A row is on the front if no other row dominates it
  // (higher success AND lower-or-equal cost, or higher-or-equal success AND lower cost).
  const front: LeaderboardRow[] = [];
  for (const r of rows) {
    const dominated = rows.some(
      (other) =>
        other !== r &&
        other.success_pct >= r.success_pct &&
        other.mean_cost_usd <= r.mean_cost_usd &&
        (other.success_pct > r.success_pct || other.mean_cost_usd < r.mean_cost_usd),
    );
    if (!dominated) front.push(r);
  }
  // Sort the front by cost asc so it reads left-to-right on a chart.
  front.sort(
    (a, b) =>
      a.mean_cost_usd - b.mean_cost_usd ||
      b.success_pct - a.success_pct ||
      a.agent_id.localeCompare(b.agent_id),
  );
  return front;
}

function renderPareto(rows: LeaderboardRow[]): string[] {
  const lines: string[] = [];
  lines.push(`## Pareto front (success vs mean cost)`);
  lines.push("");
  if (rows.length === 0) {
    lines.push(`_No rows to plot._`);
    return lines;
  }
  const front = paretoFront(rows);
  lines.push(
    `Each point is one agent's overall (success_pct, mean_cost_usd). An agent is on the Pareto front if no other agent matches its success at lower cost.`,
  );
  lines.push("");
  lines.push("```text");
  lines.push(...renderAsciiScatter(rows, front));
  lines.push("```");
  lines.push("");
  lines.push(`**Pareto-optimal agents:**`);
  if (front.length === 0) {
    lines.push("");
    lines.push(`_(none — all agents are dominated)_`);
  } else {
    for (const r of front) {
      lines.push(
        `- ${escapeMd(r.agent_id)} — ${formatPct(r.success_pct)} success at ${formatCost(r.mean_cost_usd)}/cell (${r.passed}/${r.total} passed)`,
      );
    }
  }
  return lines;
}

function renderAsciiScatter(rows: LeaderboardRow[], front: LeaderboardRow[]): string[] {
  const width = 40;
  const height = 10;
  const costs = rows.map((r) => r.mean_cost_usd);
  const maxCost = Math.max(0.0001, ...costs);
  const grid: string[][] = [];
  for (let y = 0; y < height; y++) {
    grid.push(new Array<string>(width).fill(" "));
  }
  const frontIds = new Set(front.map((r) => r.agent_id));
  for (const r of rows) {
    const xRatio = maxCost === 0 ? 0 : r.mean_cost_usd / maxCost;
    const x = Math.min(width - 1, Math.max(0, Math.round(xRatio * (width - 1))));
    const y = Math.min(
      height - 1,
      Math.max(0, Math.round((1 - r.success_pct) * (height - 1))),
    );
    const row = grid[y];
    if (!row) continue;
    const marker = frontIds.has(r.agent_id) ? "*" : "o";
    const existing = row[x];
    if (existing === " ") row[x] = marker;
    else if (existing === "o" && marker === "*") row[x] = marker;
    else row[x] = "+";
  }
  const lines: string[] = [];
  lines.push(`success ^`);
  for (let y = 0; y < height; y++) {
    const labelPct = Math.round(100 * (1 - y / (height - 1)));
    const label = `${labelPct}%`.padStart(4);
    const row = grid[y] ?? new Array<string>(width).fill(" ");
    lines.push(`${label} | ${row.join("")}`);
  }
  lines.push(`     +-${"-".repeat(width)}> mean_cost_usd`);
  lines.push(`        $0.00${" ".repeat(Math.max(0, width - 12))}$${maxCost.toFixed(2)}`);
  lines.push(`legend: * = pareto-optimal, o = dominated, + = overlap`);
  return lines;
}

// --- best trajectory per agent --------------------------------------------------

export function bestTrajectoryPerAgent(summaries: CellSummary[]): BestTrajectory[] {
  const byAgent = new Map<string, CellSummary[]>();
  for (const s of summaries) {
    const list = byAgent.get(s.agent_id) ?? [];
    list.push(s);
    byAgent.set(s.agent_id, list);
  }
  const out: BestTrajectory[] = [];
  for (const [agent, cells] of byAgent) {
    if (cells.length === 0) continue;
    const sorted = cells.slice().sort(rankBest);
    const best = sorted[0]!;
    out.push({
      agent_id: agent,
      task_id: best.task_id,
      seed: best.seed,
      pass: best.pass,
      score: best.score,
      cost_usd: best.cost_usd,
      latency_ms: best.latency_ms,
    });
  }
  out.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  return out;
}

function rankBest(a: CellSummary, b: CellSummary): number {
  // pass=true first; then highest score; then lowest cost; then lowest latency;
  // then deterministic by task_id/seed.
  if (a.pass !== b.pass) return a.pass ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.cost_usd !== b.cost_usd) return a.cost_usd - b.cost_usd;
  if (a.latency_ms !== b.latency_ms) return a.latency_ms - b.latency_ms;
  if (a.task_id !== b.task_id) return a.task_id.localeCompare(b.task_id);
  return a.seed - b.seed;
}

function renderBestTrajectoryTable(rows: BestTrajectory[], linkPrefix: string): string[] {
  const lines: string[] = [];
  lines.push(`| agent | task | seed | pass | score | cost | trajectory |`);
  lines.push(`|---|---|---:|:---:|---:|---:|---|`);
  for (const r of rows) {
    const trajPath = `${linkPrefix}runs/${encodeURIComponent(r.agent_id)}/${encodeURIComponent(r.task_id)}/${r.seed}/trajectory.jsonl.gz`;
    lines.push(
      `| ${escapeMd(r.agent_id)} | ${escapeMd(r.task_id)} | ${r.seed} | ` +
        `${r.pass ? "✓" : "✗"} | ${formatNumber(r.score, 2)} | ${formatCost(r.cost_usd)} | ` +
        `[trajectory.jsonl.gz](${trajPath}) |`,
    );
  }
  return lines;
}

// --- failure clusters -----------------------------------------------------------

export function computeFailureClusters(
  summaries: CellSummary[],
  tasksById: Map<string, Task>,
): FailureClusters {
  const failed = summaries.filter((s) => !s.pass);
  const byErrorClass = new Map<string, number>();
  const byTag = new Map<string, number>();
  const byTask = new Map<string, { failures: number; tags: string[]; difficulty: string | null }>();
  for (const f of failed) {
    const cls = f.terminal_state ?? "UNKNOWN";
    byErrorClass.set(cls, (byErrorClass.get(cls) ?? 0) + 1);
    const task = tasksById.get(f.task_id);
    const tags = task?.tags ?? [];
    for (const tag of tags) {
      byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
    }
    const taskAgg = byTask.get(f.task_id) ?? {
      failures: 0,
      tags,
      difficulty: task?.difficulty ?? f.difficulty ?? null,
    };
    taskAgg.failures += 1;
    byTask.set(f.task_id, taskAgg);
  }
  return { failed, byErrorClass, byTag, byTask };
}

function renderFailureClusters(clusters: FailureClusters, linkPrefix: string): string[] {
  const lines: string[] = [];
  lines.push(`## Failure clusters`);
  lines.push("");
  if (clusters.failed.length === 0) {
    lines.push(`_No failures recorded — every cell passed._`);
    return lines;
  }
  lines.push(
    `_${clusters.failed.length} failed cells across the latest run. Failures are grouped by ` +
      `terminal_state (error class) and by task tag. A cell with N tags contributes once to each tag bucket._`,
  );
  lines.push("");

  lines.push(`### By error class`);
  lines.push("");
  lines.push(`| terminal_state | failures |`);
  lines.push(`|---|---:|`);
  const classRows = sortedDescByCount(clusters.byErrorClass);
  for (const [cls, n] of classRows) {
    lines.push(`| \`${escapeCode(cls)}\` | ${n} |`);
  }
  lines.push("");

  lines.push(`### By task tag`);
  lines.push("");
  if (clusters.byTag.size === 0) {
    lines.push(`_No tags available; task specs may not be on disk._`);
  } else {
    lines.push(`| tag | failures |`);
    lines.push(`|---|---:|`);
    for (const [tag, n] of sortedDescByCount(clusters.byTag)) {
      lines.push(`| \`${escapeCode(tag)}\` | ${n} |`);
    }
  }
  lines.push("");

  lines.push(`### Top failing tasks`);
  lines.push("");
  lines.push(`| task | difficulty | failures | tags |`);
  lines.push(`|---|---|---:|---|`);
  const taskRows = Array.from(clusters.byTask.entries())
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.failures - a.failures || a.id.localeCompare(b.id))
    .slice(0, 20);
  for (const r of taskRows) {
    const tagText = r.tags.length === 0 ? "_(unknown)_" : r.tags.map((t) => `\`${escapeCode(t)}\``).join(" ");
    lines.push(
      `| ${escapeMd(r.id)} | ${r.difficulty ?? ""} | ${r.failures} | ${tagText} |`,
    );
  }

  // Linkable list of trajectory artefacts for the failed cells (top 10 by
  // most-recent), so a stakeholder can drill in without grepping runs/.
  const recent = clusters.failed
    .slice()
    .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
    .slice(0, 10);
  if (recent.length > 0) {
    lines.push("");
    lines.push(`### Recent failure trajectories`);
    lines.push("");
    for (const f of recent) {
      const trajPath = `${linkPrefix}runs/${encodeURIComponent(f.agent_id)}/${encodeURIComponent(f.task_id)}/${f.seed}/trajectory.jsonl.gz`;
      const reason = f.decline_reason || f.reason || "(no reason)";
      lines.push(
        `- ${escapeMd(f.agent_id)} / ${escapeMd(f.task_id)} / seed=${f.seed} — \`${escapeCode(f.terminal_state ?? "UNKNOWN")}\`: ${escapeMd(truncate(reason, 140))} ([trajectory](${trajPath}))`,
      );
    }
  }
  return lines;
}

// --- helpers -------------------------------------------------------------------

const SLICE_ORDER = ["easy", "medium", "hard"];

function orderedSliceNames(names: string[]): string[] {
  const known = SLICE_ORDER.filter((s) => names.includes(s));
  const extras = names.filter((s) => !SLICE_ORDER.includes(s)).sort();
  return [...known, ...extras];
}

function countAgents(summaries: CellSummary[]): number {
  return new Set(summaries.map((s) => s.agent_id)).size;
}

function collectOverall(file: LeaderboardFile): LeaderboardRow[] {
  // Fallback if leaderboard.overall is somehow missing — concat per-slice rows
  // and return them in their declared order. The Pareto chart still works.
  const out: LeaderboardRow[] = [];
  for (const body of Object.values(file.slices)) out.push(...body.rows);
  return out;
}

function sortedDescByCount(map: Map<string, number>): [string, number][] {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function formatCost(c: number): string {
  return `$${c.toFixed(4)}`;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}`;
}

function formatNumber(n: number, frac: number): string {
  return n.toFixed(frac);
}

/**
 * Escape only the characters that actually break markdown table cells: pipe,
 * backslash, and backtick. Underscores / hyphens / asterisks are common in
 * agent ids and task ids and render fine without escaping.
 */
function escapeMd(s: string): string {
  return s.replace(/([|\\`])/g, "\\$1");
}

/** Inside a backtick code span only the backtick itself needs handling. */
function escapeCode(s: string): string {
  return s.replace(/`/g, "\\`");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
