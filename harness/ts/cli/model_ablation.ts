// Model-diversity ablation runner (US-030).
//
// Re-evaluates two existing agents — `runtime-codegen` and `network-shadow`
// — under three models — `gpt-4o-mini`, `claude-haiku-4-5`,
// `claude-sonnet-4-6` — on the `hard` slice. 2 agents × 3 models × 10 hard
// fixtures = 60 cells.
//
// Both agents read `GBA_MODEL` from the environment (added in US-030), so
// we just set that env var per cell and shell out through the existing
// `runEval` machinery. Runs land at
//   runs/model-ablation/<agent>__<model>/<task>/<seed>/
// and the per-cell summary table is printed at the end.
//
// Usage:
//   npx tsx harness/ts/cli/model_ablation.ts \
//     [--out=docs/model-ablation-<date>.md] [--seeds=1] [--slice=hard]
//
// If `--out` is given, a markdown table is written to that path.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { defaultRetriesForSlice, runEval } from "../eval/runner.js";
import type { EvalResult, EvalSummary } from "../eval/runner.js";

const AGENTS = ["runtime-codegen", "network-shadow"] as const;
const MODELS = ["gpt-4o-mini", "claude-haiku-4-5", "claude-sonnet-4-6"] as const;

interface CellMetrics {
  agent: string;
  model: string;
  passed: number;
  total: number;
  meanCostUsd: number;
  meanLatencyMs: number;
}

interface CliArgs {
  slice: string;
  seeds: number;
  out: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { slice: "hard", seeds: 1, out: undefined };
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "slice" && value) out.slice = value;
    else if (key === "seeds" && value) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) out.seeds = n;
    } else if (key === "out" && value) out.out = resolve(value);
  }
  return out;
}

function meanLatency(results: readonly EvalResult[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((acc, r) => acc + r.durationMs, 0);
  return sum / results.length;
}

function summarizeCell(
  agent: string,
  model: string,
  summary: EvalSummary,
  meanCost: number,
): CellMetrics {
  return {
    agent,
    model,
    passed: summary.passed,
    total: summary.total,
    meanCostUsd: meanCost,
    meanLatencyMs: meanLatency(summary.results),
  };
}

async function readMeanCostUsd(
  runsRoot: string,
  agent: string,
  results: readonly EvalResult[],
): Promise<number> {
  // The eval runner writes per-cell summary.json with `cost_usd_total`.
  // For US-030 we only need an order-of-magnitude tabulation, so we read
  // each cell's summary if present and average. Missing files contribute 0.
  if (results.length === 0) return 0;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let total = 0;
  let n = 0;
  for (const r of results) {
    const p = join(runsRoot, agent, r.task_id, String(r.seed), "summary.json");
    try {
      const raw = await readFile(p, "utf8");
      const j = JSON.parse(raw) as { cost_usd_total?: number };
      if (typeof j.cost_usd_total === "number") {
        total += j.cost_usd_total;
        n += 1;
      }
    } catch {
      // missing summary.json — skip
    }
  }
  return n > 0 ? total / n : 0;
}

function formatMarkdown(cells: readonly CellMetrics[], slice: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Model-diversity ablation — ${date}`);
  lines.push("");
  lines.push(
    `2 agents × 3 models × ${slice} slice. Re-runs of \`runtime-codegen\` and `,
  );
  lines.push(
    `\`network-shadow\` under {gpt-4o-mini, claude-haiku-4-5, claude-sonnet-4-6}. `,
  );
  lines.push(
    "Goal: separate mechanism wins from model wins. The hard slice is the ",
  );
  lines.push(
    "discriminator; the easy slice has long since saturated.",
  );
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| Agent | Model | Pass | Mean cost (USD) | Mean latency (ms) |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const c of cells) {
    const pct = c.total > 0 ? ((c.passed / c.total) * 100).toFixed(1) : "0.0";
    lines.push(
      `| ${c.agent} | ${c.model} | ${c.passed}/${c.total} (${pct}%) | ` +
        `${c.meanCostUsd.toFixed(4)} | ${c.meanLatencyMs.toFixed(0)} |`,
    );
  }
  lines.push("");
  lines.push("## How to re-run");
  lines.push("");
  lines.push("```bash");
  lines.push(
    "OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \\",
  );
  lines.push(
    `  npx tsx harness/ts/cli/model_ablation.ts --slice=${slice} --out=docs/model-ablation-${date}.md`,
  );
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runsRoot = resolve(process.cwd(), "runs", "model-ablation");
  const retries = defaultRetriesForSlice(args.slice);

  const cells: CellMetrics[] = [];
  for (const agent of AGENTS) {
    for (const model of MODELS) {
      const tag = `${agent}__${model}`;
      process.stdout.write(`==> ${tag} (${args.slice})\n`);
      // Per-cell env override. We restore after each run so a partial run
      // doesn't leak into the next invocation in long-lived processes.
      const prior = process.env.GBA_MODEL;
      process.env.GBA_MODEL = model;
      let summary: EvalSummary;
      try {
        summary = await runEval({
          agent,
          slice: args.slice,
          seeds: args.seeds,
          runsRoot,
          retries,
        });
      } finally {
        if (prior === undefined) delete process.env.GBA_MODEL;
        else process.env.GBA_MODEL = prior;
      }
      const meanCost = await readMeanCostUsd(runsRoot, agent, summary.results);
      cells.push(summarizeCell(agent, model, summary, meanCost));
    }
  }

  process.stdout.write("\n=== Model-diversity ablation summary ===\n");
  for (const c of cells) {
    process.stdout.write(
      `${c.agent.padEnd(20)} ${c.model.padEnd(22)} ` +
        `pass=${c.passed}/${c.total} cost=$${c.meanCostUsd.toFixed(4)} ` +
        `lat=${c.meanLatencyMs.toFixed(0)}ms\n`,
    );
  }

  if (args.out) {
    await writeFile(args.out, formatMarkdown(cells, args.slice));
    process.stdout.write(`\nWrote ${args.out}\n`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`model_ablation failed: ${msg}\n`);
  process.exit(1);
});
