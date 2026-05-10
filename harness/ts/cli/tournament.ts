// `make tournament` entry point (US-010).
//
// Auto-discovers every agent under agents/, runs each (agent, task, seed)
// cell on the requested slice(s), enforces per-task budgets by difficulty,
// resumes any cell whose summary.json already exists, and writes
// runs/leaderboard.json. Pass --bracket=on to compute a single-elimination
// bracket per slice.

import { resolve } from "node:path";

import { runTournament, formatLeaderboard } from "../tournament/index.js";

interface CliArgs {
  slices: string[];
  seeds: number;
  runsRoot: string;
  bracket: boolean;
  agentFilter: string[] | undefined;
  taskFilter: string[] | undefined;
  retries: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    slices: ["easy"],
    seeds: 1,
    runsRoot: resolve(process.cwd(), "runs"),
    bracket: false,
    agentFilter: undefined,
    taskFilter: undefined,
    retries: undefined,
  };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === undefined || value === undefined) continue;
    if (key === "slice" || key === "slices") {
      out.slices = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "seeds") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) out.seeds = n;
    } else if (key === "runs-root") {
      out.runsRoot = resolve(value);
    } else if (key === "bracket") {
      out.bracket = value === "on" || value === "true" || value === "1";
    } else if (key === "agents" || key === "agent") {
      out.agentFilter = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "tasks" || key === "task") {
      out.taskFilter = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "retries") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) out.retries = n;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runTournament({
    slices: args.slices,
    seeds: args.seeds,
    runsRoot: args.runsRoot,
    bracket: args.bracket,
    ...(args.agentFilter ? { agentFilter: args.agentFilter } : {}),
    ...(args.taskFilter ? { taskFilter: args.taskFilter } : {}),
    ...(args.retries !== undefined ? { retries: args.retries } : {}),
  });
  process.stdout.write(formatLeaderboard(result.leaderboard) + "\n");
  if (result.leaderboardPath) {
    process.stdout.write(`[tournament] wrote ${result.leaderboardPath}\n`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[tournament] error: ${msg}\n`);
  process.exit(1);
});
