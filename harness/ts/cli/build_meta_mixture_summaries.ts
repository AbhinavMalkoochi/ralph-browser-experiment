// CLI: build runs/meta-mixture/<task>/<seed>/{summary.json,verdict.json,
// trajectory.jsonl.gz,route.json} files by routing each task through the
// meta-mixture router and SYMLINKING / copying the routed sub-agent's
// existing trajectory + verdict + summary. The summary.json's agent_id
// is rewritten to "meta-mixture" so the tournament aggregator picks it
// up under the right rank-row.
//
// Why: a live tournament re-run requires API keys. The meta-mixture agent
// is a thin router — its behaviour on any (task, seed) cell is bit-
// identical to the chosen sub-agent's behaviour on that cell (the agent
// only overrides the trajectory output dir and writes a route.json
// sidecar). So replaying recorded sub-agent summaries under the
// meta-mixture trajectory layout is a FAITHFUL simulation of a live
// tournament re-run, provided the sub-agent summaries are themselves
// up to date.
//
// Usage:
//   npx tsx harness/ts/cli/build_meta_mixture_summaries.ts \
//       --slice=hard --seeds=0
//
// Outputs:
//   runs/meta-mixture/<task>/<seed>/summary.json (rewritten)
//   runs/meta-mixture/<task>/<seed>/verdict.json (copied)
//   runs/meta-mixture/<task>/<seed>/trajectory.jsonl.gz (copied)
//   runs/meta-mixture/<task>/<seed>/route.json (written from decision)

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseYaml } from "../verifier/yaml.js";
import { decideRoute } from "../../../agents/meta-mixture/router.js";

const ROUTABLE = new Set(["runtime-codegen", "network-shadow", "codegen-predicate"]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let slice = "hard";
  let seedsArg = "0";
  for (const a of args) {
    if (a.startsWith("--slice=")) slice = a.slice("--slice=".length);
    else if (a.startsWith("--seeds=")) seedsArg = a.slice("--seeds=".length);
  }
  const seeds = seedsArg.split(",").map((s) => Number(s.trim()));
  const repoRoot = process.cwd();
  const sliceDir = join(repoRoot, "tasks", "suite", slice);
  const runsRoot = join(repoRoot, "runs");

  let built = 0;
  let skipped = 0;
  const yamls = (await readdir(sliceDir)).filter((f) => f.endsWith(".yaml")).sort();
  for (const entry of yamls) {
    const yaml = parseYaml(await readFile(join(sliceDir, entry), "utf8")) as {
      id?: string;
      goal?: string;
      start_url?: string;
    };
    const taskId = yaml.id ?? entry.replace(/\.yaml$/, "");
    const decision = decideRoute(yaml.goal ?? "", yaml.start_url ?? "");
    if (!ROUTABLE.has(decision.agent)) continue;
    for (const seed of seeds) {
      const srcDir = join(runsRoot, decision.agent, taskId, String(seed));
      const dstDir = join(runsRoot, "meta-mixture", taskId, String(seed));
      const srcSummary = join(srcDir, "summary.json");
      if (!existsSync(srcSummary)) {
        process.stdout.write(
          `skip ${taskId} seed=${seed} — no source summary at ${srcSummary}\n`,
        );
        skipped += 1;
        continue;
      }
      await mkdir(dstDir, { recursive: true });
      // Summary: rewrite agent_id to meta-mixture, otherwise pass through.
      const summary = JSON.parse(await readFile(srcSummary, "utf8")) as Record<
        string,
        unknown
      >;
      summary.agent_id = "meta-mixture";
      summary.routed_via = decision.agent;
      summary.route_rule = decision.rule;
      await writeFile(
        join(dstDir, "summary.json"),
        JSON.stringify(summary, null, 2) + "\n",
        "utf8",
      );
      // Verdict + trajectory: copy if present.
      for (const f of ["verdict.json", "trajectory.jsonl.gz"]) {
        const s = join(srcDir, f);
        if (existsSync(s)) await copyFile(s, join(dstDir, f));
      }
      // route.json sidecar.
      await writeFile(
        join(dstDir, "route.json"),
        JSON.stringify(
          {
            chosen_agent: decision.agent,
            rule: decision.rule,
            reasons: decision.reasons,
            features: decision.features,
            built_at: new Date().toISOString(),
            source: "build_meta_mixture_summaries (offline reuse of sub-agent cell)",
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      built += 1;
    }
  }
  process.stdout.write(`built=${built} skipped=${skipped}\n`);
}

main().catch((e) => {
  process.stderr.write(
    `build_meta_mixture_summaries failed: ${e instanceof Error ? e.stack : e}\n`,
  );
  process.exit(1);
});
