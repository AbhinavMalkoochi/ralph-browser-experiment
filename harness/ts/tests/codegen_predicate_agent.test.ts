// US-032: codegen-predicate composed agent.
//
// Coverage:
//   - End-to-end on real Chrome with a scripted LLM:
//       * predicate fires after one emitted-JS click → DONE_BY_PREDICATE.
//       * predicate true at start → DONE_BY_PREDICATE before any action.
//       * predicate false through maxSteps → DECLINED.
//       * action body sets {done:true} but predicate false → loop continues
//         (the body's done is IGNORED — code decides termination).
//   - No-LLM declines cleanly during synthesis.
//   - Synthesiser emits unparseable JSON → DECLINED early.
//   - Manifest distinctness vs runtime-codegen AND predicate-driven AND
//     speculative-rollback (Jaccard ≤ 0.5 on approach_keywords).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import CodegenPredicateAgent from "../../../agents/codegen-predicate/agent.js";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Budget } from "../agent/types.js";
import { LLMClient } from "../llm/client.js";
import { parseYaml } from "../verifier/yaml.js";
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
} from "../llm/types.js";

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

interface ScriptedTurn {
  reply: ProviderResponse;
}

function scriptedProvider(turns: ScriptedTurn[]): {
  provider: LLMProvider;
  calls: ProviderRequest[];
} {
  const calls: ProviderRequest[] = [];
  let i = 0;
  const provider: LLMProvider = {
    name: "openai",
    async call(req: ProviderRequest): Promise<ProviderResponse> {
      calls.push(req);
      const turn = turns[Math.min(i, turns.length - 1)];
      if (!turn) throw new Error("scriptedProvider: no turns left");
      i += 1;
      return turn.reply;
    },
  };
  return { provider, calls };
}

test("run: emitted-JS click flips predicate to true → DONE_BY_PREDICATE", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-cp-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cp-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>cp click</title>
<script>window.__clicked = null;</script>
<button onclick="window.__clicked='go'">Continue</button>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const predicateReply = JSON.stringify({
      predicate: "window.__clicked === 'go'",
      rationale: "page records the click in a global",
    });
    const clickScript =
      "const btn = Array.from(document.querySelectorAll('button')).find(b => /Continue/i.test(b.textContent));\n" +
      "if (!btn) return { message: 'no Continue' };\n" +
      "btn.click();\n" +
      "return { message: 'clicked Continue' };";
    const { provider, calls } = scriptedProvider([
      { reply: { text: predicateReply, tokens_in: 60, tokens_out: 30 } },
      { reply: { text: clickScript, tokens_in: 80, tokens_out: 40 } },
    ]);

    const agent = new CodegenPredicateAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "cp-click",
        }),
      maxSteps: 4,
    });
    const traj = await agent.run(
      "click the Continue button",
      session,
      generousBudget(),
      { task_id: "cp-click", seed: 0, runs_root: runsRoot },
    );

    assert.equal(traj.metadata.terminal_state, "DONE_BY_PREDICATE");
    assert.equal(calls.length, 2, "1 synthesis + 1 action");
    const clicked = await session.evaluate<string | null>("window.__clicked");
    assert.equal(clicked, "go");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: Record<string, unknown>;
    }>;
    // step 0: synthesise_predicate; step 1: emit + predicate_satisfied=true
    assert.equal(steps[0]?.action.type, "synthesise_predicate");
    assert.equal(steps[0]?.action.predicate, "window.__clicked === 'go'");
    assert.equal(steps[1]?.action.type, "emit");
    assert.equal(steps[1]?.action.predicate_satisfied, true);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: predicate true at start → DONE_BY_PREDICATE with no action call", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-cp-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cp-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>cp ready</title>
<script>window.__ready = true;</script>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const predicateReply = JSON.stringify({ predicate: "window.__ready === true" });
    const { provider, calls } = scriptedProvider([
      { reply: { text: predicateReply, tokens_in: 30, tokens_out: 10 } },
    ]);
    const agent = new CodegenPredicateAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "cp-ready",
        }),
      maxSteps: 3,
    });
    const traj = await agent.run("nothing to do", session, generousBudget(), {
      task_id: "cp-ready",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE_BY_PREDICATE");
    assert.equal(calls.length, 1, "only the synthesis call");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: action body's done:true is IGNORED — predicate decides termination", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-cp-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cp-"));
  const session = await CdpBrowserSession.create();
  try {
    // The predicate never becomes true; the action body claims done:true
    // every turn. The loop must keep going (and eventually DECLINE) — the
    // LLM does NOT control termination in this agent.
    await session.navigate("data:text/html,%3Ctitle%3Ecp-lie%3C%2Ftitle%3E");
    const predicateReply = JSON.stringify({ predicate: "false" });
    const lyingBody = "return { done: true, message: 'I am totally done' };";
    const { provider, calls } = scriptedProvider([
      { reply: { text: predicateReply, tokens_in: 30, tokens_out: 10 } },
      { reply: { text: lyingBody, tokens_in: 30, tokens_out: 10 } },
    ]);
    const agent = new CodegenPredicateAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "cp-lie",
        }),
      maxSteps: 3,
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "cp-lie",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.match(traj.metadata.decline_reason ?? "", /max steps/);
    // 1 synth + 3 actions = 4 calls (scripted provider clamps to last turn).
    assert.equal(calls.length, 4);

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: Record<string, unknown>;
    }>;
    // Step 0 = synthesise; steps 1..3 = emit. None should claim termination.
    assert.equal(steps[0]?.action.type, "synthesise_predicate");
    const emits = steps.slice(1);
    assert.equal(emits.length, 3, "loop ran the full maxSteps");
    for (const s of emits) {
      assert.equal(s.action.type, "emit");
      assert.equal(s.action.predicate_satisfied, false);
      // The action record does NOT carry a `done` field — the agent strips
      // it deliberately so trajectories cannot confuse readers later.
      assert.equal(s.action.done, undefined);
    }
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: synthesiser emits unparseable JSON → DECLINED early", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-cp-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cp-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Ex%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: "I refuse to emit JSON", tokens_in: 10, tokens_out: 5 } },
    ]);
    const agent = new CodegenPredicateAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "cp-bad-synth",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("x", session, generousBudget(), {
      task_id: "cp-bad-synth",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.match(traj.metadata.decline_reason ?? "", /predicate synthesis failed/);
    assert.equal(calls.length, 1, "only the synthesis call happened");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly during synthesis", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-cp-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cp-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C%2Ftitle%3E");
    const agent = new CodegenPredicateAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "cp-no-llm",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.match(traj.metadata.decline_reason ?? "", /replay miss/i);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("manifest: codegen-predicate distinct_from runtime-codegen, predicate-driven, AND speculative-rollback (Jaccard <= 0.5)", async () => {
  const cpRaw = await readFile(
    new URL("../../../agents/codegen-predicate/manifest.yaml", import.meta.url),
    "utf8",
  );
  const rcgRaw = await readFile(
    new URL("../../../agents/runtime-codegen/manifest.yaml", import.meta.url),
    "utf8",
  );
  const pdRaw = await readFile(
    new URL("../../../agents/predicate-driven/manifest.yaml", import.meta.url),
    "utf8",
  );
  const srbRaw = await readFile(
    new URL("../../../agents/speculative-rollback/manifest.yaml", import.meta.url),
    "utf8",
  );
  const cp = parseYaml(cpRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };
  const rcg = parseYaml(rcgRaw) as { approach_keywords: string[] };
  const pd = parseYaml(pdRaw) as { approach_keywords: string[] };
  const srb = parseYaml(srbRaw) as { approach_keywords: string[] };

  for (const id of ["runtime-codegen", "predicate-driven", "speculative-rollback"]) {
    assert.ok(cp.distinct_from.includes(id), `distinct_from must include ${id}`);
  }
  const jaccard = (a: string[], b: string[]): number => {
    const A = new Set(a.map((k) => k.toLowerCase()));
    const B = new Set(b.map((k) => k.toLowerCase()));
    let inter = 0;
    for (const k of A) if (B.has(k)) inter += 1;
    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
  };
  assert.ok(
    jaccard(cp.approach_keywords, rcg.approach_keywords) <= 0.5,
    "Jaccard vs runtime-codegen must be <= 0.5",
  );
  assert.ok(
    jaccard(cp.approach_keywords, pd.approach_keywords) <= 0.5,
    "Jaccard vs predicate-driven must be <= 0.5",
  );
  assert.ok(
    jaccard(cp.approach_keywords, srb.approach_keywords) <= 0.5,
    "Jaccard vs speculative-rollback must be <= 0.5",
  );
});
