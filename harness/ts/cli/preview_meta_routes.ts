// CLI: print the meta-mixture router's decision for every task in a slice.
//
// Usage:
//   npx tsx harness/ts/cli/preview_meta_routes.ts --slice=hard
//   npx tsx harness/ts/cli/preview_meta_routes.ts --slice=easy
//
// Pure offline tool: it does NOT spin up Chrome or contact an LLM, it just
// reads tasks/suite/<slice>/*.yaml and runs the keyword router on each
// (goal, start_url). Used by US-024 to publish the meta-mixture route
// table without needing API keys / a fresh tournament run.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseYaml } from "../verifier/yaml.js";
import { decideRoute } from "../../../agents/meta-mixture/router.js";

interface RouteRow {
  task: string;
  agent: string;
  rule: string;
  reasons: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let slice = "hard";
  let outPath: string | null = null;
  for (const a of args) {
    if (a.startsWith("--slice=")) slice = a.slice("--slice=".length);
    else if (a.startsWith("--out=")) outPath = a.slice("--out=".length);
  }
  const sliceDir = join(process.cwd(), "tasks", "suite", slice);
  const entries = (await readdir(sliceDir)).filter((f) => f.endsWith(".yaml")).sort();
  const rows: RouteRow[] = [];
  for (const entry of entries) {
    const yaml = parseYaml(await readFile(join(sliceDir, entry), "utf8")) as {
      id?: string;
      goal?: string;
      start_url?: string;
    };
    const task = yaml.id ?? entry.replace(/\.yaml$/, "");
    const decision = decideRoute(yaml.goal ?? "", yaml.start_url ?? "");
    rows.push({
      task,
      agent: decision.agent,
      rule: decision.rule,
      reasons: decision.reasons,
    });
  }
  const lines: string[] = [];
  lines.push(`# meta-mixture routes for slice: ${slice}`);
  lines.push("");
  lines.push("| task | chosen agent | rule | reasons |");
  lines.push("|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| \`${r.task}\` | \`${r.agent}\` | \`${r.rule}\` | ${r.reasons.join("; ")} |`,
    );
  }
  const out = lines.join("\n") + "\n";
  if (outPath) {
    await writeFile(outPath, out, "utf8");
    process.stdout.write(`wrote ${outPath}\n`);
  } else {
    process.stdout.write(out);
  }
}

main().catch((e) => {
  process.stderr.write(`preview_meta_routes failed: ${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
