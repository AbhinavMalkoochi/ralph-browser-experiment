// US-023: One-shot synthesis of summary.json sidecars from prior trajectories.
//
// Walks runs/<agent>/<task>/<seed>/ for every directory that already has
// trajectory.jsonl.gz + verdict.json and writes the missing summary.json by
// folding the trajectory's meta/step/llm_call/end lines together with the
// adjacent verdict. Cells that already have summary.json are left alone.
//
// This exists because the tournament runner (US-010) only writes summary.json
// for cells it ran end-to-end; prior iterations dropped trajectories without
// the resumability sidecar, and US-023's leaderboard depends on those rows.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import readline from "node:readline";

import { hasSummary, summaryPath, writeSummary } from "../tournament/summary.js";
import type { CellSummary } from "../tournament/types.js";
import { loadTaskFile } from "../verifier/loader.js";
import type { Task } from "../verifier/types.js";

interface VerdictFile {
  pass?: boolean;
  score?: number;
  reason?: string;
  verified_at?: string;
}

interface TrajectoryMetaLine {
  kind: "meta";
  agent_id: string;
  task_id: string;
  seed: number;
  start_time: string;
}

interface TrajectoryStepLine {
  kind: "step";
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

interface TrajectoryLlmLine {
  kind: "llm_call";
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
}

interface TrajectoryEndLine {
  kind: "end";
  end_time: string;
  terminal_state: string | null;
  decline_reason: string | null;
}

type TrajectoryLine =
  | TrajectoryMetaLine
  | TrajectoryStepLine
  | TrajectoryLlmLine
  | TrajectoryEndLine
  | { kind: string };

async function readTrajectoryLines(path: string): Promise<TrajectoryLine[]> {
  const out: TrajectoryLine[] = [];
  const stream = createReadStream(path).pipe(createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TrajectoryLine);
    } catch {
      // skip malformed
    }
  }
  return out;
}

async function loadTasks(repoRoot: string): Promise<Map<string, Task>> {
  const suiteDir = join(repoRoot, "tasks", "suite");
  const out = new Map<string, Task>();
  let slices: string[];
  try {
    slices = await readdir(suiteDir);
  } catch {
    return out;
  }
  for (const slice of slices) {
    const dir = join(suiteDir, slice);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      try {
        const task = await loadTaskFile(join(dir, f));
        out.set(task.id, task);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

interface SynthesizeOptions {
  runsRoot: string;
  repoRoot: string;
  overwrite?: boolean;
}

interface SynthesizeResult {
  scanned: number;
  written: number;
  skipped_existing: number;
  skipped_no_traj: number;
  skipped_no_verdict: number;
  skipped_no_task: number;
}

export async function synthesizeSummaries(
  opts: SynthesizeOptions,
): Promise<SynthesizeResult> {
  const res: SynthesizeResult = {
    scanned: 0,
    written: 0,
    skipped_existing: 0,
    skipped_no_traj: 0,
    skipped_no_verdict: 0,
    skipped_no_task: 0,
  };
  const tasks = await loadTasks(opts.repoRoot);
  let agentDirs: string[];
  try {
    agentDirs = await readdir(opts.runsRoot);
  } catch {
    return res;
  }
  for (const agent of agentDirs) {
    if (agent.startsWith(".")) continue;
    const agentPath = join(opts.runsRoot, agent);
    let s;
    try {
      s = await stat(agentPath);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    let taskDirs: string[];
    try {
      taskDirs = await readdir(agentPath);
    } catch {
      continue;
    }
    for (const taskId of taskDirs) {
      const taskPath = join(agentPath, taskId);
      let s2;
      try {
        s2 = await stat(taskPath);
      } catch {
        continue;
      }
      if (!s2.isDirectory()) continue;
      let seedDirs: string[];
      try {
        seedDirs = await readdir(taskPath);
      } catch {
        continue;
      }
      for (const seedName of seedDirs) {
        const cellDir = join(taskPath, seedName);
        let s3;
        try {
          s3 = await stat(cellDir);
        } catch {
          continue;
        }
        if (!s3.isDirectory()) continue;
        const seedNum = Number.parseInt(seedName, 10);
        if (!Number.isFinite(seedNum)) continue;
        res.scanned++;
        const sumPath = summaryPath({
          runsRoot: opts.runsRoot,
          agent,
          task: taskId,
          seed: seedNum,
        });
        if (!opts.overwrite && (await hasSummary(sumPath))) {
          res.skipped_existing++;
          continue;
        }
        const trajPath = join(cellDir, "trajectory.jsonl.gz");
        try {
          await stat(trajPath);
        } catch {
          res.skipped_no_traj++;
          continue;
        }
        const verdictPath = join(cellDir, "verdict.json");
        let verdict: VerdictFile | null = null;
        try {
          const raw = await readFile(verdictPath, "utf8");
          verdict = JSON.parse(raw) as VerdictFile;
        } catch {
          res.skipped_no_verdict++;
          continue;
        }
        const task = tasks.get(taskId);
        if (!task) {
          res.skipped_no_task++;
          continue;
        }
        const lines = await readTrajectoryLines(trajPath);
        const meta = lines.find((l) => l.kind === "meta") as TrajectoryMetaLine | undefined;
        const end = lines.find((l) => l.kind === "end") as TrajectoryEndLine | undefined;
        const steps = lines.filter((l) => l.kind === "step") as TrajectoryStepLine[];
        const llmCalls = lines.filter((l) => l.kind === "llm_call") as TrajectoryLlmLine[];
        const stepCost = steps.reduce((a, b) => a + (b.cost_usd ?? 0), 0);
        const llmCost = llmCalls.reduce((a, b) => a + (b.cost_usd ?? 0), 0);
        const stepIn = steps.reduce((a, b) => a + (b.tokens_in ?? 0), 0);
        const stepOut = steps.reduce((a, b) => a + (b.tokens_out ?? 0), 0);
        const llmIn = llmCalls.reduce((a, b) => a + (b.prompt_tokens ?? 0), 0);
        const llmOut = llmCalls.reduce((a, b) => a + (b.completion_tokens ?? 0), 0);
        const stepLatency = steps.reduce((a, b) => a + (b.latency_ms ?? 0), 0);
        const startMs = meta?.start_time ? Date.parse(meta.start_time) : 0;
        const endMs = end?.end_time ? Date.parse(end.end_time) : 0;
        const wall = endMs > 0 && startMs > 0 ? Math.max(0, endMs - startMs) : stepLatency;
        const summary: CellSummary = {
          agent_id: agent,
          task_id: taskId,
          seed: seedNum,
          difficulty: task.difficulty,
          completed_at: end?.end_time ?? verdict.verified_at ?? new Date().toISOString(),
          terminal_state: (end?.terminal_state ?? null) as CellSummary["terminal_state"],
          pass: !!verdict.pass,
          score: typeof verdict.score === "number" ? verdict.score : (verdict.pass ? 1 : 0),
          reason: verdict.reason ?? "",
          decline_reason: end?.decline_reason ?? null,
          steps: steps.length,
          llm_calls: llmCalls.length,
          cost_usd: stepCost + llmCost,
          tokens_in: stepIn + llmIn,
          tokens_out: stepOut + llmOut,
          latency_ms: wall,
          attempts: 1,
        };
        await writeSummary(sumPath, summary);
        res.written++;
      }
    }
  }
  return res;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let runsRoot = resolve(process.cwd(), "runs");
  let repoRoot = process.cwd();
  let overwrite = false;
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) {
      if (arg === "--overwrite") overwrite = true;
      continue;
    }
    const [, key, value] = m;
    if (key === undefined || value === undefined) continue;
    if (key === "runs-root") runsRoot = resolve(value);
    else if (key === "repo-root") repoRoot = resolve(value);
  }
  const res = await synthesizeSummaries({ runsRoot, repoRoot, overwrite });
  process.stdout.write(
    `[synthesize-summaries] scanned=${res.scanned} written=${res.written} ` +
      `existing=${res.skipped_existing} no_traj=${res.skipped_no_traj} ` +
      `no_verdict=${res.skipped_no_verdict} no_task=${res.skipped_no_task}\n`,
  );
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[synthesize-summaries] error: ${msg}\n`);
    process.exit(1);
  });
}
