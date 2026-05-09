// Trajectory writer contract test. No browser, no agent — just the file
// format and gzip-on-finish behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Trajectory, trajectoryDir } from "../agent/trajectory.js";

async function readGzipLines(path: string): Promise<unknown[]> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  createReadStream(path).pipe(gunzip);
  for await (const chunk of gunzip) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

test("trajectory writes meta + steps + end and gzips on finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "gba-traj-"));
  try {
    const t = await Trajectory.open(
      { runsRoot: root, agent: "demo", task: "t1", seed: 0 },
      { agent_id: "demo", task_id: "t1", seed: 0 },
    );

    await t.addStep({
      step: 1,
      observation_summary: "saw 0 links",
      action: { type: "noop" },
      latency_ms: 12,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      screenshot_path: null,
      verifier_state: null,
    });
    await t.addStep({
      step: 2,
      observation_summary: "still nothing",
      action: { type: "wait", ms: 100 },
      latency_ms: 100,
      tokens_in: 5,
      tokens_out: 7,
      cost_usd: 0.0001,
      screenshot_path: null,
      verifier_state: { partial: true },
    });

    await t.finish({
      terminal_state: "DECLINED",
      decline_reason: "no work to do",
      verifier_verdict: { pass: false, score: 0, reason: "trivial agent declined" },
    });

    // Raw .jsonl is gone; .gz exists.
    await assert.rejects(() => stat(t.jsonlPath));
    const gzStat = await stat(t.gzPath);
    assert.ok(gzStat.size > 0);

    // The gzipped file decodes to meta + 2 steps + end.
    const lines = await readGzipLines(t.gzPath);
    assert.equal(lines.length, 4);

    const meta = lines[0] as { kind: string; agent_id: string; start_time: string };
    assert.equal(meta.kind, "meta");
    assert.equal(meta.agent_id, "demo");
    assert.match(meta.start_time, /\d{4}-\d{2}-\d{2}T/);

    const step1 = lines[1] as { kind: string; step: number; action: { type: string } };
    assert.equal(step1.kind, "step");
    assert.equal(step1.step, 1);
    assert.equal(step1.action.type, "noop");

    const end = lines[3] as {
      kind: string;
      terminal_state: string;
      verifier_verdict: { pass: boolean };
      decline_reason: string;
    };
    assert.equal(end.kind, "end");
    assert.equal(end.terminal_state, "DECLINED");
    assert.equal(end.verifier_verdict.pass, false);
    assert.equal(end.decline_reason, "no work to do");

    // Directory layout matches runs/<agent>/<task>/<seed>/.
    const expectedDir = trajectoryDir({
      runsRoot: root,
      agent: "demo",
      task: "t1",
      seed: 0,
    });
    assert.equal(t.dir, expectedDir);
    const entries = await readdir(t.dir);
    assert.deepEqual(entries.sort(), ["trajectory.jsonl.gz"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trajectory.addStep after finish throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "gba-traj-"));
  try {
    const t = await Trajectory.open(
      { runsRoot: root, agent: "demo", task: "t2", seed: 0 },
      { agent_id: "demo", task_id: "t2", seed: 0 },
    );
    await t.finish({ terminal_state: "DONE" });
    await assert.rejects(
      () =>
        t.addStep({
          step: 1,
          observation_summary: "after",
          action: { type: "noop" },
          latency_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          screenshot_path: null,
          verifier_state: null,
        }),
      /already finished/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trajectory.finish is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "gba-traj-"));
  try {
    const t = await Trajectory.open(
      { runsRoot: root, agent: "demo", task: "t3", seed: 0 },
      { agent_id: "demo", task_id: "t3", seed: 0 },
    );
    await t.finish({ terminal_state: "DONE" });
    await t.finish({ terminal_state: "DONE" }); // should not throw
    const lines = await readGzipLines(t.gzPath);
    assert.equal(lines.filter((l) => (l as { kind: string }).kind === "end").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
