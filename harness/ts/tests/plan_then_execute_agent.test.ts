// US-014: plan-then-execute agent + its DSL.
//
// Coverage:
//   - parsePlan tolerates fences, prose, single-object wrap; rejects unknown
//     ops, missing required fields, empty arrays.
//   - executePlanOp click_text/type by visible text on real Chrome.
//   - End-to-end run: one mock LLM turn produces a goto+click_text+finish
//     plan; agent executes and finishes DONE.
//   - Repair branch: first click_text fails (no match); second LLM call
//     emits a new plan that does match; trajectory records both plans.
//   - No-LLM (replay-only client) declines cleanly.
//   - Tight budget short-circuits with BUDGET_EXCEEDED.
//   - Manifest distinctness against baseline-a11y-react.
//   - script.ts opLabel/opToRecord round-trips fields for trajectory output.
//   - classify hard_fail vs soft_fail.
//
// Real-Chrome tests share the readGzipLines + scriptedProvider helpers used
// in baseline_agent.test.ts (US-013).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import PlanThenExecuteAgent from "../../../agents/plan-then-execute/agent.js";
import {
  classify,
  executePlanOp,
  opLabel,
  opToRecord,
  parsePlan,
  PlanParseError,
  type PlanOp,
} from "../../../agents/plan-then-execute/script.js";

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
// parsePlan
// -----------------------------------------------------------------------------

test("parsePlan: simple array of ops", () => {
  const plan = parsePlan(
    '[{"op":"goto","url":"https://x"},{"op":"finish","reason":"done"}]',
  );
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { op: "goto", url: "https://x" });
  assert.deepEqual(plan[1], { op: "finish", reason: "done" });
});

test("parsePlan: tolerates ```json fences", () => {
  const plan = parsePlan(
    "```json\n[{\"op\":\"finish\",\"reason\":\"ok\"}]\n```",
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.op, "finish");
});

test("parsePlan: tolerates leading prose then array", () => {
  const plan = parsePlan(
    'Thinking... here is the plan: [{"op":"click_text","text":"More info"}]',
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.op, "click_text");
});

test("parsePlan: single object auto-wraps to one-element array", () => {
  const plan = parsePlan('{"op":"finish","reason":"trivial"}');
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.op, "finish");
});

test("parsePlan: accepts `action` alias for op", () => {
  const plan = parsePlan('[{"action":"goto","url":"https://y"}]');
  assert.equal(plan[0]?.op, "goto");
});

test("parsePlan: type op with submit:true", () => {
  const plan = parsePlan(
    '[{"op":"type","label":"Email","value":"a@b","submit":true}]',
  );
  const op = plan[0];
  assert.equal(op?.op, "type");
  if (op?.op === "type") {
    assert.equal(op.label, "Email");
    assert.equal(op.value, "a@b");
    assert.equal(op.submit, true);
  }
});

test("parsePlan: rejects empty array", () => {
  assert.throws(
    () => parsePlan("[]"),
    (err: unknown) => err instanceof PlanParseError && /empty/i.test((err as Error).message),
  );
});

test("parsePlan: rejects unknown op", () => {
  assert.throws(
    () => parsePlan('[{"op":"frobnicate"}]'),
    (err: unknown) => err instanceof PlanParseError && /frobnicate/.test((err as Error).message),
  );
});

test("parsePlan: rejects type op missing value", () => {
  assert.throws(
    () => parsePlan('[{"op":"type","label":"Email"}]'),
    (err: unknown) => err instanceof PlanParseError && /value/i.test((err as Error).message),
  );
});

test("parsePlan: rejects when no JSON value found", () => {
  assert.throws(
    () => parsePlan("I would click Submit."),
    (err: unknown) => err instanceof PlanParseError,
  );
});

test("parsePlan: clamps wait_for_text timeout_ms", () => {
  const plan = parsePlan(
    '[{"op":"wait_for_text","text":"loaded","timeout_ms":999999}]',
  );
  const op = plan[0];
  if (op?.op === "wait_for_text") {
    assert.equal(op.timeout_ms, 15_000);
  } else {
    throw new Error("expected wait_for_text op");
  }
});

// -----------------------------------------------------------------------------
// classify / opLabel / opToRecord
// -----------------------------------------------------------------------------

test("classify: hard_fail for click_text miss, soft_fail for extract miss", () => {
  const click: PlanOp = { op: "click_text", text: "Submit" };
  const extract: PlanOp = { op: "extract", query: "x" };
  assert.equal(classify(click, { ok: false, message: "no element" }), "hard_fail");
  assert.equal(classify(extract, { ok: false, message: "no lines" }), "soft_fail");
});

test("classify: scroll and wait_for_text are best-effort", () => {
  const scroll: PlanOp = { op: "scroll", direction: "down" };
  const wait: PlanOp = { op: "wait_for_text", text: "x" };
  assert.equal(classify(scroll, { ok: false, message: "?" }), "soft_fail");
  assert.equal(classify(wait, { ok: false, message: "?" }), "soft_fail");
});

test("opLabel: type op includes submit marker", () => {
  const op: PlanOp = { op: "type", label: "Email", value: "a@b", submit: true };
  assert.match(opLabel(op), /type\(Email=a@b, submit\)/);
});

test("opToRecord: extract op carries the extracted text", () => {
  const op: PlanOp = { op: "extract", query: "title" };
  const rec = opToRecord(op, { ok: true, message: "matched 1", extracted: "Hello" });
  assert.equal(rec.type, "extract");
  assert.equal(rec.query, "title");
  assert.equal(rec.extracted, "Hello");
});

// -----------------------------------------------------------------------------
// executePlanOp (real Chrome)
// -----------------------------------------------------------------------------

test("executePlanOp click_text: clicks the first matching visible button", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `
      <!doctype html>
      <title>click test</title>
      <script>window.__clicked = null;</script>
      <button id="a" onclick="window.__clicked='alpha'">Alpha</button>
      <button id="b" onclick="window.__clicked='beta'">Beta</button>
    `;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const r = await executePlanOp({ op: "click_text", text: "Beta" }, session);
    assert.equal(r.ok, true);
    const got = await session.evaluate<string | null>("window.__clicked");
    assert.equal(got, "beta");
  } finally {
    await session.close();
  }
});

test("executePlanOp click_text: returns ok:false when no match", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbutton%3EOnly%3C%2Fbutton%3E");
    const r = await executePlanOp({ op: "click_text", text: "Nope" }, session);
    assert.equal(r.ok, false);
    assert.match(r.message, /no element matching/);
  } finally {
    await session.close();
  }
});

test("executePlanOp type: fills input by label and optionally submits", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `
      <!doctype html>
      <title>form</title>
      <script>window.__submitted = null;</script>
      <form onsubmit="window.__submitted = document.getElementById('email').value; event.preventDefault();">
        <label for="email">Email</label>
        <input id="email" type="email" placeholder="you@example.com">
        <button type="submit">Send</button>
      </form>
    `;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const r = await executePlanOp(
      { op: "type", label: "Email", value: "alice@example.com", submit: true },
      session,
    );
    assert.equal(r.ok, true);
    const got = await session.evaluate<string | null>("window.__submitted");
    assert.equal(got, "alice@example.com");
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// End-to-end run with scripted LLM (real Chrome)
// -----------------------------------------------------------------------------

test("run: one-shot plan navigates and clicks then finishes DONE", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pte-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pte-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `
      <!doctype html>
      <title>plan test</title>
      <script>window.__clicked = null;</script>
      <button onclick="window.__clicked='go'">Continue</button>
    `;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const plan = JSON.stringify([
      { op: "click_text", text: "Continue" },
      { op: "finish", reason: "clicked" },
    ]);
    const { provider, calls } = scriptedProvider([{ reply: { text: plan, tokens_in: 80, tokens_out: 20 } }]);

    const agent = new PlanThenExecuteAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test",
        }),
      maxOps: 8,
    });
    const traj = await agent.run("press continue", session, generousBudget(), {
      task_id: "pte-basic",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 1, "single LLM call for the whole plan");

    const clicked = await session.evaluate<string | null>("window.__clicked");
    assert.equal(clicked, "go");

    const lines = await readGzipLines(traj.gzPath);
    const kinds = lines.map((l) => (l as { kind: string }).kind);
    // meta + 1 llm_call + 3 steps (plan + click + finish) + end
    assert.deepEqual(
      kinds.filter((k) => k === "step" || k === "llm_call" || k === "end" || k === "meta"),
      ["meta", "llm_call", "step", "step", "step", "end"],
    );

    // The first step records the plan action.
    const planStep = (lines.find((l) => (l as { kind: string }).kind === "step") as {
      action: { type: string; phase: string; ops: Array<{ op: string }>; n_ops: number };
    }).action;
    assert.equal(planStep.type, "plan");
    assert.equal(planStep.phase, "initial");
    assert.equal(planStep.n_ops, 2);
    assert.equal(planStep.ops[0]?.op, "click_text");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: hard-fail triggers a repair LLM call that succeeds", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pte-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pte-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `
      <!doctype html>
      <title>repair test</title>
      <script>window.__clicked = null;</script>
      <button onclick="window.__clicked='real'">RealButton</button>
    `;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const firstPlan = JSON.stringify([
      { op: "click_text", text: "MissingLabel" },
      { op: "finish", reason: "should not reach" },
    ]);
    const repairPlan = JSON.stringify([
      { op: "click_text", text: "RealButton" },
      { op: "finish", reason: "repaired" },
    ]);
    const { provider, calls } = scriptedProvider([
      { reply: { text: firstPlan, tokens_in: 60, tokens_out: 20 } },
      { reply: { text: repairPlan, tokens_in: 60, tokens_out: 20 } },
    ]);

    const agent = new PlanThenExecuteAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-repair",
        }),
      maxOps: 10,
      maxRepairs: 2,
    });
    const traj = await agent.run("click the right button", session, generousBudget(), {
      task_id: "pte-repair",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2, "initial plan + one repair");

    const clicked = await session.evaluate<string | null>("window.__clicked");
    assert.equal(clicked, "real");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; phase?: string };
    }>;
    const types = steps.map((s) => s.action.type + (s.action.phase ? `:${s.action.phase}` : ""));
    // plan:initial, click_text (fail), plan:repair, click_text (ok), finish
    assert.deepEqual(types, ["plan:initial", "click_text", "plan:repair", "click_text", "finish"]);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pte-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pte-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C%2Ftitle%3E");
    const agent = new PlanThenExecuteAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "pte-no-llm",
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
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pte-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pte-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbutton%3EX%3C%2Fbutton%3E");
    const plan = JSON.stringify([{ op: "click_text", text: "X" }, { op: "finish", reason: "ok" }]);
    const { provider, calls } = scriptedProvider([{ reply: { text: plan, tokens_in: 10, tokens_out: 5 } }]);

    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep(); // pre-trip the steps axis

    const agent = new PlanThenExecuteAgent({
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
      task_id: "pte-tight",
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

test("run: parse error after retry → DECLINED with parse_error reason", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-pte-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-pte-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eparse%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: "I will not output JSON", tokens_in: 10, tokens_out: 5 } },
      { reply: { text: "still no JSON", tokens_in: 10, tokens_out: 5 } },
    ]);
    const agent = new PlanThenExecuteAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "parse-fail",
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "pte-parse",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.match(traj.metadata.decline_reason ?? "", /plan parse error/i);
    assert.equal(calls.length, 2, "initial + one retry");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Manifest distinctness
// -----------------------------------------------------------------------------

test("manifest: plan-then-execute distinct_from baseline-a11y-react and shares no approach_keywords", async () => {
  const baselineRaw = await readFile(
    new URL("../../../agents/baseline-a11y-react/manifest.yaml", import.meta.url),
    "utf8",
  );
  const pteRaw = await readFile(
    new URL("../../../agents/plan-then-execute/manifest.yaml", import.meta.url),
    "utf8",
  );
  const baseline = parseYaml(baselineRaw) as { approach_keywords: string[] };
  const pte = parseYaml(pteRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };
  assert.ok(pte.distinct_from.includes("baseline-a11y-react"));
  const inter = new Set(pte.approach_keywords.map((k) => k.toLowerCase()));
  const bSet = new Set(baseline.approach_keywords.map((k) => k.toLowerCase()));
  let overlap = 0;
  for (const k of inter) if (bSet.has(k)) overlap += 1;
  assert.equal(overlap, 0, "no shared approach_keywords with baseline");
});
