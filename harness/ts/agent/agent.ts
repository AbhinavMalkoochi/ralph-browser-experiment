// Agent base class. Every TS agent under agents/<id>/agent.ts exports a
// default class that extends Agent and implements run().
//
// The harness invokes:
//
//   const agent = new MyAgent();
//   const traj = await agent.run(goal, browserSession, budget, ctx);
//
// `ctx` carries the per-task identifiers needed to construct the trajectory
// file path runs/<agent>/<task>/<seed>/trajectory.jsonl[.gz]. The first three
// args (goal, browser, budget) are the contract spelled out in US-002.

import type { BrowserSession, Budget } from "./types.js";
import type { Trajectory } from "./trajectory.js";

export interface AgentContext {
  /** Stable identifier for the task being run. */
  task_id: string;
  /** Seed (an integer); rerunning with the same seed should reproduce. */
  seed: number;
  /** Root for trajectory output, typically <repo>/runs. */
  runs_root: string;
}

export abstract class Agent {
  /** Stable identifier matching agents/<id>/manifest.yaml. */
  abstract readonly id: string;

  abstract run(
    goal: string,
    browser: BrowserSession,
    budget: Budget,
    ctx: AgentContext,
  ): Promise<Trajectory>;
}
