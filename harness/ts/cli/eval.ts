// `make eval AGENT=<id> SLICE=<slice>` entry point.
//
// Loads every yaml task under tasks/suite/<slice>/, spins up the local
// fixtures server when any task uses a `fixtures://` URL, runs the named
// agent through the slice, verifies each run, prints a summary table and
// exits 0. The full tournament runner with leaderboard JSON / per-cell
// resumability lands in US-010.

import { resolve } from "node:path";

import { runEval, formatSummary } from "../eval/runner.js";

interface CliArgs {
  agent: string;
  slice: string;
  seeds: number;
  runsRoot: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    agent: "trivial",
    slice: "easy",
    seeds: 1,
    runsRoot: resolve(process.cwd(), "runs"),
  };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === undefined || value === undefined) continue;
    if (key === "agent") out.agent = value;
    else if (key === "slice") out.slice = value;
    else if (key === "seeds") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) out.seeds = n;
    } else if (key === "runs-root") out.runsRoot = resolve(value);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runEval(args);
  process.stdout.write(formatSummary(summary) + "\n");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[eval] error: ${msg}\n`);
  process.exit(1);
});
