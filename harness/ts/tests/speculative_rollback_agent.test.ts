// US-016: speculative-rollback agent.
//
// Coverage:
//   - parseCandidates: envelope, bare array, single object, ```json fences,
//     leading prose, action-wrapper variant, unknown type rejection,
//     missing-selector rejection, empty-list rejection.
//   - parseJudge: verdict commit/revert/done parsed; invalid verdict rejected;
//     fenced JSON tolerated.
//   - captureState / restoreState round-trip on real Chrome (URL + storage).
//   - End-to-end run on real Chrome with a scripted dual-LLM (proposer + judge):
//       * single candidate, judge commits, click recorded, finishes DONE
//         on the second step.
//       * first candidate reverted by the judge, second candidate commits;
//         restore was actually invoked (trajectory has a revert + restore).
//       * judge says done immediately after first action.
//   - parse_error path (proposer emits non-JSON) does not abort the loop.
//   - No-LLM (replay-only client) declines cleanly.
//   - Tight steps budget short-circuits to BUDGET_EXCEEDED.
//   - Manifest distinctness vs baseline, plan-then-execute, AND runtime-codegen
//     with zero keyword overlap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import SpeculativeRollbackAgent from "../../../agents/speculative-rollback/agent.js";
import { parseJudge } from "../../../agents/speculative-rollback/agent.js";
import {
  ActionParseError,
  parseCandidates,
} from "../../../agents/speculative-rollback/actions.js";
import {
  captureState,
  restoreState,
} from "../../../agents/speculative-rollback/snapshot.js";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Budget } from "../agent/types.js";
import { LLMClient } from "../llm/client.js";
import { parseYaml } from "../verifier/yaml.js";
import { startFixturesServer } from "../../../tasks/fixtures/server.js";
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

// -----------------------------------------------------------------------------
// parseCandidates
// -----------------------------------------------------------------------------

test("parseCandidates: envelope with multiple candidates", () => {
  const raw = `{"candidates":[
    {"type":"click","selector":"button#a","rationale":"first"},
    {"type":"type","selector":"input[name='x']","text":"hi","submit":true,"rationale":"second"}
  ]}`;
  const list = parseCandidates(raw);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { type: "click", selector: "button#a", rationale: "first" });
  assert.deepEqual(list[1], {
    type: "type",
    selector: "input[name='x']",
    text: "hi",
    submit: true,
    rationale: "second",
  });
});

test("parseCandidates: bare array works", () => {
  const list = parseCandidates(`[{"type":"click","selector":"a.go"}]`);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.type, "click");
});

test("parseCandidates: single object treated as one-candidate list", () => {
  const list = parseCandidates(`{"type":"finish","reason":"done"}`);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { type: "finish", reason: "done" });
});

test("parseCandidates: ```json fence stripped", () => {
  const list = parseCandidates('```json\n{"candidates":[{"type":"wait","ms":300}]}\n```');
  assert.equal(list.length, 1);
  assert.equal(list[0]?.type, "wait");
});

test("parseCandidates: leading prose tolerated", () => {
  const list = parseCandidates(
    "Sure, here are the candidates:\n[{\"type\":\"scroll\",\"direction\":\"down\",\"pixels\":500}]",
  );
  assert.equal(list.length, 1);
  assert.equal(list[0]?.type, "scroll");
});

test("parseCandidates: action-wrapper variant works", () => {
  const list = parseCandidates(
    `{"candidates":[{"action":{"type":"click","selector":"#go"},"rationale":"why"}]}`,
  );
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { type: "click", selector: "#go", rationale: "why" });
});

test("parseCandidates: unknown type rejected", () => {
  assert.throws(
    () => parseCandidates(`[{"type":"telepathy","target":"x"}]`),
    (err: unknown) =>
      err instanceof ActionParseError && /unknown type/.test((err as Error).message),
  );
});

test("parseCandidates: click without selector rejected", () => {
  assert.throws(
    () => parseCandidates(`[{"type":"click"}]`),
    (err: unknown) =>
      err instanceof ActionParseError && /missing selector/.test((err as Error).message),
  );
});

test("parseCandidates: empty list rejected", () => {
  assert.throws(
    () => parseCandidates(`{"candidates":[]}`),
    (err: unknown) =>
      err instanceof ActionParseError && /empty/.test((err as Error).message),
  );
});

test("parseCandidates: empty string rejected", () => {
  assert.throws(
    () => parseCandidates(""),
    (err: unknown) => err instanceof ActionParseError,
  );
});

test("parseCandidates: wait clamps and accepts seconds", () => {
  const list = parseCandidates(`[{"type":"wait","seconds":2}]`);
  assert.equal(list[0]?.type, "wait");
  if (list[0]?.type === "wait") assert.equal(list[0].ms, 2000);

  const huge = parseCandidates(`[{"type":"wait","ms":999999}]`);
  if (huge[0]?.type === "wait") assert.equal(huge[0].ms, 10_000);
});

test("parseCandidates: scroll defaults to down and clamps negative pixels to 0", () => {
  const list = parseCandidates(`[{"type":"scroll","direction":"sideways","pixels":-50}]`);
  if (list[0]?.type === "scroll") {
    assert.equal(list[0].direction, "down");
    assert.equal(list[0].pixels, 0);
  }
});

// -----------------------------------------------------------------------------
// parseJudge
// -----------------------------------------------------------------------------

test("parseJudge: commit verdict", () => {
  const j = parseJudge(`{"verdict":"commit","reason":"new section visible"}`);
  assert.equal(j.verdict, "commit");
  assert.match(j.reason, /new section/);
});

test("parseJudge: revert verdict", () => {
  const j = parseJudge(`{"verdict":"revert","reason":"error banner appeared"}`);
  assert.equal(j.verdict, "revert");
});

test("parseJudge: done verdict", () => {
  const j = parseJudge(`{"verdict":"done","reason":"submission accepted"}`);
  assert.equal(j.verdict, "done");
});

test("parseJudge: ```json fence stripped", () => {
  const j = parseJudge('```json\n{"verdict":"commit","reason":"ok"}\n```');
  assert.equal(j.verdict, "commit");
});

test("parseJudge: invalid verdict rejected", () => {
  assert.throws(
    () => parseJudge(`{"verdict":"unsure","reason":"hmm"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /commit\|revert\|done/.test((err as Error).message),
  );
});

test("parseJudge: missing JSON rejected", () => {
  assert.throws(
    () => parseJudge(`I think we should commit it`),
    (err: unknown) => err instanceof ActionParseError,
  );
});

// -----------------------------------------------------------------------------
// captureState / restoreState
// -----------------------------------------------------------------------------

test("captureState / restoreState: storage round-trips across a revert", async () => {
  // localStorage/sessionStorage throw on opaque origins (data: URLs), so we
  // need a real http origin. Reuse the fixtures server's healthcheck endpoint
  // — any same-origin page where storage works will do.
  const fixtures = await startFixturesServer();
  const session = await CdpBrowserSession.create();
  try {
    // /__health is a tiny text response on the fixtures origin; navigating
    // there gives us a non-opaque origin to write storage against.
    await session.navigate(`${fixtures.origin}/__health`);
    await session.evaluate(
      "localStorage.setItem('persisted','before'); sessionStorage.setItem('s','before');",
    );
    const before = await captureState(session);
    assert.equal(before.localStorage.persisted, "before");
    assert.equal(before.sessionStorage.s, "before");

    // Mutate storage to simulate an action's side effect.
    await session.evaluate(
      "localStorage.setItem('persisted','after'); sessionStorage.setItem('s','after');",
    );
    const mutated = await captureState(session);
    assert.equal(mutated.localStorage.persisted, "after");

    // Restore. The function navigates back to the snapshot URL after
    // rewriting storage; the post-navigation snapshot MUST match the saved one.
    await restoreState(session, before);
    const restored = await captureState(session);
    assert.equal(restored.localStorage.persisted, "before");
    assert.equal(restored.sessionStorage.s, "before");
    assert.equal(restored.url, before.url);
  } finally {
    await session.close();
    await fixtures.close();
  }
});

test("captureState: opaque origins return empty storage without throwing", async () => {
  // data: URLs have an opaque origin; localStorage access throws SecurityError.
  // captureState swallows this and returns empty maps so the agent's revert
  // path doesn't fall over on data: pages.
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eopaque%3C%2Ftitle%3E");
    const state = await captureState(session);
    assert.deepEqual(state.localStorage, {});
    assert.deepEqual(state.sessionStorage, {});
    assert.match(state.url, /^data:/);
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// End-to-end runs on real Chrome with scripted dual-LLM
// -----------------------------------------------------------------------------

test("run: judge commits a click, second step finishes DONE", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-srb-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-srb-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>srb-click</title>
<body>
  <script>window.__clicked = null;</script>
  <button id="go" onclick="window.__clicked='yes'">Continue</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    // Step 1: proposer suggests click; judge commits.
    // Step 2: proposer suggests finish (no judge call for finish).
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"candidates":[{"type":"click","selector":"button#go","rationale":"the goal asks to click Continue"}]}`,
          tokens_in: 80,
          tokens_out: 30,
        },
      },
      {
        reply: {
          text: `{"verdict":"commit","reason":"button was clicked, state advanced"}`,
          tokens_in: 60,
          tokens_out: 20,
        },
      },
      {
        reply: {
          text: `{"candidates":[{"type":"finish","reason":"continue was clicked, goal met"}]}`,
          tokens_in: 60,
          tokens_out: 20,
        },
      },
    ]);

    const agent = new SpeculativeRollbackAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-click",
        }),
      maxSteps: 5,
      candidates: 1,
    });
    const traj = await agent.run(
      "click the Continue button",
      session,
      generousBudget(),
      { task_id: "srb-click", seed: 0, runs_root: runsRoot },
    );

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 3, "propose + judge + propose(finish)");

    const clicked = await session.evaluate<string | null>("window.__clicked");
    assert.equal(clicked, "yes");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; ok?: boolean; verdict?: string; selector?: string };
    }>;
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.action.type, "click");
    assert.equal(steps[0]?.action.verdict, "commit");
    assert.equal(steps[0]?.action.selector, "button#go");
    assert.equal(steps[1]?.action.type, "finish");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: judge reverts first candidate, second candidate commits", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-srb-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-srb-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>srb-revert</title>
<body>
  <script>window.__clicked = '';</script>
  <button id="bad" onclick="window.__clicked='bad'">Cancel</button>
  <button id="good" onclick="window.__clicked='good'">Confirm</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    // Step 1: proposer returns TWO candidates (bad then good).
    //         judge reverts bad → restore → execute good → judge commits.
    // Step 2: proposer says finish.
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"candidates":[
            {"type":"click","selector":"button#bad","rationale":"try cancel first"},
            {"type":"click","selector":"button#good","rationale":"otherwise confirm"}
          ]}`,
          tokens_in: 100,
          tokens_out: 50,
        },
      },
      {
        reply: {
          text: `{"verdict":"revert","reason":"that was cancel; we want confirm"}`,
          tokens_in: 50,
          tokens_out: 20,
        },
      },
      {
        reply: {
          text: `{"verdict":"commit","reason":"confirm clicked"}`,
          tokens_in: 50,
          tokens_out: 20,
        },
      },
      {
        reply: {
          text: `{"candidates":[{"type":"finish","reason":"confirm clicked"}]}`,
          tokens_in: 50,
          tokens_out: 20,
        },
      },
    ]);

    const agent = new SpeculativeRollbackAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-revert",
        }),
      maxSteps: 5,
      candidates: 2,
    });
    const traj = await agent.run(
      "click Confirm",
      session,
      generousBudget(),
      { task_id: "srb-revert", seed: 0, runs_root: runsRoot },
    );

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 4, "propose + judge(revert) + judge(commit) + propose(finish)");

    // After restore + good click, __clicked should ultimately be 'good'.
    // Note: restoreState navigates back to the data: URL which re-runs the
    // inline script, so __clicked is reset to '' before the second click.
    const clicked = await session.evaluate<string | null>("window.__clicked");
    assert.equal(clicked, "good");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; ok?: boolean; verdict?: string; selector?: string; candidate_index?: number };
    }>;
    // Expect: 2 click steps (revert + commit) + 1 finish step = 3 total.
    assert.equal(steps.length, 3);
    assert.equal(steps[0]?.action.type, "click");
    assert.equal(steps[0]?.action.verdict, "revert");
    assert.equal(steps[0]?.action.selector, "button#bad");
    assert.equal(steps[0]?.action.candidate_index, 0);
    assert.equal(steps[1]?.action.type, "click");
    assert.equal(steps[1]?.action.verdict, "commit");
    assert.equal(steps[1]?.action.selector, "button#good");
    assert.equal(steps[1]?.action.candidate_index, 1);
    assert.equal(steps[2]?.action.type, "finish");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: judge says done after first action ends the run immediately", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-srb-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-srb-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(`data:text/html,${encodeURIComponent(`<!doctype html><title>srb-done</title><button id="go">Go</button>`)}`);
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"candidates":[{"type":"click","selector":"button#go"}]}`,
          tokens_in: 50,
          tokens_out: 10,
        },
      },
      {
        reply: {
          text: `{"verdict":"done","reason":"the goal is met after the click"}`,
          tokens_in: 30,
          tokens_out: 20,
        },
      },
    ]);
    const agent = new SpeculativeRollbackAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-done",
        }),
      maxSteps: 5,
      candidates: 1,
    });
    const traj = await agent.run("click go", session, generousBudget(), {
      task_id: "srb-done",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: proposer parse_error does not abort the loop", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-srb-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-srb-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eparse%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: "I am not JSON at all",
          tokens_in: 30,
          tokens_out: 10,
        },
      },
      {
        reply: {
          text: `{"candidates":[{"type":"finish","reason":"giving up"}]}`,
          tokens_in: 30,
          tokens_out: 10,
        },
      },
    ]);
    const agent = new SpeculativeRollbackAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-parse",
        }),
      maxSteps: 4,
      candidates: 1,
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "srb-parse",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2);
    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string };
    }>;
    assert.equal(steps[0]?.action.type, "parse_error");
    assert.equal(steps[1]?.action.type, "finish");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-srb-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-srb-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C%2Ftitle%3E");
    const agent = new SpeculativeRollbackAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "srb-no-llm",
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

test("run: tight steps budget short-circuits to BUDGET_EXCEEDED", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-srb-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-srb-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbutton%3EX%3C%2Fbutton%3E");
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"candidates":[{"type":"finish","reason":"x"}]}`,
          tokens_in: 10,
          tokens_out: 5,
        },
      },
    ]);
    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep(); // pre-trip the steps axis

    const agent = new SpeculativeRollbackAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "tight",
        }),
    });
    const traj = await agent.run("x", session, tight, {
      task_id: "srb-tight",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "BUDGET_EXCEEDED");
    assert.match(traj.metadata.decline_reason ?? "", /steps/);
    assert.equal(calls.length, 0, "no LLM calls before budget trip");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Manifest distinctness
// -----------------------------------------------------------------------------

test("manifest: speculative-rollback distinct_from all three prior agents, with zero keyword overlap", async () => {
  const baselineRaw = await readFile(
    new URL("../../../agents/baseline-a11y-react/manifest.yaml", import.meta.url),
    "utf8",
  );
  const pteRaw = await readFile(
    new URL("../../../agents/plan-then-execute/manifest.yaml", import.meta.url),
    "utf8",
  );
  const rcgRaw = await readFile(
    new URL("../../../agents/runtime-codegen/manifest.yaml", import.meta.url),
    "utf8",
  );
  const srbRaw = await readFile(
    new URL("../../../agents/speculative-rollback/manifest.yaml", import.meta.url),
    "utf8",
  );
  const baseline = parseYaml(baselineRaw) as { approach_keywords: string[] };
  const pte = parseYaml(pteRaw) as { approach_keywords: string[] };
  const rcg = parseYaml(rcgRaw) as { approach_keywords: string[] };
  const srb = parseYaml(srbRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };

  assert.ok(srb.distinct_from.includes("baseline-a11y-react"));
  assert.ok(srb.distinct_from.includes("plan-then-execute"));
  assert.ok(srb.distinct_from.includes("runtime-codegen"));

  const srbSet = new Set(srb.approach_keywords.map((k) => k.toLowerCase()));
  for (const [name, manifest] of [
    ["baseline-a11y-react", baseline],
    ["plan-then-execute", pte],
    ["runtime-codegen", rcg],
  ] as const) {
    const other = new Set(manifest.approach_keywords.map((k) => k.toLowerCase()));
    let overlap = 0;
    for (const k of srbSet) if (other.has(k)) overlap += 1;
    assert.equal(overlap, 0, `no shared approach_keywords with ${name}`);
  }
});
