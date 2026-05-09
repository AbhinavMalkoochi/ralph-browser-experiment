// Cross-language Agent contract test. Spawns the Python click-first-link-py
// agent over the stdio JSON-RPC bridge and asserts that the resulting
// trajectory file matches the TS sibling's behaviour. Browser RPCs are
// satisfied by canned responses so this test does not need real Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import { Trajectory, trajectoryDir } from "../agent/trajectory.js";
import { PythonAgentBridge, runPythonAgent } from "../agent/python_bridge.js";
import { Budget, type BrowserSession } from "../agent/types.js";

async function readGzipLines(path: string): Promise<unknown[]> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  createReadStream(path).pipe(gunzip);
  for await (const chunk of gunzip) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

class FakeBrowserSession implements BrowserSession {
  readonly id = "fake";
  // The python_bridge only proxies the high-level methods; cdp is unused here.
  // The interface requires it, but the python agent never reaches for it.
  readonly cdp = null as unknown as BrowserSession["cdp"];
  readonly navigated: string[] = [];
  readonly evaluated: string[] = [];
  evaluateFn: (expr: string) => unknown;

  constructor(evaluateFn: (expr: string) => unknown) {
    this.evaluateFn = evaluateFn;
  }

  async navigate(url: string): Promise<void> {
    this.navigated.push(url);
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    this.evaluated.push(expression);
    return this.evaluateFn(expression) as T;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from([]);
  }
}

const PY_AGENT_PATH = resolve(process.cwd(), "agents/click-first-link-py/agent.py");
const VENV_PYTHON = resolve(process.cwd(), ".venv/bin/python");
const HAS_PYTHON = existsSync(VENV_PYTHON);

test("python bridge: click-first-link-py declines on empty link list", { skip: !HAS_PYTHON }, async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-pyruns-"));
  const browser = new FakeBrowserSession((expr) => {
    if (expr.includes("querySelectorAll('a')")) return [];
    return null;
  });
  const budget = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 50 });
  const traj = await Trajectory.open(
    { runsRoot, agent: "click-first-link-py", task: "empty", seed: 0 },
    { agent_id: "click-first-link-py", task_id: "empty", seed: 0 },
  );

  const bridge = PythonAgentBridge.spawn({ agentPath: PY_AGENT_PATH });
  try {
    await runPythonAgent({
      bridge,
      agentId: "click-first-link-py",
      goal: "find a link",
      browser,
      budget,
      trajectory: traj,
      ctx: { task_id: "empty", seed: 0, runs_root: runsRoot },
    });
  } finally {
    await bridge.close();
  }

  assert.equal(traj.metadata.terminal_state, "DECLINED");
  assert.equal(traj.metadata.decline_reason, "no links on page");
  assert.equal(
    traj.dir,
    trajectoryDir({ runsRoot, agent: "click-first-link-py", task: "empty", seed: 0 }),
  );
  await assert.doesNotReject(() => stat(traj.gzPath));
  await assert.rejects(() => access(traj.jsonlPath));

  const lines = await readGzipLines(traj.gzPath);
  assert.equal(lines.length, 3); // meta + 1 step + end
  await rm(runsRoot, { recursive: true, force: true });
});

test("python bridge: click-first-link-py clicks first link (DONE)", { skip: !HAS_PYTHON }, async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-pyruns-"));
  let assignedHref: string | null = null;
  const browser = new FakeBrowserSession((expr) => {
    if (expr.includes("querySelectorAll('a')"))
      return ["https://example.com/a", "https://example.com/b"];
    const m = expr.match(/window\.location\.href = "(.+)"/);
    if (m) {
      assignedHref = m[1] as string;
      return null;
    }
    return null;
  });
  const budget = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 50 });
  const traj = await Trajectory.open(
    { runsRoot, agent: "click-first-link-py", task: "click", seed: 0 },
    { agent_id: "click-first-link-py", task_id: "click", seed: 0 },
  );

  const bridge = PythonAgentBridge.spawn({ agentPath: PY_AGENT_PATH });
  try {
    await runPythonAgent({
      bridge,
      agentId: "click-first-link-py",
      goal: "click",
      browser,
      budget,
      trajectory: traj,
      ctx: { task_id: "click", seed: 0, runs_root: runsRoot },
    });
  } finally {
    await bridge.close();
  }

  assert.equal(traj.metadata.terminal_state, "DONE");
  assert.equal(assignedHref, "https://example.com/a");
  const lines = await readGzipLines(traj.gzPath);
  const step = lines[1] as { kind: string; action: { type: string; href: string } };
  assert.equal(step.kind, "step");
  assert.equal(step.action.type, "click_link");
  assert.equal(step.action.href, "https://example.com/a");
  await rm(runsRoot, { recursive: true, force: true });
});
