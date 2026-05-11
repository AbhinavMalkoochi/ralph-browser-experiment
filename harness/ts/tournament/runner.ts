// Resumable tournament runner (US-010).
//
// Runs each (agent, task, seed) cell once, with per-task budgets enforced by
// difficulty (DIFFICULTY_BUDGETS in eval/runner.ts). A cell's done-marker is
// `runs/<agent>/<task>/<seed>/summary.json`; if present, the cell is skipped
// and its cached summary feeds the leaderboard.
//
// The runner is agent-language-aware: TS agents are dynamic-imported, Python
// agents go over the existing JSON-RPC bridge (US-002). Both paths funnel
// into the same `runCell()` so resumability + summary writing happen in one
// place regardless of language.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Agent } from "../agent/agent.js";
import { CdpBrowserSession } from "../agent/browser_session.js";
import { Trajectory } from "../agent/trajectory.js";
import { Budget, BudgetExceeded, type BrowserSession, type TerminalState } from "../agent/types.js";
import { PythonAgentBridge, runPythonAgent } from "../agent/python_bridge.js";
import { SessionTimeoutError } from "../cdp/pool.js";
import { loadTaskFile } from "../verifier/loader.js";
import { verify } from "../verifier/runner.js";
import { type Task } from "../verifier/types.js";
import {
  resolveFixtureUrl,
  startFixturesServer,
  type FixturesServer,
} from "../../../tasks/fixtures/server.js";
import { readdir } from "node:fs/promises";

import { discoverAgents } from "./discovery.js";
import { DIFFICULTY_BUDGETS, defaultRetriesForSlice } from "../eval/runner.js";
import {
  buildLeaderboardFile,
  formatLeaderboard,
  writeLeaderboard,
} from "./leaderboard.js";
import { buildBracket } from "./bracket.js";
import { hasSummary, readSummary, summaryPath, writeSummary } from "./summary.js";
import { slicePreflight } from "./preflight.js";
import { appFromTags, loginAs } from "../cdp/loginAs.js";
import type {
  BracketResult,
  CellSummary,
  DiscoveredAgent,
  LeaderboardFile,
} from "./types.js";

export interface TournamentOptions {
  /** Slices to run, e.g. ["easy", "hard"]. */
  slices: string[];
  /** Number of seeds per (agent, task). >=1. */
  seeds: number;
  /** Trajectory + summary + leaderboard root. */
  runsRoot: string;
  /** Repo root; defaults to cwd. */
  repoRoot?: string;
  /** Optional list of agent ids to include; others are skipped. */
  agentFilter?: string[];
  /** Optional list of task ids to include; others are skipped. */
  taskFilter?: string[];
  /** Pre-discovered agents; bypasses discoverAgents() when provided. */
  agents?: DiscoveredAgent[];
  /** Per-slice tasks override; bypasses loadSliceTasks for those entries. */
  tasksBySlice?: Map<string, Task[]>;
  /** Build a single-elimination bracket per slice when true. */
  bracket?: boolean;
  /** Bracket seeding mode passed through to buildBracket. */
  bracketSeeding?: "leaderboard" | "alphabetical";
  /** When true, leaderboard.json is NOT written (still returned in memory). */
  skipLeaderboardWrite?: boolean;
  /** Override per-slice retry count. Defaults to defaultRetriesForSlice(slice). */
  retries?: number;
  /** Hook for stderr-friendly progress lines. Defaults to process.stderr. */
  onProgress?: (line: string) => void;
}

export interface TournamentResult {
  leaderboard: LeaderboardFile;
  /** Per-slice summaries (including resumed ones). */
  summariesBySlice: Map<string, CellSummary[]>;
  /** Where leaderboard.json was written, or null when skipLeaderboardWrite. */
  leaderboardPath: string | null;
  /** All agents that were considered (post-filter). */
  agents: DiscoveredAgent[];
}

export const LEADERBOARD_FILENAME = "leaderboard.json";

export async function runTournament(opts: TournamentOptions): Promise<TournamentResult> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const onProgress = opts.onProgress ?? ((line) => process.stderr.write(line + "\n"));
  const agents = opts.agents ?? (await discoverAgents({ repoRoot, filterIds: opts.agentFilter }));
  const filteredAgents = opts.agentFilter
    ? agents.filter((a) => opts.agentFilter!.includes(a.id))
    : agents;

  const summariesBySlice = new Map<string, CellSummary[]>();
  const bracketBySlice = new Map<string, BracketResult | null>();

  for (const slice of opts.slices) {
    // Slice-level preflight (US-027): hard-app skips when the self-hosted
    // apps aren't reachable. Any non-OK verdict aborts THIS slice without
    // writing summary.json or running any cells; other slices continue.
    const preflight = await slicePreflight(slice);
    if (!preflight.ok) {
      onProgress(`[tournament] SKIP slice=${slice}: ${preflight.reason}`);
      summariesBySlice.set(slice, []);
      continue;
    }
    const tasksAll = opts.tasksBySlice?.get(slice) ?? (await loadSliceTasks(slice, repoRoot));
    const tasks = opts.taskFilter
      ? tasksAll.filter((t) => opts.taskFilter!.includes(t.id))
      : tasksAll;
    const needsFixtures = tasks.some((t) => t.start_url.startsWith("fixtures://"));
    let fixtures: FixturesServer | null = null;
    if (needsFixtures) fixtures = await startFixturesServer();
    const sliceSummaries: CellSummary[] = [];
    const retries = opts.retries ?? defaultRetriesForSlice(slice);
    try {
      for (const agent of filteredAgents) {
        for (const task of tasks) {
          for (let seed = 0; seed < opts.seeds; seed++) {
            const summary = await runOrResumeCell({
              agent,
              task,
              seed,
              runsRoot: opts.runsRoot,
              fixtures,
              retries,
              onProgress,
            });
            sliceSummaries.push(summary);
          }
        }
      }
    } finally {
      if (fixtures) await fixtures.close();
    }
    summariesBySlice.set(slice, sliceSummaries);
  }

  const leaderboard = buildLeaderboardFile({ perSlice: summariesBySlice });
  if (opts.bracket) {
    for (const slice of opts.slices) {
      const rows = leaderboard.slices[slice]?.rows ?? [];
      const seeding = opts.bracketSeeding;
      const result = buildBracket(rows, seeding ? { seeding } : {});
      bracketBySlice.set(slice, result);
      if (result && leaderboard.slices[slice]) {
        leaderboard.slices[slice]!.bracket = result;
      }
    }
  }

  let leaderboardPath: string | null = null;
  if (!opts.skipLeaderboardWrite) {
    leaderboardPath = join(opts.runsRoot, LEADERBOARD_FILENAME);
    await mkdir(opts.runsRoot, { recursive: true });
    await writeLeaderboard(leaderboardPath, leaderboard);
  }
  return { leaderboard, summariesBySlice, leaderboardPath, agents: filteredAgents };
}

interface RunOrResumeOpts {
  agent: DiscoveredAgent;
  task: Task;
  seed: number;
  runsRoot: string;
  fixtures: FixturesServer | null;
  retries: number;
  onProgress: (line: string) => void;
}

async function runOrResumeCell(opts: RunOrResumeOpts): Promise<CellSummary> {
  const { agent, task, seed, runsRoot, fixtures, retries, onProgress } = opts;
  const sumPath = summaryPath({ runsRoot, agent: agent.id, task: task.id, seed });
  if (await hasSummary(sumPath)) {
    const cached = await readSummary(sumPath);
    if (cached) {
      onProgress(`[tournament] resume agent=${agent.id} task=${task.id} seed=${seed}`);
      return { ...cached, reused: true };
    }
  }
  onProgress(`[tournament] run    agent=${agent.id} task=${task.id} seed=${seed}`);
  const maxAttempts = Math.max(0, Math.floor(retries)) + 1;
  let last: CellSummary | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (fixtures) await fixtures.reset();
    const startUrl = fixtures ? resolveFixtureUrl(task.start_url, fixtures.origin) : task.start_url;
    const cell = await runCell({ agent, task, seed, startUrl, runsRoot });
    last = { ...cell, attempts: attempt + 1 };
    if (last.pass) break;
  }
  // Persist the final attempt's summary (overwrites any earlier per-attempt
  // write). Resumability hinges on this file existing AFTER all retries.
  await writeSummary(sumPath, last as CellSummary);
  return last as CellSummary;
}

interface RunCellOpts {
  agent: DiscoveredAgent;
  task: Task;
  seed: number;
  startUrl: string;
  runsRoot: string;
}

async function runCell(opts: RunCellOpts): Promise<CellSummary> {
  const { agent, task, seed, startUrl, runsRoot } = opts;
  const limits = DIFFICULTY_BUDGETS[task.difficulty] ?? DIFFICULTY_BUDGETS.hard;
  const budget = new Budget(limits!);
  const t0 = Date.now();
  const session = await CdpBrowserSession.create();
  let trajectory: Trajectory | null = null;
  let terminalState: TerminalState | "ERROR" | null = null;
  let pass = false;
  let score = 0;
  let reason = "";
  let declineReason: string | null = null;
  try {
    // Pre-login (US-027): tasks tagged `app:<id>` are authenticated against
    // the named self-hosted app before agent.run() so the agent starts in
    // a logged-in browser state. The harness owns the credentials; the
    // agent never sees them.
    const app = appFromTags(task.tags);
    if (app) {
      await session.cdp.send("Network.enable");
      await loginAs(session, app);
    }
    await session.navigate(startUrl);
    if (agent.language === "typescript") {
      const cls = await loadTsAgentClass(agent.agentFile);
      const instance = new cls();
      trajectory = await instance.run(task.goal, session as BrowserSession, budget, {
        task_id: task.id,
        seed,
        runs_root: runsRoot,
      });
    } else {
      trajectory = await Trajectory.open(
        { runsRoot, agent: agent.id, task: task.id, seed },
        { agent_id: agent.id, task_id: task.id, seed },
      );
      const bridge = PythonAgentBridge.spawn({ agentPath: agent.agentFile });
      try {
        await runPythonAgent({
          bridge,
          agentId: agent.id,
          goal: task.goal,
          browser: session as BrowserSession,
          budget,
          trajectory,
          ctx: { task_id: task.id, seed, runs_root: runsRoot },
        });
      } finally {
        await bridge.close();
      }
    }
    terminalState = trajectory.metadata.terminal_state;
    declineReason = trajectory.metadata.decline_reason;
    try {
      const verdict = await verify(task, {
        browser: session,
        trajectory: null,
        trajectoryDir: trajectory.dir,
      });
      pass = verdict.pass;
      score = verdict.score;
      reason = verdict.reason;
    } catch (err) {
      reason = `verify failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } catch (err) {
    if (err instanceof BudgetExceeded) terminalState = "BUDGET_EXCEEDED";
    else if (err instanceof SessionTimeoutError) terminalState = "SESSION_TIMEOUT";
    else terminalState = "ERROR";
    reason = err instanceof Error ? err.message : String(err);
    if (trajectory && !trajectory.isFinished) {
      try {
        await trajectory.finish({ terminal_state: terminalState, decline_reason: reason });
      } catch {
        /* best-effort */
      }
    }
  } finally {
    await session.close().catch(() => {
      /* best-effort */
    });
  }

  const steps = trajectory?.snapshotSteps() ?? [];
  const llmCalls = trajectory?.snapshotLlmCalls() ?? [];
  const cost_usd =
    steps.reduce((s, x) => s + (x.cost_usd ?? 0), 0) +
    llmCalls.reduce((s, x) => s + (x.cost_usd ?? 0), 0);
  const tokens_in = steps.reduce((s, x) => s + (x.tokens_in ?? 0), 0) +
    llmCalls.reduce((s, x) => s + (x.prompt_tokens ?? 0), 0);
  const tokens_out = steps.reduce((s, x) => s + (x.tokens_out ?? 0), 0) +
    llmCalls.reduce((s, x) => s + (x.completion_tokens ?? 0), 0);

  return {
    agent_id: agent.id,
    task_id: task.id,
    seed,
    difficulty: task.difficulty,
    completed_at: new Date().toISOString(),
    terminal_state: terminalState,
    pass,
    score,
    reason,
    decline_reason: declineReason,
    steps: steps.length,
    llm_calls: llmCalls.length,
    cost_usd,
    tokens_in,
    tokens_out,
    latency_ms: Date.now() - t0,
    attempts: 1,
  };
}

async function loadTsAgentClass(agentFile: string): Promise<new () => Agent> {
  const url = pathToFileURL(agentFile).href;
  const mod = (await import(url)) as { default?: new () => Agent };
  if (!mod.default) {
    throw new Error(`${agentFile} does not default-export an Agent class`);
  }
  return mod.default;
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

export { formatLeaderboard, resolve as resolvePath };
