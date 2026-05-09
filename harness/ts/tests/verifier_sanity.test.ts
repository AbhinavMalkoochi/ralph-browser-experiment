// Sanity test for the verifier framework (US-005 AC #5):
//   - The trivial 'click first link' agent FAILS a task whose verifier checks
//     for a specific `window.__test.success` flag set by clicking a button
//     that is NOT the first <a>.
//   - A hand-written 'cheat' agent (knows about the button) PASSES the same
//     task.
//
// Both runs use a real Chrome via CdpBrowserSession, a real fixture page
// served from a localhost http server (so the verifier's window.__test
// flag survives a navigation away → its absence becomes the failure
// signal), and the JsVerifier through the verify() entrypoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Trajectory } from "../agent/trajectory.js";
import { Budget, type BrowserSession } from "../agent/types.js";
import ClickFirstLinkAgent from "../../../agents/click-first-link/agent.js";
import { Agent, type AgentContext } from "../agent/agent.js";
import { verify } from "../verifier/runner.js";
import type { Task } from "../verifier/types.js";

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/** Two-page fixture: / has a decoy <a> + a completion button; /decoy is the trap. */
async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
<html><head><title>start</title></head>
<body>
  <a id="trap" href="/decoy">a decoy link</a>
  <button id="completion">complete</button>
  <script>
    document.getElementById('completion').addEventListener('click', () => {
      window.__test = window.__test || {};
      window.__test.success = true;
      document.title = 'completed';
    });
  </script>
</body></html>`);
      return;
    }
    if (req.url === "/decoy") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>decoy</title><body>nothing here</body>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

class CheatAgent extends Agent {
  readonly id = "cheat-completion";
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
    await browser.evaluate("document.getElementById('completion').click()");
    budget.recordStep();
    budget.check();
    await trajectory.addStep({
      step: 1,
      observation_summary: "clicked #completion",
      action: { type: "click", selector: "#completion" },
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

function buildTask(startUrl: string): Task {
  return {
    id: "completion-button",
    goal: "Click the completion button so window.__test.success is true",
    start_url: startUrl,
    difficulty: "easy",
    tags: ["js_verifier", "smoke"],
    verifier: {
      kind: "js",
      expression: "Boolean(window.__test && window.__test.success === true)",
    },
  };
}

const generousBudget = (): Budget =>
  new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 50 });

test("verifier sanity: trivial agent FAILS the completion-button task", async () => {
  const fixture = await startFixtureServer();
  const session = await CdpBrowserSession.create();
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const task = buildTask(fixture.origin + "/");
    await session.navigate(task.start_url);
    const agent = new ClickFirstLinkAgent();
    const traj = await agent.run(task.goal, session, generousBudget(), {
      task_id: task.id,
      seed: 0,
      runs_root: runsRoot,
    });
    // Trivial agent navigated to /decoy. Re-open a verifier-only trajectory
    // to record the verdict (the agent's trajectory is already finished).
    const verifierTraj = await Trajectory.open(
      { runsRoot, agent: "verifier-only", task: task.id, seed: 0 },
      { agent_id: "verifier-only", task_id: task.id, seed: 0 },
    );
    const verdict = await verify(task, {
      browser: session,
      trajectory: verifierTraj,
    });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 0);

    await verifierTraj.finish({ terminal_state: "DONE" });

    // Sidecar landed in the verifier-only dir.
    const sidecar = JSON.parse(await readFile(join(verifierTraj.dir, "verdict.json"), "utf8"));
    assert.equal(sidecar.pass, false);
    // The trivial agent itself terminated on DONE (it thought it was done).
    assert.equal(traj.metadata.terminal_state, "DONE");
  } finally {
    await session.close();
    await fixture.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("verifier sanity: cheat agent PASSES the completion-button task", async () => {
  const fixture = await startFixtureServer();
  const session = await CdpBrowserSession.create();
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const task = buildTask(fixture.origin + "/");
    await session.navigate(task.start_url);
    const agent = new CheatAgent();
    const traj = await agent.run(task.goal, session, generousBudget(), {
      task_id: task.id,
      seed: 0,
      runs_root: runsRoot,
    });
    // Reuse the cheat agent's still-open browser; verifier reads window.__test.
    const verdict = await verify(task, {
      browser: session,
      trajectory: null,
      trajectoryDir: traj.dir,
    });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 1);

    // Sidecar landed alongside the cheat agent's trajectory.
    const sidecar = JSON.parse(await readFile(join(traj.dir, "verdict.json"), "utf8"));
    assert.equal(sidecar.pass, true);
  } finally {
    await session.close();
    await fixture.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("verifier sanity: js verifier returning Verdict object is forwarded", async () => {
  const fixture = await startFixtureServer();
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(fixture.origin + "/");
    const task: Task = {
      id: "obj-return",
      goal: "obj-return",
      start_url: fixture.origin + "/",
      difficulty: "easy",
      tags: ["js_verifier"],
      verifier: {
        kind: "js",
        expression:
          "({ pass: true, score: 0.7, reason: 'good enough for a sanity check' })",
      },
    };
    const verdict = await verify(task, { browser: session }, { writeAuditFile: false });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 0.7);
    assert.equal(verdict.reason, "good enough for a sanity check");
  } finally {
    await session.close();
    await fixture.close();
  }
});

test("verifier sanity: js verifier exception -> pass=false with reason", async () => {
  const fixture = await startFixtureServer();
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(fixture.origin + "/");
    const task: Task = {
      id: "throw",
      goal: "throw",
      start_url: fixture.origin + "/",
      difficulty: "easy",
      tags: ["js_verifier"],
      verifier: {
        kind: "js",
        expression: "(() => { throw new Error('verifier-boom'); })()",
      },
    };
    const verdict = await verify(task, { browser: session }, { writeAuditFile: false });
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /verifier-boom/);
  } finally {
    await session.close();
    await fixture.close();
  }
});
