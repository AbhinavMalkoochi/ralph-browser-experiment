// Chrome-driven sanity tests for the US-006 hard fixtures.
//
// For each of the three fixtures we assert:
//   - the trivial click-first-link agent leaves the page in a state the
//     verifier reports as pass=false (no anchors to click + no side-effect)
//   - a hand-written cheat agent that knows the page's API leaves the page
//     in a state the verifier reports as pass=true
//
// The cheat agents are not full agents under agents/ — they're inline
// closures here that bypass the hostile UI directly via JS (shadow root
// traversal, synthetic mouse events on the canvas, programmatic scrollTop).
// Their job is to demonstrate that the verifier accepts a correctly-
// completed task; the AC-required failure half is covered by trivial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Trajectory } from "../agent/trajectory.js";
import { Budget, type BrowserSession } from "../agent/types.js";
import { Agent, type AgentContext } from "../agent/agent.js";
import { startFixturesServer, resolveFixtureUrl } from "../../../tasks/fixtures/server.js";
import { loadTaskFile } from "../verifier/loader.js";
import { verify } from "../verifier/runner.js";
import ClickFirstLinkAgent from "../../../agents/click-first-link/agent.js";

const generousBudget = (): Budget =>
  new Budget({ tokens: 100_000, usd: 1, wallSeconds: 120, steps: 50 });

interface FixtureCase {
  taskFile: string;
  taskKey: string;
  cheat: (browser: BrowserSession) => Promise<void>;
}

const FIXTURES: FixtureCase[] = [
  {
    taskFile: "tasks/suite/hard/shadow-form.yaml",
    taskKey: "shadow-form",
    cheat: async (browser) => {
      // Traverse the open shadow root, fill the three fields, click submit,
      // wait for the fetch to land server-side.
      await browser.evaluate(`(async () => {
        const host = document.querySelector('shadow-form');
        const root = host.shadowRoot;
        root.getElementById('username').value = 'alice';
        root.getElementById('email').value = 'alice@example.com';
        root.getElementById('tier').value = 'gold';
        const submitted = new Promise(r => {
          const o = new MutationObserver(() => {
            if (document.title === 'submitted') { o.disconnect(); r(); }
          });
          o.observe(document.querySelector('title') || document.head, {
            characterData: true, childList: true, subtree: true,
          });
          // Fallback in case title mutation observer misses.
          setTimeout(() => r(), 1500);
        });
        root.getElementById('submit').click();
        await submitted;
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/canvas-drag.yaml",
    taskKey: "canvas-drag",
    cheat: async (browser) => {
      // Read the layout snapshot, dispatch synthetic mouse events on the
      // canvas to drag node A onto node B's centre.
      await browser.evaluate(`(async () => {
        const layout = window.__test.meta.layout;
        const canvas = document.getElementById('board');
        const r = canvas.getBoundingClientRect();
        const fire = (type, x, y) => canvas.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true,
          clientX: r.left + x, clientY: r.top + y,
          button: 0, buttons: type === 'mouseup' ? 0 : 1,
        }));
        fire('mousedown', layout.A.x, layout.A.y);
        // Move in a few steps so the dragging branch is exercised.
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = layout.A.x + (layout.B.x - layout.A.x) * t;
          const y = layout.A.y + (layout.B.y - layout.A.y) * t;
          fire('mousemove', x, y);
        }
        fire('mouseup', layout.B.x, layout.B.y);
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/virtual-scroll.yaml",
    taskKey: "virtual-scroll",
    cheat: async (browser) => {
      // Programmatically scroll until target-247 mounts, then click its button.
      await browser.evaluate(`(async () => {
        const feed = document.getElementById('feed');
        const targetIdx = 247;
        feed.scrollTop = targetIdx * window.__test.rowHeight - 100;
        // Two RAFs to let the scroll handler render.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const btn = document.querySelector('button[data-id="target-247"]');
        if (!btn) throw new Error('target-247 not mounted after scroll');
        btn.click();
      })()`);
    },
  },
];

class CheatAgent extends Agent {
  readonly id: string;
  constructor(private readonly fn: (b: BrowserSession) => Promise<void>, id: string) {
    super();
    this.id = id;
  }
  async run(
    _goal: string,
    browser: BrowserSession,
    budget: Budget,
    ctx: AgentContext,
  ): Promise<Trajectory> {
    const trajectory = await Trajectory.open(
      { runsRoot: ctx.runs_root, agent: this.id, task: ctx.task_id, seed: ctx.seed },
      { agent_id: this.id, task_id: ctx.task_id, seed: ctx.seed },
    );
    const t0 = Date.now();
    await this.fn(browser);
    budget.recordStep();
    budget.check();
    await trajectory.addStep({
      step: 1,
      observation_summary: `cheat:${this.id}`,
      action: { type: "cheat" },
      latency_ms: Date.now() - t0,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      screenshot_path: null,
      verifier_state: null,
    });
    await trajectory.finish({ terminal_state: "DONE" });
    return trajectory;
  }
}

for (const fx of FIXTURES) {
  test(`fixture ${fx.taskKey}: trivial agent FAILS`, async () => {
    const server = await startFixturesServer();
    const session = await CdpBrowserSession.create();
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
    try {
      const task = await loadTaskFile(join(process.cwd(), fx.taskFile));
      const startUrl = resolveFixtureUrl(task.start_url, server.origin);
      await session.navigate(startUrl);
      const traj = await new ClickFirstLinkAgent().run(task.goal, session, generousBudget(), {
        task_id: task.id,
        seed: 0,
        runs_root: runsRoot,
      });
      const verdict = await verify(
        task,
        { browser: session, trajectory: null, trajectoryDir: traj.dir },
        { recordIntoTrajectory: false },
      );
      assert.equal(verdict.pass, false, `expected trivial agent to fail ${fx.taskKey}; got ${verdict.reason}`);
    } finally {
      await session.close();
      await server.close();
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  test(`fixture ${fx.taskKey}: cheat agent PASSES`, async () => {
    const server = await startFixturesServer();
    const session = await CdpBrowserSession.create();
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
    try {
      const task = await loadTaskFile(join(process.cwd(), fx.taskFile));
      const startUrl = resolveFixtureUrl(task.start_url, server.origin);
      await session.navigate(startUrl);
      const cheat = new CheatAgent(fx.cheat, `cheat-${fx.taskKey}`);
      const traj = await cheat.run(task.goal, session, generousBudget(), {
        task_id: task.id,
        seed: 0,
        runs_root: runsRoot,
      });
      const verdict = await verify(
        task,
        { browser: session, trajectory: null, trajectoryDir: traj.dir },
        { recordIntoTrajectory: false },
      );
      assert.equal(verdict.pass, true, `expected cheat agent to pass ${fx.taskKey}; got ${verdict.reason}`);
      assert.ok(verdict.score > 0);
    } finally {
      await session.close();
      await server.close();
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
}
