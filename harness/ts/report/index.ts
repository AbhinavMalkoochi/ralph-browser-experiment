// Public surface of the report module (US-011).
//
// `make report` calls `generateReport({runsRoot, repoRoot, outPath})` from
// the CLI; tests import the smaller pieces (renderReport, paretoFront,
// computeFailureClusters, bestTrajectoryPerAgent) directly.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { LEADERBOARD_FILENAME } from "../tournament/runner.js";
import type { CellSummary, LeaderboardFile } from "../tournament/types.js";
import { loadTaskFile } from "../verifier/loader.js";
import { type Task } from "../verifier/types.js";
import { readdir } from "node:fs/promises";

import { loadAllSummaries } from "./loadSummaries.js";
import { renderReport } from "./render.js";

export {
  bestTrajectoryPerAgent,
  computeFailureClusters,
  paretoFront,
  renderReport,
} from "./render.js";
export { loadAllSummaries } from "./loadSummaries.js";
export type {
  BestTrajectory,
  FailureClusters,
  RenderOptions,
  ReportInputs,
} from "./types.js";

export interface GenerateReportOptions {
  /** Directory holding leaderboard.json + per-cell summaries. */
  runsRoot: string;
  /** Repo root (used to resolve tasks/suite/<slice>/). Defaults to cwd. */
  repoRoot?: string;
  /** Markdown output path. Defaults to `<repoRoot>/docs/leaderboard.md`. */
  outPath?: string;
  /** Override the prefix used in markdown links. Defaults to `../`. */
  linkPrefix?: string;
}

export interface GenerateReportResult {
  /** Where the markdown landed. */
  outPath: string;
  /** Where the leaderboard was read from. */
  leaderboardPath: string;
  /** Number of summaries the report loaded. */
  summaryCount: number;
  /** Number of distinct task ids the report linked to. */
  taskCount: number;
  /** Generated markdown body (also written to outPath). */
  markdown: string;
}

export async function generateReport(opts: GenerateReportOptions): Promise<GenerateReportResult> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const leaderboardPath = join(opts.runsRoot, LEADERBOARD_FILENAME);
  const outPath = opts.outPath ?? join(repoRoot, "docs", "leaderboard.md");

  const leaderboardRaw = await readFile(leaderboardPath, "utf8");
  const leaderboard = JSON.parse(leaderboardRaw) as LeaderboardFile;

  const allSummaries = await loadAllSummaries(opts.runsRoot);
  // Scope the report to slices the leaderboard.json knows about. A user who
  // runs `tournament --slice=hard` should not see stale easy-slice cells from
  // prior tournament invocations bleed into the failure clusters or the
  // best-trajectory section.
  const slicesInLeaderboard = new Set(Object.keys(leaderboard.slices));
  const summaries =
    slicesInLeaderboard.size === 0
      ? allSummaries
      : allSummaries.filter((s) => slicesInLeaderboard.has(s.difficulty));
  const tasksById = await loadTasksForLeaderboard(leaderboard, summaries, repoRoot);

  const renderOpts = opts.linkPrefix !== undefined ? { linkPrefix: opts.linkPrefix } : {};
  const markdown = renderReport({ leaderboard, summaries, tasksById }, renderOpts);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, markdown);

  return {
    outPath: resolve(outPath),
    leaderboardPath: resolve(leaderboardPath),
    summaryCount: summaries.length,
    taskCount: tasksById.size,
    markdown,
  };
}

async function loadTasksForLeaderboard(
  leaderboard: LeaderboardFile,
  summaries: CellSummary[],
  repoRoot: string,
): Promise<Map<string, Task>> {
  const slices = new Set<string>();
  for (const slice of Object.keys(leaderboard.slices)) slices.add(slice);
  for (const s of summaries) if (s.difficulty) slices.add(s.difficulty);
  const out = new Map<string, Task>();
  for (const slice of slices) {
    const dir = join(repoRoot, "tasks", "suite", slice);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const yamls = entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    for (const f of yamls) {
      try {
        const task = await loadTaskFile(join(dir, f));
        out.set(task.id, task);
      } catch {
        // Skip malformed tasks rather than aborting the whole report.
      }
    }
  }
  return out;
}
