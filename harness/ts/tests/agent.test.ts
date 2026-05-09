// End-to-end contract test: trivial TS agent runs against real Chrome and
// produces a valid trajectory artefact. Covers:
//   - Agent.run signature
//   - BrowserSession.evaluate against a data: URL with a known link
//   - Trajectory file lands at runs/<agent>/<task>/<seed>/trajectory.jsonl.gz
//   - terminal_state recorded correctly for both branches (DONE / DECLINED)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import { CdpBrowserSession } from "../agent/browser_session.js";
import ClickFirstLinkAgent from "../../../agents/click-first-link/agent.js";
import { Budget } from "../agent/types.js";
import { trajectoryDir } from "../agent/trajectory.js";

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

const generousBudget = (): Budget =>
  new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 50 });

test("ClickFirstLinkAgent on about:blank declines (no links)", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("about:blank");
    const agent = new ClickFirstLinkAgent();
    const traj = await agent.run("find the only link", session, generousBudget(), {
      task_id: "about-blank",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.agent_id, "click-first-link");
    assert.equal(traj.metadata.task_id, "about-blank");
    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.equal(traj.metadata.decline_reason, "no links on page");

    assert.equal(
      traj.dir,
      trajectoryDir({ runsRoot, agent: "click-first-link", task: "about-blank", seed: 0 }),
    );
    const gz = await stat(traj.gzPath);
    assert.ok(gz.size > 0);

    const lines = await readGzipLines(traj.gzPath);
    assert.equal(lines.length, 3); // meta + 1 step + end
    const step = lines[1] as { kind: string; action: { type: string } };
    assert.equal(step.kind, "step");
    assert.equal(step.action.type, "noop");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("ClickFirstLinkAgent clicks first link on a fixture page (DONE)", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>fix</title><a id="primary" href="https://example.com/target">go</a><a href="https://example.com/secondary">two</a>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const agent = new ClickFirstLinkAgent();
    const traj = await agent.run("click the primary link", session, generousBudget(), {
      task_id: "two-links",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(traj.stepCount, 1);
    const step = traj.snapshotSteps()[0];
    assert.ok(step);
    assert.equal(step.action.type, "click_link");
    assert.equal(step.action.href, "https://example.com/target");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("Budget.check throws BudgetExceeded; agent records BUDGET_EXCEEDED", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><a href="https://example.com/x">x</a>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const agent = new ClickFirstLinkAgent();
    // Step budget = 0 so the very first recordStep+check trips it.
    const tightBudget = new Budget({
      tokens: 100_000,
      usd: 1,
      wallSeconds: 60,
      steps: 0,
    });
    const traj = await agent.run("anything", session, tightBudget, {
      task_id: "budget-tight",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "BUDGET_EXCEEDED");
    assert.match(traj.metadata.decline_reason ?? "", /steps/);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});
