// US-012: contract test runs each agent on a 1-task dry slice and rejects
// agents that don't produce a valid Trajectory.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { discoverAgents } from "../tournament/discovery.js";
import { runContractTest } from "../tournament/contract.js";
import type { BrowserSession } from "../agent/types.js";

class FakeBrowserSession implements BrowserSession {
  readonly id = "fake";
  readonly cdp = null as unknown as BrowserSession["cdp"];
  readonly evaluated: string[] = [];
  evaluateFn: (expr: string) => unknown;

  constructor(evaluateFn: (expr: string) => unknown = () => null) {
    this.evaluateFn = evaluateFn;
  }
  async navigate(_url: string): Promise<void> {}
  async evaluate<T = unknown>(expression: string): Promise<T> {
    this.evaluated.push(expression);
    return this.evaluateFn(expression) as T;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from([]);
  }
}

const VENV_PYTHON = resolve(process.cwd(), ".venv/bin/python");
const HAS_PYTHON = existsSync(VENV_PYTHON);

test("runContractTest: live click-first-link agents pass with a fake browser", async () => {
  const agents = await discoverAgents({
    filterIds: HAS_PYTHON ? ["click-first-link", "click-first-link-py"] : ["click-first-link"],
  });
  assert.ok(agents.length >= 1, `expected at least one live agent; got ${agents.length}`);
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-contract-"));
  try {
    const results = await runContractTest({
      agents,
      runsRoot,
      // Click-first-link's evaluate returns a string[] of links and then a
      // navigation expression. Returning [] makes the agent DECLINE.
      browserFactory: async () => new FakeBrowserSession(() => []),
    });
    assert.equal(results.length, agents.length);
    for (const r of results) {
      assert.ok(r.ok, `agent ${r.agent_id} failed contract: ${r.reason}`);
      assert.ok(
        r.terminal_state !== null,
        `agent ${r.agent_id} produced no terminal_state`,
      );
    }
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("runContractTest: catches agent.run() that returns a non-Trajectory (TS)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gba-bad-agent-"));
  try {
    const dir = join(tmp, "agents", "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.yaml"),
      "id: bad\nlanguage: typescript\nsummary: returns nothing\napproach_keywords: []\ndistinct_from: []\n",
    );
    // run() returns null instead of a Trajectory.
    await writeFile(
      join(dir, "agent.ts"),
      "export default class { async run() { return null; } }\n",
    );
    const agents = await discoverAgents({ agentsDir: join(tmp, "agents") });
    assert.equal(agents.length, 1);
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-contract-"));
    try {
      const results = await runContractTest({
        agents,
        runsRoot,
        browserFactory: async () => new FakeBrowserSession(),
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, false);
      assert.match(results[0]!.reason, /Trajectory-like/);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runContractTest: catches default export that has no run()", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gba-norun-agent-"));
  try {
    const dir = join(tmp, "agents", "norun");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.yaml"),
      "id: norun\nlanguage: typescript\nsummary: missing run\napproach_keywords: []\ndistinct_from: []\n",
    );
    // No run() method at all.
    await writeFile(join(dir, "agent.ts"), "export default class {}\n");
    const agents = await discoverAgents({ agentsDir: join(tmp, "agents") });
    assert.equal(agents.length, 1);
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-contract-"));
    try {
      const results = await runContractTest({
        agents,
        runsRoot,
        browserFactory: async () => new FakeBrowserSession(),
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, false);
      assert.match(results[0]!.reason, /does not implement run/);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runContractTest: catches agent that returns an unfinished Trajectory (TS)", async () => {
  // We can construct this by importing the actual Agent + Trajectory
  // into a tmpdir agent. To keep the import path stable across the
  // tmp/repo boundary we use a relative path computed at write time.
  const repoRoot = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), "gba-unfinished-agent-"));
  try {
    const dir = join(tmp, "agents", "unfinished");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.yaml"),
      "id: unfinished\nlanguage: typescript\nsummary: opens trajectory but never finishes\napproach_keywords: []\ndistinct_from: []\n",
    );
    const { relative } = await import("node:path");
    const agentJs = relative(dir, join(repoRoot, "harness/ts/agent/agent.js")).replace(/\\/g, "/");
    const trajJs = relative(dir, join(repoRoot, "harness/ts/agent/trajectory.js")).replace(/\\/g, "/");
    const src = `
import { Agent } from "${agentJs}";
import { Trajectory } from "${trajJs}";
export default class UnfinishedAgent extends Agent {
  id = "unfinished";
  async run(_goal, _browser, _budget, ctx) {
    return await Trajectory.open(
      { runsRoot: ctx.runs_root, agent: this.id, task: ctx.task_id, seed: ctx.seed },
      { agent_id: this.id, task_id: ctx.task_id, seed: ctx.seed },
    );
  }
}
`;
    await writeFile(join(dir, "agent.ts"), src);
    const agents = await discoverAgents({ agentsDir: join(tmp, "agents") });
    assert.equal(agents.length, 1);
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-contract-"));
    try {
      const results = await runContractTest({
        agents,
        runsRoot,
        browserFactory: async () => new FakeBrowserSession(),
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, false);
      assert.match(results[0]!.reason, /unfinished Trajectory/);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("runContractTest: catches agent whose trajectory.agent_id mismatches (TS)", async () => {
  const repoRoot = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), "gba-mismatch-agent-"));
  try {
    const dir = join(tmp, "agents", "mismatch-agent");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.yaml"),
      "id: mismatch-agent\nlanguage: typescript\nsummary: agent that lies about its id in the trajectory\napproach_keywords: []\ndistinct_from: []\n",
    );
    const { relative } = await import("node:path");
    const agentJs = relative(dir, join(repoRoot, "harness/ts/agent/agent.js")).replace(/\\/g, "/");
    const trajJs = relative(dir, join(repoRoot, "harness/ts/agent/trajectory.js")).replace(/\\/g, "/");
    const src = `
import { Agent } from "${agentJs}";
import { Trajectory } from "${trajJs}";
export default class Liar extends Agent {
  id = "mismatch-agent";
  async run(_goal, _browser, _budget, ctx) {
    const t = await Trajectory.open(
      { runsRoot: ctx.runs_root, agent: this.id, task: ctx.task_id, seed: ctx.seed },
      { agent_id: "lies-about-id", task_id: ctx.task_id, seed: ctx.seed },
    );
    await t.finish({ terminal_state: "DECLINED", decline_reason: "x" });
    return t;
  }
}
`;
    await writeFile(join(dir, "agent.ts"), src);
    const agents = await discoverAgents({ agentsDir: join(tmp, "agents") });
    assert.equal(agents.length, 1);
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-contract-"));
    try {
      const results = await runContractTest({
        agents,
        runsRoot,
        browserFactory: async () => new FakeBrowserSession(),
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, false);
      assert.match(results[0]!.reason, /agent_id mismatch/);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("AC #5: dropping a no-op agent under agents/ requires no edits outside that dir", async () => {
  // Simulate a researcher creating a brand-new agent dir. We do this in a
  // tmpdir to avoid polluting agents/, but the dir layout is identical to
  // what the convention requires: manifest.yaml + agent.ts. discoverAgents
  // picks it up; runContractTest exercises it end-to-end. Nothing else
  // (registries, imports, indexes) is touched.
  const repoRoot = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), "gba-noop-agent-"));
  try {
    const dir = join(tmp, "agents", "noop-demo");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.yaml"),
      [
        "id: noop-demo",
        "language: typescript",
        "summary: |",
        "  Minimal contract-only agent: opens a trajectory and finishes",
        "  with DECLINED. Used by US-012's auto-discovery test to prove",
        "  that adding a new agent requires zero edits outside its dir.",
        "approach_keywords:",
        "  - noop",
        "distinct_from: []",
        "",
      ].join("\n"),
    );
    await writeFile(join(dir, "README.md"), "# noop-demo\n\nContract-only test agent.\n");
    const { relative } = await import("node:path");
    const agentJs = relative(dir, join(repoRoot, "harness/ts/agent/agent.js")).replace(/\\/g, "/");
    const trajJs = relative(dir, join(repoRoot, "harness/ts/agent/trajectory.js")).replace(/\\/g, "/");
    const src = `
import { Agent } from "${agentJs}";
import { Trajectory } from "${trajJs}";
export default class NoopAgent extends Agent {
  id = "noop-demo";
  async run(_goal, _browser, _budget, ctx) {
    const t = await Trajectory.open(
      { runsRoot: ctx.runs_root, agent: this.id, task: ctx.task_id, seed: ctx.seed },
      { agent_id: this.id, task_id: ctx.task_id, seed: ctx.seed },
    );
    await t.finish({ terminal_state: "DECLINED", decline_reason: "noop" });
    return t;
  }
}
`;
    await writeFile(join(dir, "agent.ts"), src);

    // Discovery sees it without any other repo state.
    const agents = await discoverAgents({ agentsDir: join(tmp, "agents") });
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.id, "noop-demo");
    assert.equal(agents[0]!.language, "typescript");

    // Contract test runs it end-to-end.
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-contract-"));
    try {
      const results = await runContractTest({
        agents,
        runsRoot,
        browserFactory: async () => new FakeBrowserSession(),
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.ok, true, `noop-demo failed: ${results[0]!.reason}`);
      assert.equal(results[0]!.terminal_state, "DECLINED");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test(
  "AC #5: Python no-op agent in a tmpdir works end-to-end",
  { skip: !HAS_PYTHON },
  async () => {
    const tmp = await mkdtemp(join(tmpdir(), "gba-noop-py-agent-"));
    try {
      const dir = join(tmp, "agents", "noop-py-demo");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "manifest.yaml"),
        [
          "id: noop-py-demo",
          "language: python",
          "summary: |",
          "  Cross-language no-op agent for the auto-discovery contract test.",
          "approach_keywords:",
          "  - noop",
          "  - cross_language",
          "distinct_from: []",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(dir, "agent.py"),
        [
          "from gba_agent import Agent",
          "",
          "class NoopAgent(Agent):",
          "    id = 'noop-py-demo'",
          "    def run(self, goal, browser, budget, trajectory, ctx):",
          "        trajectory.finish(terminal_state='DECLINED', decline_reason='noop')",
          "",
          "AGENT_CLASS = NoopAgent",
          "",
        ].join("\n"),
      );
      const agents = await discoverAgents({ agentsDir: join(tmp, "agents") });
      assert.equal(agents.length, 1);
      assert.equal(agents[0]!.id, "noop-py-demo");
      assert.equal(agents[0]!.language, "python");
      const runsRoot = await mkdtemp(join(tmpdir(), "gba-contract-"));
      try {
        const results = await runContractTest({
          agents,
          runsRoot,
          browserFactory: async () => new FakeBrowserSession(),
        });
        assert.equal(results.length, 1);
        assert.equal(results[0]!.ok, true, `noop-py-demo failed: ${results[0]!.reason}`);
        assert.equal(results[0]!.terminal_state, "DECLINED");
      } finally {
        await rm(runsRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);
