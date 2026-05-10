// Eval runner: load every YAML task under tasks/suite/<slice>/, run a single
// agent through the slice once per seed, verify each run, and emit a small
// summary table.
//
// The full tournament runner (US-010) supersedes this with: agent
// auto-discovery, resumable cells, leaderboard JSON, etc. For US-006 this
// file is enough to let `make eval AGENT=trivial SLICE=hard` execute the
// hostile fixtures and report which ones the agent fails.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Agent } from "../agent/agent.js";
import { Budget, type BudgetLimits, type TerminalState } from "../agent/types.js";
import { CdpBrowserSession } from "../agent/browser_session.js";
import { loadTaskFile } from "../verifier/loader.js";
import { verify } from "../verifier/runner.js";
import { type Task } from "../verifier/types.js";
import {
  resolveFixtureUrl,
  startFixturesServer,
  type FixturesServer,
} from "../../../tasks/fixtures/server.js";

/** Built-in agent id aliases — `trivial` resolves to the click-first-link reference. */
export const AGENT_ALIASES: Record<string, string> = {
  trivial: "click-first-link",
};

/** Per-difficulty default budgets. Mirrors US-010 AC #2; safe defaults for now. */
export const DIFFICULTY_BUDGETS: Record<string, BudgetLimits> = {
  easy: { tokens: 50_000, usd: 0.2, wallSeconds: 60, steps: 15 },
  medium: { tokens: 200_000, usd: 1.0, wallSeconds: 240, steps: 40 },
  hard: { tokens: 600_000, usd: 3.0, wallSeconds: 600, steps: 80 },
};

export interface EvalOptions {
  agent: string;
  slice: string;
  seeds: number;
  runsRoot: string;
  /** Repo root (cwd by default). Used to resolve agents/ and tasks/ paths. */
  repoRoot?: string;
}

export interface EvalResult {
  task_id: string;
  seed: number;
  terminal_state: TerminalState | "ERROR" | null;
  pass: boolean;
  score: number;
  reason: string;
  durationMs: number;
}

export interface EvalSummary {
  agent_id: string;
  slice: string;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: EvalResult[];
}

export async function loadAgent(agentId: string, repoRoot: string): Promise<Agent> {
  const realId = AGENT_ALIASES[agentId] ?? agentId;
  const filePath = join(repoRoot, "agents", realId, "agent.ts");
  const url = pathToFileURL(filePath).href;
  let mod: { default?: new () => Agent };
  try {
    mod = (await import(url)) as { default?: new () => Agent };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to load agent "${realId}" from ${filePath}: ${msg}`);
  }
  if (!mod.default) {
    throw new Error(`agents/${realId}/agent.ts does not default-export an Agent class`);
  }
  return new mod.default();
}

export async function loadSliceTasks(slice: string, repoRoot: string): Promise<Task[]> {
  const dir = join(repoRoot, "tasks", "suite", slice);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`no slice directory at ${dir}: ${msg}`);
  }
  const yamls = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  if (yamls.length === 0) {
    throw new Error(`no yaml task specs under ${dir}`);
  }
  return Promise.all(yamls.map((f) => loadTaskFile(join(dir, f))));
}

export async function runEval(opts: EvalOptions): Promise<EvalSummary> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const tasks = await loadSliceTasks(opts.slice, repoRoot);
  const needsFixtures = tasks.some((t) => t.start_url.startsWith("fixtures://"));
  let fixtures: FixturesServer | null = null;
  if (needsFixtures) fixtures = await startFixturesServer();

  const agent = await loadAgent(opts.agent, repoRoot);
  const results: EvalResult[] = [];
  const t0 = Date.now();
  try {
    for (const task of tasks) {
      for (let seed = 0; seed < opts.seeds; seed++) {
        if (fixtures) await fixtures.reset();
        const startUrl = fixtures ? resolveFixtureUrl(task.start_url, fixtures.origin) : task.start_url;
        results.push(await runOne(agent, task, seed, startUrl, opts.runsRoot));
      }
    }
  } finally {
    if (fixtures) await fixtures.close();
  }
  const durationMs = Date.now() - t0;
  const passed = results.filter((r) => r.pass).length;
  return {
    agent_id: agent.id,
    slice: opts.slice,
    total: results.length,
    passed,
    failed: results.length - passed,
    durationMs,
    results,
  };
}

async function runOne(
  agent: Agent,
  task: Task,
  seed: number,
  startUrl: string,
  runsRoot: string,
): Promise<EvalResult> {
  const t0 = Date.now();
  const limits = DIFFICULTY_BUDGETS[task.difficulty] ?? DIFFICULTY_BUDGETS.hard;
  const budget = new Budget(limits as BudgetLimits);
  const session = await CdpBrowserSession.create();
  let terminalState: TerminalState | "ERROR" | null = null;
  let pass = false;
  let score = 0;
  let reason = "";
  try {
    await session.navigate(startUrl);
    const traj = await agent.run(task.goal, session, budget, {
      task_id: task.id,
      seed,
      runs_root: runsRoot,
    });
    terminalState = traj.metadata.terminal_state;
    try {
      const verdict = await verify(task, {
        browser: session,
        trajectory: null,
        trajectoryDir: traj.dir,
      });
      pass = verdict.pass;
      score = verdict.score;
      reason = verdict.reason;
    } catch (err) {
      reason = `verify failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } catch (err) {
    terminalState = "ERROR";
    reason = err instanceof Error ? err.message : String(err);
  } finally {
    await session.close().catch(() => {
      // best-effort
    });
  }
  return {
    task_id: task.id,
    seed,
    terminal_state: terminalState,
    pass,
    score,
    reason,
    durationMs: Date.now() - t0,
  };
}

export function formatSummary(summary: EvalSummary): string {
  const header = `[eval] agent=${summary.agent_id} slice=${summary.slice} ` +
    `total=${summary.total} passed=${summary.passed} failed=${summary.failed} ` +
    `(${(summary.durationMs / 1000).toFixed(1)}s)`;
  const rows = summary.results.map((r) => {
    const verdict = r.pass ? "PASS" : "FAIL";
    return `  ${verdict.padEnd(4)} ${r.task_id.padEnd(28)} seed=${r.seed} ` +
      `term=${(r.terminal_state ?? "?").padEnd(16)} score=${r.score.toFixed(2)} ` +
      `${r.reason}`;
  });
  return [header, ...rows].join("\n");
}

