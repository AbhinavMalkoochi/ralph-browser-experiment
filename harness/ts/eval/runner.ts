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
import { appFromTags, loginAs } from "../cdp/loginAs.js";
import { injectAuth, missingEnv } from "../auth/inject.js";

/**
 * Built-in agent id aliases.
 * - `trivial`  → click-first-link    (US-002 reference / contract demo)
 * - `baseline` → baseline-a11y-react (US-013 honest control: a11y snapshot
 *                                     + ReAct loop + JSON action set)
 */
export const AGENT_ALIASES: Record<string, string> = {
  trivial: "click-first-link",
  baseline: "baseline-a11y-react",
};

/** Per-difficulty default budgets. Mirrors US-010 AC #2; safe defaults for now. */
export const DIFFICULTY_BUDGETS: Record<string, BudgetLimits> = {
  easy: { tokens: 50_000, usd: 0.2, wallSeconds: 60, steps: 15 },
  medium: { tokens: 200_000, usd: 1.0, wallSeconds: 240, steps: 40 },
  hard: { tokens: 600_000, usd: 3.0, wallSeconds: 600, steps: 80 },
};

/**
 * Per-slice retry defaults. The easy and hard-real slices exercise live
 * public sites that are subject to transient flakiness (DNS, TLS, transient
 * 502s, captchas); AC #5 of US-009 requires up to 2 retries before recording
 * a failure on easy, and US-026 inherits the same policy for hard-real
 * (real sites are flaky regardless of difficulty). Other slices retry zero
 * times by default.
 */
export const SLICE_RETRIES: Record<string, number> = {
  easy: 2,
  "hard-real": 2,
  // US-028: real third-party auth has even more latency variance + rate
  // limits; share the hard-real policy of 2 retries before recording fail.
  "hard-auth": 2,
};

export function defaultRetriesForSlice(slice: string): number {
  return SLICE_RETRIES[slice] ?? 0;
}

export interface EvalOptions {
  agent: string;
  slice: string;
  seeds: number;
  runsRoot: string;
  /** Repo root (cwd by default). Used to resolve agents/ and tasks/ paths. */
  repoRoot?: string;
  /**
   * Override slice loading; when set, runEval uses these tasks directly and
   * does NOT read tasks/suite/<slice>/. The `slice` value is still recorded
   * on the summary for reporting.
   */
  tasks?: Task[];
  /**
   * Number of additional attempts on a failed cell before recording the
   * failure (1 retry = 2 attempts total). Defaults to
   * `defaultRetriesForSlice(slice)` when omitted.
   */
  retries?: number;
}

export interface EvalResult {
  task_id: string;
  seed: number;
  terminal_state: TerminalState | "ERROR" | null;
  pass: boolean;
  score: number;
  reason: string;
  durationMs: number;
  /** 1-based count of attempts that ran for this cell; >=1 always. */
  attempts: number;
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
  const tasks = opts.tasks ?? (await loadSliceTasks(opts.slice, repoRoot));
  const needsFixtures = tasks.some((t) => t.start_url.startsWith("fixtures://"));
  let fixtures: FixturesServer | null = null;
  if (needsFixtures) fixtures = await startFixturesServer();

  const agent = await loadAgent(opts.agent, repoRoot);
  const retries = opts.retries ?? defaultRetriesForSlice(opts.slice);
  const results: EvalResult[] = [];
  const t0 = Date.now();
  try {
    for (const task of tasks) {
      for (let seed = 0; seed < opts.seeds; seed++) {
        // US-028: SKIP cleanly when an auth task lacks env vars.
        const missing = missingEnv(task);
        if (missing.length > 0) {
          results.push({
            task_id: task.id,
            seed,
            terminal_state: "SKIPPED_AUTH",
            pass: false,
            score: 0,
            reason: `requires_env unset: ${missing.join(", ")}`,
            durationMs: 0,
            attempts: 0,
          });
          continue;
        }
        const result = await runWithRetry(retries, async () => {
          if (fixtures) await fixtures.reset();
          const startUrl = fixtures ? resolveFixtureUrl(task.start_url, fixtures.origin) : task.start_url;
          return runOne(agent, task, seed, startUrl, opts.runsRoot);
        });
        results.push(result);
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

/**
 * Run `fn` up to `retries + 1` times; stop early on the first attempt that
 * returns `pass: true`. The returned EvalResult has its `attempts` field set
 * to the 1-based count of attempts that actually ran (so a first-attempt
 * pass returns `attempts: 1`).
 *
 * `retries` MUST be >= 0; non-integer / negative values are clamped.
 */
export async function runWithRetry(
  retries: number,
  fn: (attempt: number) => Promise<EvalResult>,
): Promise<EvalResult> {
  const max = Math.max(0, Math.floor(retries));
  let last: EvalResult | undefined;
  for (let attempt = 0; attempt <= max; attempt++) {
    const r = await fn(attempt);
    last = { ...r, attempts: attempt + 1 };
    if (last.pass) return last;
  }
  return last as EvalResult;
}

async function runOne(
  agent: Agent,
  task: Task,
  seed: number,
  startUrl: string,
  runsRoot: string,
): Promise<EvalResult> {
  const t0 = Date.now();
  const baseLimits = (DIFFICULTY_BUDGETS[task.difficulty] ?? DIFFICULTY_BUDGETS.hard) as BudgetLimits;
  const limits: BudgetLimits = task.requires_env && task.requires_env.length > 0
    ? { ...baseLimits, wallSeconds: baseLimits.wallSeconds * 2 }
    : baseLimits;
  const budget = new Budget(limits);
  const session = await CdpBrowserSession.create();
  let terminalState: TerminalState | "ERROR" | null = null;
  let pass = false;
  let score = 0;
  let reason = "";
  try {
    // Pre-login for self-hosted-app tasks (US-027). The runner — not the
    // agent — owns app credentials; tags drive the dispatch.
    const app = appFromTags(task.tags);
    if (app) {
      await session.cdp.send("Network.enable");
      await loginAs(session, app);
    }
    if (task.auth) {
      await session.cdp.send("Network.enable");
      await injectAuth(session, task.auth);
    }
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
    attempts: 1,
  };
}

export function formatSummary(summary: EvalSummary): string {
  const header = `[eval] agent=${summary.agent_id} slice=${summary.slice} ` +
    `total=${summary.total} passed=${summary.passed} failed=${summary.failed} ` +
    `(${(summary.durationMs / 1000).toFixed(1)}s)`;
  const rows = summary.results.map((r) => {
    const verdict = r.pass ? "PASS" : "FAIL";
    const attemptTag = r.attempts > 1 ? ` attempts=${r.attempts}` : "";
    return `  ${verdict.padEnd(4)} ${r.task_id.padEnd(28)} seed=${r.seed} ` +
      `term=${(r.terminal_state ?? "?").padEnd(16)} score=${r.score.toFixed(2)}${attemptTag} ` +
      `${r.reason}`;
  });
  return [header, ...rows].join("\n");
}

