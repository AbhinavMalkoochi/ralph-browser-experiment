// US-017: predicate-driven agent.
//
// Coverage:
//   - parsePredicate: success, fences, prose, alternate field names
//     (predicate / expression / expr / test), missing field rejection,
//     non-string rejection, empty rejection.
//   - parseAction: success cases, fences/prose, action-wrapper variant,
//     unknown type rejection, EXPLICIT `finish` rejection (the agent's
//     defining invariant), missing-selector rejection, scroll/wait
//     normalisation.
//   - evaluatePredicate on real Chrome: truthy, falsy, in-page error
//     (ReferenceError), syntax error (parse fails outside the IIFE).
//   - End-to-end runs on real Chrome with a scripted dual-LLM
//     (synthesiser + action picker):
//       * predicate already true at start → DONE without any action.
//       * predicate becomes true after a click → DONE on first action.
//       * predicate stays false through maxSteps → DECLINED.
//       * action LLM emits `finish` → recorded as parse_error, loop
//         continues.
//       * synthesiser emits unparseable predicate → DECLINED early.
//   - No-LLM (replay-only client) declines cleanly during synthesis.
//   - Tight steps budget short-circuits to BUDGET_EXCEEDED.
//   - Manifest distinctness vs ALL prior agents (baseline, plan-then-execute,
//     runtime-codegen, speculative-rollback) with zero keyword overlap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import PredicateDrivenAgent from "../../../agents/predicate-driven/agent.js";
import {
  ActionParseError,
  parseAction,
} from "../../../agents/predicate-driven/actions.js";
import {
  PredicateParseError,
  evaluatePredicate,
  parsePredicate,
  wrapPredicate,
} from "../../../agents/predicate-driven/predicate.js";

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

// -----------------------------------------------------------------------------
// parsePredicate
// -----------------------------------------------------------------------------

test("parsePredicate: simple object", () => {
  const p = parsePredicate(
    `{"predicate":"document.title === 'done'","rationale":"title flips when submitted"}`,
  );
  assert.equal(p.expression, "document.title === 'done'");
  assert.equal(p.rationale, "title flips when submitted");
});

test("parsePredicate: ```json fence stripped", () => {
  const p = parsePredicate(
    "```json\n{\"predicate\":\"window.__test?.completed === true\"}\n```",
  );
  assert.equal(p.expression, "window.__test?.completed === true");
  assert.equal(p.rationale, undefined);
});

test("parsePredicate: leading prose tolerated", () => {
  const p = parsePredicate(
    'Sure! Here is the predicate:\n{"predicate":"location.href.includes(\\"/done\\")"}',
  );
  assert.match(p.expression, /location\.href/);
});

test("parsePredicate: alternate field names", () => {
  for (const k of ["predicate", "expression", "expr", "test"]) {
    const raw = `{"${k}":"true"}`;
    const p = parsePredicate(raw);
    assert.equal(p.expression, "true");
  }
});

test("parsePredicate: missing predicate field rejected", () => {
  assert.throws(
    () => parsePredicate(`{"rationale":"hmm"}`),
    (err: unknown) =>
      err instanceof PredicateParseError && /missing/.test((err as Error).message),
  );
});

test("parsePredicate: non-string predicate rejected", () => {
  assert.throws(
    () => parsePredicate(`{"predicate":42}`),
    (err: unknown) =>
      err instanceof PredicateParseError && /not a string/.test((err as Error).message),
  );
});

test("parsePredicate: empty string rejected", () => {
  assert.throws(
    () => parsePredicate(`{"predicate":"   "}`),
    (err: unknown) =>
      err instanceof PredicateParseError && /empty/.test((err as Error).message),
  );
});

test("parsePredicate: no JSON object rejected", () => {
  assert.throws(
    () => parsePredicate("just a sentence"),
    (err: unknown) => err instanceof PredicateParseError,
  );
});

test("wrapPredicate: produces an awaited IIFE that runs the body", () => {
  const wrapped = wrapPredicate("1 + 1 === 2");
  assert.match(wrapped, /^\(async \(\) =>/);
  assert.match(wrapped, /Boolean\(1 \+ 1 === 2\)/);
  assert.match(wrapped, /__predicate_error/);
});

// -----------------------------------------------------------------------------
// parseAction
// -----------------------------------------------------------------------------

test("parseAction: click with selector", () => {
  const a = parseAction(`{"type":"click","selector":"button#go"}`);
  assert.equal(a.type, "click");
  if (a.type === "click") assert.equal(a.selector, "button#go");
});

test("parseAction: ```json fence stripped", () => {
  const a = parseAction("```json\n{\"type\":\"navigate\",\"url\":\"https://example.com\"}\n```");
  assert.equal(a.type, "navigate");
});

test("parseAction: action-wrapper variant", () => {
  const a = parseAction(
    `{"action":{"type":"click","selector":"#x"},"thought":"reason"}`,
  );
  assert.equal(a.type, "click");
  if (a.type === "click") {
    assert.equal(a.selector, "#x");
    assert.equal(a.thought, "reason");
  }
});

test("parseAction: type with submit", () => {
  const a = parseAction(
    `{"type":"type","selector":"input[name='q']","text":"hello","submit":true}`,
  );
  if (a.type === "type") {
    assert.equal(a.selector, "input[name='q']");
    assert.equal(a.text, "hello");
    assert.equal(a.submit, true);
  } else assert.fail("expected type action");
});

test("parseAction: scroll defaults direction to down, clamps negative pixels", () => {
  const a = parseAction(`{"type":"scroll","direction":"sideways","pixels":-9}`);
  if (a.type === "scroll") {
    assert.equal(a.direction, "down");
    assert.equal(a.pixels, 0);
  } else assert.fail("expected scroll action");
});

test("parseAction: wait clamps to <=10s, accepts seconds", () => {
  const a = parseAction(`{"type":"wait","seconds":3}`);
  if (a.type === "wait") assert.equal(a.ms, 3000);
  else assert.fail("expected wait action");
  const huge = parseAction(`{"type":"wait","ms":99999999}`);
  if (huge.type === "wait") assert.equal(huge.ms, 10_000);
});

test("parseAction: REJECTS finish (predicate-driven invariant)", () => {
  assert.throws(
    () => parseAction(`{"type":"finish","reason":"i'm done"}`),
    (err: unknown) =>
      err instanceof ActionParseError &&
      /finish/.test((err as Error).message) &&
      /predicate/.test((err as Error).message),
  );
});

test("parseAction: unknown type rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"telepathy","selector":"x"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /unknown/.test((err as Error).message),
  );
});

test("parseAction: click missing selector rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"click"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /missing selector/.test((err as Error).message),
  );
});

test("parseAction: navigate missing url rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"navigate"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /missing url/.test((err as Error).message),
  );
});

test("parseAction: empty completion rejected", () => {
  assert.throws(
    () => parseAction(""),
    (err: unknown) => err instanceof ActionParseError,
  );
});

// -----------------------------------------------------------------------------
// evaluatePredicate on real Chrome
// -----------------------------------------------------------------------------

test("evaluatePredicate: truthy expression returns satisfied=true", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(
      "data:text/html,%3Ctitle%3Eok%3C%2Ftitle%3E%3Cbody%3E%3Cdiv%20id%3D%22hit%22%3E%3C%2Fdiv%3E%3C%2Fbody%3E",
    );
    const r = await evaluatePredicate("!!document.querySelector('#hit')", session);
    assert.equal(r.satisfied, true);
    assert.equal(r.error, undefined);
  } finally {
    await session.close();
  }
});

test("evaluatePredicate: falsy expression returns satisfied=false", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Efalsy%3C%2Ftitle%3E");
    const r = await evaluatePredicate("document.title === 'something else'", session);
    assert.equal(r.satisfied, false);
    assert.equal(r.error, undefined);
  } finally {
    await session.close();
  }
});

test("evaluatePredicate: in-page exception captured as error", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Etxn%3C%2Ftitle%3E");
    // ReferenceError inside the IIFE — caught by predicate.ts's try/catch.
    const r = await evaluatePredicate("nonexistent_global.method()", session);
    assert.equal(r.satisfied, false);
    assert.match(r.error ?? "", /nonexistent_global/);
  } finally {
    await session.close();
  }
});

test("evaluatePredicate: syntax error is captured as error (parse fails before IIFE runs)", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Esyn%3C%2Ftitle%3E");
    // Bad expression — the wrapper's try/catch can't catch a parse error
    // because parsing happens before any code runs. predicate.ts's outer
    // try/catch around browser.evaluate must surface this.
    const r = await evaluatePredicate("(((", session);
    assert.equal(r.satisfied, false);
    assert.ok(r.error && r.error.length > 0);
  } finally {
    await session.close();
  }
});

test("evaluatePredicate: async expression with await works", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Easync%3C%2Ftitle%3E");
    const r = await evaluatePredicate(
      "await Promise.resolve(document.title === 'async')",
      session,
    );
    assert.equal(r.satisfied, true);
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// End-to-end runs on real Chrome with scripted LLM
// -----------------------------------------------------------------------------

test("run: predicate true at start → DONE without any action", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pred-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pred-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>already-done</title><body><div id="ok">ready</div></body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    // Just one synth call; the predicate fires immediately so no action call.
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"predicate":"document.title === 'already-done'","rationale":"title is already at the goal"}`,
          tokens_in: 50,
          tokens_out: 30,
        },
      },
    ]);

    const agent = new PredicateDrivenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-already-done",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("already done", session, generousBudget(), {
      task_id: "pred-already-done",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 1, "synth only — no action call");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; satisfied?: boolean; phase?: string };
    }>;
    // Expect: synthesise_predicate + predicate_check(initial=true).
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.action.type, "synthesise_predicate");
    assert.equal(steps[1]?.action.type, "predicate_check");
    assert.equal(steps[1]?.action.satisfied, true);
    assert.equal(steps[1]?.action.phase, "initial");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: predicate fires after a click → DONE on first action", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pred-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pred-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>click-pred</title>
<body>
  <script>window.__test = {clicked:false};</script>
  <button id="go" onclick="window.__test.clicked = true">Go</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"predicate":"window.__test?.clicked === true","rationale":"set when Go is clicked"}`,
          tokens_in: 60,
          tokens_out: 30,
        },
      },
      {
        reply: {
          text: `{"type":"click","selector":"button#go"}`,
          tokens_in: 40,
          tokens_out: 10,
        },
      },
    ]);

    const agent = new PredicateDrivenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-click-pred",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run(
      "click Go to fire the test flag",
      session,
      generousBudget(),
      { task_id: "pred-click", seed: 0, runs_root: runsRoot },
    );

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2, "synth + 1 action");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; predicate_satisfied?: boolean };
    }>;
    // synth_pred + click step (with predicate_satisfied=true).
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.action.type, "synthesise_predicate");
    assert.equal(steps[1]?.action.type, "click");
    assert.equal(steps[1]?.action.predicate_satisfied, true);

    // Sanity-check the click actually landed.
    const clicked = await session.evaluate<boolean>(
      "Boolean(window.__test && window.__test.clicked)",
    );
    assert.equal(clicked, true);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: predicate stays false through maxSteps → DECLINED", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pred-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pred-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Estuck%3C%2Ftitle%3E%3Cbutton%20id%3D%22nope%22%3ENope%3C%2Fbutton%3E");
    // Predicate never satisfied. Action LLM keeps clicking the button.
    // The provider always serves these turns: 1 synth, then unbounded clicks.
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"predicate":"document.title === 'never-done'"}`,
          tokens_in: 30,
          tokens_out: 10,
        },
      },
      {
        reply: {
          text: `{"type":"click","selector":"button#nope"}`,
          tokens_in: 30,
          tokens_out: 10,
        },
      },
    ]);

    const agent = new PredicateDrivenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-stuck",
        }),
      maxSteps: 3,
    });
    const traj = await agent.run("get to never-done", session, generousBudget(), {
      task_id: "pred-stuck",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.match(
      traj.metadata.decline_reason ?? "",
      /max steps.*predicate still false/,
    );
    // 1 synth + 3 action calls.
    assert.equal(calls.length, 4);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: action LLM emitting `finish` is recorded as parse_error and loop continues", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pred-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pred-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>noisy</title>
<body>
  <script>window.__test = {clicked:false};</script>
  <button id="real" onclick="window.__test.clicked=true">Real</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"predicate":"window.__test?.clicked === true"}`,
          tokens_in: 40,
          tokens_out: 10,
        },
      },
      // First action: tries to finish — the parser rejects it.
      {
        reply: {
          text: `{"type":"finish","reason":"i think we're done"}`,
          tokens_in: 30,
          tokens_out: 10,
        },
      },
      // Second action: actually clicks the button.
      {
        reply: {
          text: `{"type":"click","selector":"button#real"}`,
          tokens_in: 30,
          tokens_out: 10,
        },
      },
    ]);

    const agent = new PredicateDrivenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-rej-finish",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("click real", session, generousBudget(), {
      task_id: "pred-rej-finish",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 3, "synth + finish-attempt (rejected) + click");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; error?: string };
    }>;
    // synth_pred + parse_error + click(predicate_satisfied=true).
    assert.equal(steps.length, 3);
    assert.equal(steps[0]?.action.type, "synthesise_predicate");
    assert.equal(steps[1]?.action.type, "parse_error");
    assert.match(steps[1]?.action.error ?? "", /finish/i);
    assert.equal(steps[2]?.action.type, "click");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: synthesiser emits unparseable predicate → DECLINED early", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pred-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pred-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Ebad-pred%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: "I cannot author a predicate for this goal.",
          tokens_in: 30,
          tokens_out: 10,
        },
      },
    ]);

    const agent = new PredicateDrivenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-bad-pred",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "pred-bad-pred",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.match(traj.metadata.decline_reason ?? "", /predicate synthesis failed/);
    assert.equal(calls.length, 1, "no action calls after synth fail");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly during synthesis", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pred-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pred-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C%2Ftitle%3E");
    const agent = new PredicateDrivenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "pred-no-llm",
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
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pred-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pred-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbutton%3EX%3C%2Fbutton%3E");
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"predicate":"document.title==='wat'"}`,
          tokens_in: 20,
          tokens_out: 5,
        },
      },
    ]);
    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep(); // pre-trip the steps axis

    const agent = new PredicateDrivenAgent({
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
      task_id: "pred-tight",
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

test("manifest: predicate-driven distinct_from all four prior agents, with zero keyword overlap", async () => {
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
  const predRaw = await readFile(
    new URL("../../../agents/predicate-driven/manifest.yaml", import.meta.url),
    "utf8",
  );
  const baseline = parseYaml(baselineRaw) as { approach_keywords: string[] };
  const pte = parseYaml(pteRaw) as { approach_keywords: string[] };
  const rcg = parseYaml(rcgRaw) as { approach_keywords: string[] };
  const srb = parseYaml(srbRaw) as { approach_keywords: string[] };
  const pred = parseYaml(predRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };

  for (const target of [
    "baseline-a11y-react",
    "plan-then-execute",
    "runtime-codegen",
    "speculative-rollback",
  ]) {
    assert.ok(
      pred.distinct_from.includes(target),
      `predicate-driven.distinct_from must include ${target}`,
    );
  }

  const predSet = new Set(pred.approach_keywords.map((k) => k.toLowerCase()));
  for (const [name, manifest] of [
    ["baseline-a11y-react", baseline],
    ["plan-then-execute", pte],
    ["runtime-codegen", rcg],
    ["speculative-rollback", srb],
  ] as const) {
    const other = new Set(manifest.approach_keywords.map((k) => k.toLowerCase()));
    let overlap = 0;
    for (const k of predSet) if (other.has(k)) overlap += 1;
    assert.equal(overlap, 0, `no shared approach_keywords with ${name}`);
  }
});
