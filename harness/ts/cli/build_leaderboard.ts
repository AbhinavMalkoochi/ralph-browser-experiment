// US-023: rebuild runs/leaderboard.json from already-written summary.json
// sidecars, without running any cells. Designed for the post-hoc aggregation
// case where prior tournament invocations dropped trajectories+summaries to
// disk and the leaderboard just needs to be re-aggregated.
//
// `make tournament` is the source of truth for fresh runs; this CLI is the
// "I already have the data, just regenerate the file" variant.

import { resolve } from "node:path";

import { loadAllSummaries } from "../report/loadSummaries.js";
import { buildLeaderboardFile, formatLeaderboard, writeLeaderboard } from "../tournament/leaderboard.js";
import { LEADERBOARD_FILENAME } from "../tournament/runner.js";
import type { CellSummary } from "../tournament/types.js";

interface CliArgs {
  runsRoot: string;
  slices: string[] | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    runsRoot: resolve(process.cwd(), "runs"),
    slices: undefined,
  };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === undefined || value === undefined) continue;
    if (key === "runs-root") out.runsRoot = resolve(value);
    else if (key === "slices" || key === "slice") {
      out.slices = value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summaries = await loadAllSummaries(args.runsRoot);
  const perSlice = new Map<string, CellSummary[]>();
  for (const s of summaries) {
    if (args.slices && !args.slices.includes(s.difficulty)) continue;
    const list = perSlice.get(s.difficulty) ?? [];
    list.push(s);
    perSlice.set(s.difficulty, list);
  }
  if (perSlice.size === 0) {
    process.stderr.write(`[build-leaderboard] no summaries under ${args.runsRoot}\n`);
    process.exit(1);
    return;
  }
  const file = buildLeaderboardFile({ perSlice });
  const outPath = resolve(args.runsRoot, LEADERBOARD_FILENAME);
  await writeLeaderboard(outPath, file);
  process.stdout.write(formatLeaderboard(file) + "\n");
  process.stdout.write(`[build-leaderboard] wrote ${outPath}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[build-leaderboard] error: ${msg}\n`);
  process.exit(1);
});
