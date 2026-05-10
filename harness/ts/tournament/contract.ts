// US-012: contract test runner.
//
// Runs each discovered agent on a 1-task dry slice and checks that it
// produces a valid Trajectory. The contract is intentionally minimal —
// we don't care whether the agent succeeds, declines, or errors; we
// care that it returns a finished Trajectory with the expected
// metadata identifiers. Agents that violate the contract are reported
// per-agent and do NOT abort the loop.
//
// The default browser is a real CdpBrowserSession on a tiny data: URL,
// but tests pass `browserFactory` to inject a FakeBrowserSession and
// avoid Chrome boot when the contract under test doesn't need a real
// page. Both TS and Python agents are supported via the same code path
// as the tournament runner — this module is what the runner would call
// in dry-run mode if asked.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Agent } from "../agent/agent.js";
import { CdpBrowserSession } from "../agent/browser_session.js";
import { Trajectory } from "../agent/trajectory.js";
import { Budget, type BrowserSession, type BudgetLimits } from "../agent/types.js";
import { PythonAgentBridge, runPythonAgent } from "../agent/python_bridge.js";

import type { DiscoveredAgent } from "./types.js";

/**
 * Duck-type check for a Trajectory-like object. We do NOT use instanceof
 * because dynamically-imported agent files may resolve their `Trajectory`
 * import to a different module URL than this file's static import,
 * giving distinct class identities for the same logical type. Checking
 * the structural fields the harness cares about avoids that fragility.
 */
function looksLikeTrajectory(value: unknown): value is Trajectory {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!v.metadata || typeof v.metadata !== "object") return false;
  if (typeof v.isFinished !== "boolean") return false;
  return true;
}

export interface ContractResult {
  agent_id: string;
  ok: boolean;
  reason: string;
  /** terminal_state recorded on the trajectory; null if the agent never finished. */
  terminal_state: string | null;
}

export interface ContractTestOpts {
  agents: readonly DiscoveredAgent[];
  /**
   * Override browser construction. Default constructs a real
   * CdpBrowserSession (boots Chrome). Tests typically inject a
   * FakeBrowserSession to keep the contract test fast.
   */
  browserFactory?: () => Promise<BrowserSession>;
  /** Override the dry-task goal. */
  goal?: string;
  /** Override the dry-task id. */
  taskId?: string;
  /** Override the page URL the contract test navigates to before run(). */
  startUrl?: string;
  /**
   * Trajectory output root. Required when the caller wants to inspect
   * artefacts; if omitted a fresh tmpdir is allocated and not cleaned.
   */
  runsRoot?: string;
  /** Per-agent budget for the dry task. */
  budgetLimits?: BudgetLimits;
}

const DEFAULT_BUDGET: BudgetLimits = { tokens: 1_000, usd: 1, wallSeconds: 30, steps: 5 };
const DEFAULT_DATA_URL = "data:text/html,%3Cdoctype%20html%3E%3Ctitle%3Econtract%3C%2Ftitle%3E";

/**
 * Run each discovered agent on a 1-task dry slice and return one
 * ContractResult per agent. An agent passes the contract if it returns a
 * finished Trajectory whose metadata.agent_id matches the manifest and
 * whose terminal_state is set.
 */
export async function runContractTest(opts: ContractTestOpts): Promise<ContractResult[]> {
  const goal = opts.goal ?? "contract test goal";
  const taskId = opts.taskId ?? "contract-test";
  const startUrl = opts.startUrl ?? DEFAULT_DATA_URL;
  const runsRoot = opts.runsRoot ?? (await mkdtemp(join(tmpdir(), "gba-contract-")));
  const limits = opts.budgetLimits ?? DEFAULT_BUDGET;
  const factory = opts.browserFactory ?? (() => CdpBrowserSession.create());

  const out: ContractResult[] = [];
  for (const agent of opts.agents) {
    out.push(await runOne(agent, { goal, taskId, startUrl, runsRoot, limits, factory }));
  }
  return out;
}

interface OneOpts {
  goal: string;
  taskId: string;
  startUrl: string;
  runsRoot: string;
  limits: BudgetLimits;
  factory: () => Promise<BrowserSession>;
}

async function runOne(agent: DiscoveredAgent, opts: OneOpts): Promise<ContractResult> {
  const seed = 0;
  let session: BrowserSession | null = null;
  let trajectory: Trajectory | null = null;
  try {
    session = await opts.factory();
    await session.navigate(opts.startUrl);
    const budget = new Budget(opts.limits);
    if (agent.language === "typescript") {
      const url = pathToFileURL(agent.agentFile).href;
      const mod = (await import(url)) as { default?: unknown };
      if (typeof mod.default !== "function") {
        return failure(agent.id, "agent.ts has no default export class", null);
      }
      const ctor = mod.default as new () => Partial<Agent> & {
        run?: Agent["run"];
        id?: string;
      };
      const inst = new ctor();
      if (typeof inst.run !== "function") {
        return failure(agent.id, "default export does not implement run()", null);
      }
      const result = await inst.run(opts.goal, session, budget, {
        task_id: opts.taskId,
        seed,
        runs_root: opts.runsRoot,
      });
      trajectory = result as Trajectory;
    } else {
      trajectory = await Trajectory.open(
        { runsRoot: opts.runsRoot, agent: agent.id, task: opts.taskId, seed },
        { agent_id: agent.id, task_id: opts.taskId, seed },
      );
      const bridge = PythonAgentBridge.spawn({ agentPath: agent.agentFile });
      try {
        await runPythonAgent({
          bridge,
          agentId: agent.id,
          goal: opts.goal,
          browser: session,
          budget,
          trajectory,
          ctx: { task_id: opts.taskId, seed, runs_root: opts.runsRoot },
        });
      } finally {
        await bridge.close();
      }
    }

    if (!looksLikeTrajectory(trajectory)) {
      return failure(agent.id, "agent did not return a Trajectory-like object", null);
    }
    if (!trajectory.isFinished) {
      return failure(agent.id, "agent returned an unfinished Trajectory", null);
    }
    if (trajectory.metadata.agent_id !== agent.id) {
      return failure(
        agent.id,
        `trajectory metadata agent_id mismatch: ${trajectory.metadata.agent_id} != ${agent.id}`,
        trajectory.metadata.terminal_state,
      );
    }
    if (!trajectory.metadata.terminal_state) {
      return failure(agent.id, "trajectory has no terminal_state", null);
    }
    return {
      agent_id: agent.id,
      ok: true,
      reason: `terminal_state=${trajectory.metadata.terminal_state}`,
      terminal_state: trajectory.metadata.terminal_state,
    };
  } catch (err) {
    return failure(
      agent.id,
      err instanceof Error ? err.message : String(err),
      trajectory?.metadata.terminal_state ?? null,
    );
  } finally {
    const closer = (session as { close?: () => Promise<void> } | null)?.close;
    if (closer) {
      await closer.call(session).catch(() => {
        /* best-effort */
      });
    }
  }
}

function failure(agent_id: string, reason: string, terminal_state: string | null): ContractResult {
  return { agent_id, ok: false, reason, terminal_state };
}
