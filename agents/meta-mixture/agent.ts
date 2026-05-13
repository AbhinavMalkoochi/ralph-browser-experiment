// meta-mixture agent (US-024).
//
// A ROUTING agent. Each task is classified by cheap features (host, goal
// keywords) and dispatched to ONE of the top-3 hard-slice agents from the
// 2026-05-12 tournament: runtime-codegen, network-shadow, codegen-predicate.
// The selected sub-agent is constructed normally; its `id` field is
// overridden to "meta-mixture" so that the trajectory it writes lands at
// runs/meta-mixture/<task>/<seed>/, preserving the tournament's
// one-trajectory-per-(agent, task, seed) invariant.
//
// Router policy is documented in agents/meta-mixture/README.md and was
// tuned ONLY against the easy-slice summary data (no hard-slice
// outcomes were consulted when picking thresholds or keyword lists).
//
// A `route.json` sidecar is written next to the trajectory after the
// sub-agent finishes, so an auditor can reconstruct WHICH agent ran each
// cell without re-running the router.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Agent, type AgentContext } from "../../harness/ts/agent/agent.js";
import type { BrowserSession, Budget } from "../../harness/ts/agent/types.js";
import { Trajectory } from "../../harness/ts/agent/trajectory.js";

import RuntimeCodegenAgent from "../runtime-codegen/agent.js";
import NetworkShadowAgent from "../network-shadow/agent.js";
import CodegenPredicateAgent from "../codegen-predicate/agent.js";

import { decideRoute, type RouteDecision, type RoutedAgentId } from "./router.js";

export type SubAgentFactory = (id: RoutedAgentId) => Agent;

export interface MetaMixtureOpts {
  /** Inject a factory (used by tests to substitute mock sub-agents). */
  subAgentFactory?: SubAgentFactory;
}

export const META_MIXTURE_ID = "meta-mixture";

export default class MetaMixtureAgent extends Agent {
  readonly id = META_MIXTURE_ID;

  private readonly opts: MetaMixtureOpts;

  constructor(opts: MetaMixtureOpts = {}) {
    super();
    this.opts = opts;
  }

  async run(
    goal: string,
    browser: BrowserSession,
    budget: Budget,
    ctx: AgentContext,
  ): Promise<Trajectory> {
    // The runner navigates to start_url BEFORE calling run(), so
    // location.href is the task's start URL at this point. Best-effort:
    // tolerate evaluate failures (e.g. data: URLs in contract tests) and
    // fall back to '' so the router's goal-only path still applies.
    let startUrl = "";
    try {
      startUrl = (await browser.evaluate<string>("location.href")) || "";
    } catch {
      startUrl = "";
    }
    const decision = decideRoute(goal, startUrl);
    const factory = this.opts.subAgentFactory ?? defaultSubAgentFactory;
    const subAgent = factory(decision.agent);

    // Override the sub-agent's id so it writes the trajectory under
    // runs/meta-mixture/<task>/<seed>/. readonly is TS-only; the runtime
    // field is plain JS, so this is safe.
    (subAgent as unknown as { id: string }).id = this.id;

    const trajectory = await subAgent.run(goal, browser, budget, ctx);

    // Sidecar: route.json next to trajectory.jsonl.gz. Idempotent —
    // overwrite if the cell is rerun.
    await writeRouteSidecar(trajectory.dir, decision);

    return trajectory;
  }
}

function defaultSubAgentFactory(id: RoutedAgentId): Agent {
  switch (id) {
    case "runtime-codegen":
      return new RuntimeCodegenAgent();
    case "network-shadow":
      return new NetworkShadowAgent();
    case "codegen-predicate":
      return new CodegenPredicateAgent();
  }
}

async function writeRouteSidecar(
  trajectoryDir: string,
  decision: RouteDecision,
): Promise<void> {
  const path = join(trajectoryDir, "route.json");
  const body = JSON.stringify(
    {
      chosen_agent: decision.agent,
      rule: decision.rule,
      reasons: decision.reasons,
      features: decision.features,
      written_at: new Date().toISOString(),
    },
    null,
    2,
  );
  await writeFile(path, body + "\n", "utf8");
}
