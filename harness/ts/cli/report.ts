// `make report` entry point (US-011).
//
// Reads runs/leaderboard.json (US-010 output) plus the per-cell summary.json
// sidecars under runs/<agent>/<task>/<seed>/, and writes a single markdown
// report to docs/leaderboard.md. Pass --runs-root or --out to override.

import { resolve } from "node:path";

import { generateReport } from "../report/index.js";

interface CliArgs {
  runsRoot: string;
  outPath: string | undefined;
  linkPrefix: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    runsRoot: resolve(process.cwd(), "runs"),
    outPath: undefined,
    linkPrefix: undefined,
  };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === undefined || value === undefined) continue;
    if (key === "runs-root") out.runsRoot = resolve(value);
    else if (key === "out") out.outPath = resolve(value);
    else if (key === "link-prefix") out.linkPrefix = value;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await generateReport({
    runsRoot: args.runsRoot,
    ...(args.outPath !== undefined ? { outPath: args.outPath } : {}),
    ...(args.linkPrefix !== undefined ? { linkPrefix: args.linkPrefix } : {}),
  });
  process.stdout.write(
    `[report] read ${result.leaderboardPath}\n` +
      `[report] loaded ${result.summaryCount} cell summaries across ${result.taskCount} tasks\n` +
      `[report] wrote ${result.outPath}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[report] error: ${msg}\n`);
  process.exit(1);
});
