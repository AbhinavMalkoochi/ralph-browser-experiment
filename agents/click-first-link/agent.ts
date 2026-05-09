// Trivial reference agent: find the first <a> on the page and "click" it.
//
// Exists to demonstrate the Agent / BrowserSession / Trajectory contract
// end-to-end. NOT a tournament participant — `passes` data on the easy/hard
// slices is expected to be near-zero.

import { Agent, type AgentContext } from "../../harness/ts/agent/agent.js";
import { Trajectory } from "../../harness/ts/agent/trajectory.js";
import {
  BudgetExceeded,
  type BrowserSession,
  type Budget,
} from "../../harness/ts/agent/types.js";

export default class ClickFirstLinkAgent extends Agent {
  readonly id = "click-first-link";

  async run(
    goal: string,
    browser: BrowserSession,
    budget: Budget,
    ctx: AgentContext,
  ): Promise<Trajectory> {
    const trajectory = await Trajectory.open(
      { runsRoot: ctx.runs_root, agent: this.id, task: ctx.task_id, seed: ctx.seed },
      { agent_id: this.id, task_id: ctx.task_id, seed: ctx.seed },
    );

    try {
      const t0 = Date.now();
      const links = await browser.evaluate<string[]>(
        "Array.from(document.querySelectorAll('a')).map(a => a.href).filter(Boolean)",
      );
      budget.recordStep();
      budget.check();

      const observe = `goal=${truncate(goal, 80)} | found ${links.length} link(s)`;

      if (links.length === 0) {
        await trajectory.addStep({
          step: 1,
          observation_summary: observe,
          action: { type: "noop", reason: "no links on page" },
          latency_ms: Date.now() - t0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        });
        await trajectory.finish({
          terminal_state: "DECLINED",
          decline_reason: "no links on page",
        });
        return trajectory;
      }

      const target = links[0] as string;

      const t1 = Date.now();
      await browser.evaluate(`window.location.href = ${JSON.stringify(target)}`);
      budget.recordStep();
      budget.check();

      await trajectory.addStep({
        step: 1,
        observation_summary: observe,
        action: { type: "click_link", href: target },
        latency_ms: Date.now() - t1,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        screenshot_path: null,
        verifier_state: null,
      });
      await trajectory.finish({ terminal_state: "DONE" });
      return trajectory;
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        await trajectory.finish({
          terminal_state: "BUDGET_EXCEEDED",
          decline_reason: err.message,
        });
        return trajectory;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await trajectory.finish({ terminal_state: "ERROR", decline_reason: msg });
      return trajectory;
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
