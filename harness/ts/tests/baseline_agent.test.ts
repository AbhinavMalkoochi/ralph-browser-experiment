// US-013: baseline-a11y-react agent.
//
// Coverage:
//   - parseAction tolerates fences/prose, rejects unknown action types,
//     coerces both `target` and `target_aid`.
//   - formatSnapshot renders interactive elements with stable [aid] indices.
//   - The ReAct loop exercised against real Chrome with a mocked LLM
//     provider clicks an aid-tagged button and finishes DONE.
//   - LLMProviderUnavailable / LLMReplayMiss both produce a clean DECLINED
//     trajectory (the no-LLM contract path).
//   - Tight budget short-circuits with BUDGET_EXCEEDED before any LLM call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import BaselineA11yReactAgent from "../../../agents/baseline-a11y-react/agent.js";
import {
  parseAction,
  ActionParseError,
  type AgentAction,
} from "../../../agents/baseline-a11y-react/actions.js";
import {
  formatSnapshot,
  formatElement,
  type PageSnapshot,
} from "../../../agents/baseline-a11y-react/snapshot.js";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Budget } from "../agent/types.js";
import { LLMClient } from "../llm/client.js";
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

// -----------------------------------------------------------------------------
// parseAction
// -----------------------------------------------------------------------------

test("parseAction: bare JSON click action", () => {
  const a = parseAction('{"action":"click","target":3}');
  assert.deepEqual(a, { type: "click", target: 3 });
});

test("parseAction: tolerates ```json fences and trailing prose", () => {
  const a = parseAction("```json\n{\"action\":\"finish\",\"reason\":\"done\"}\n```");
  assert.equal(a.type, "finish");
  if (a.type === "finish") assert.equal(a.reason, "done");
});

test("parseAction: leading prose then JSON object", () => {
  const a = parseAction(
    'Looking at the snapshot, I think we should click. {"action":"click","target":7,"thought":"primary CTA"}',
  );
  assert.equal(a.type, "click");
  if (a.type === "click") {
    assert.equal(a.target, 7);
    assert.equal(a.thought, "primary CTA");
  }
});

test("parseAction: target_aid alias coerces to numeric target", () => {
  const a = parseAction('{"action":"click","target_aid":"12"}');
  assert.equal(a.type, "click");
  if (a.type === "click") assert.equal(a.target, 12);
});

test("parseAction: type action with submit and text", () => {
  const a = parseAction('{"action":"type","target":4,"text":"alice","submit":true}');
  assert.equal(a.type, "type");
  if (a.type === "type") {
    assert.equal(a.target, 4);
    assert.equal(a.text, "alice");
    assert.equal(a.submit, true);
  }
});

test("parseAction: scroll defaults to down direction", () => {
  const a = parseAction('{"action":"scroll"}');
  assert.equal(a.type, "scroll");
  if (a.type === "scroll") assert.equal(a.direction, "down");
});

test("parseAction: navigate requires url", () => {
  assert.throws(
    () => parseAction('{"action":"navigate"}'),
    (err: unknown) => err instanceof ActionParseError && /url/i.test((err as Error).message),
  );
});

test("parseAction: click requires target", () => {
  assert.throws(
    () => parseAction('{"action":"click"}'),
    (err: unknown) => err instanceof ActionParseError,
  );
});

test("parseAction: rejects unknown action types", () => {
  assert.throws(
    () => parseAction('{"action":"frobnicate","target":1}'),
    (err: unknown) => err instanceof ActionParseError && /frobnicate/.test((err as Error).message),
  );
});

test("parseAction: rejects completion with no JSON object", () => {
  assert.throws(
    () => parseAction("I would click the first button."),
    (err: unknown) => err instanceof ActionParseError,
  );
});

test("parseAction: wait clamps absurd ms values", () => {
  const a = parseAction('{"action":"wait","ms":999999}');
  assert.equal(a.type, "wait");
  if (a.type === "wait") assert.equal(a.ms, 10_000);
});

// -----------------------------------------------------------------------------
// formatSnapshot
// -----------------------------------------------------------------------------

test("formatSnapshot: renders interactive elements with stable [aid] indices", () => {
  const snap: PageSnapshot = {
    url: "https://example.com/",
    title: "Example",
    text: "Hello world.",
    seq: 1,
    scanned: 2,
    elements: [
      {
        aid: 1,
        role: "link",
        name: "More info",
        tag: "a",
        href: "https://www.iana.org/",
        visible: true,
        disabled: false,
      },
      {
        aid: 2,
        role: "textbox",
        name: "email",
        tag: "input",
        type: "email",
        placeholder: "you@example.com",
        visible: true,
        disabled: false,
      },
    ],
  };
  const out = formatSnapshot(snap);
  assert.match(out, /URL: https:\/\/example\.com\//);
  assert.match(out, /Title: Example/);
  assert.match(out, /\[1\] link "More info"/);
  assert.match(out, /\[2\] textbox "email"/);
  assert.match(out, /placeholder=.*you@example\.com/);
});

test("formatElement: meta omitted when empty", () => {
  const line = formatElement({
    aid: 5,
    role: "button",
    name: "OK",
    tag: "button",
    visible: true,
    disabled: false,
  });
  assert.equal(line, '[5] button "OK"');
});

// -----------------------------------------------------------------------------
// ReAct loop with mocked LLM (real Chrome)
// -----------------------------------------------------------------------------

interface ScriptedTurn {
  match?: (req: ProviderRequest) => boolean;
  reply: ProviderResponse;
}

function scriptedProvider(turns: ScriptedTurn[]): { provider: LLMProvider; calls: ProviderRequest[] } {
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

test("ReAct loop: clicks the first aid-tagged button and finishes DONE", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-baseline-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-baseline-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `
      <!doctype html>
      <title>Baseline test</title>
      <script>window.__clicked = null;</script>
      <button id="b1" onclick="window.__clicked='b1'">First</button>
      <button id="b2" onclick="window.__clicked='b2'">Second</button>
    `;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const { provider, calls } = scriptedProvider([
      // Turn 1: click first button (which will be aid=1)
      { reply: { text: '{"action":"click","target":1,"thought":"first button"}', tokens_in: 80, tokens_out: 12 } },
      // Turn 2: finish
      { reply: { text: '{"action":"finish","reason":"clicked first"}', tokens_in: 90, tokens_out: 8 } },
    ]);

    const agent = new BaselineA11yReactAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test",
        }),
      model: "gpt-4o-mini",
      maxSteps: 5,
    });
    const traj = await agent.run("click the first button", session, generousBudget(), {
      task_id: "react-test",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2, "exactly two LLM turns");
    assert.equal(traj.stepCount, 2);

    const clicked = await session.evaluate<string | null>("window.__clicked");
    assert.equal(clicked, "b1", "first button received click");

    const lines = await readGzipLines(traj.gzPath);
    // meta + 2 llm_call + 2 step + end
    const kinds = lines.map((l) => (l as { kind: string }).kind);
    assert.deepEqual(
      kinds.filter((k) => k === "step" || k === "llm_call" || k === "end" || k === "meta"),
      ["meta", "llm_call", "step", "llm_call", "step", "end"],
    );
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("ReAct loop: type+submit fills an input and submits the form", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-baseline-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-baseline-"));
  const session = await CdpBrowserSession.create();
  try {
    // Form with an input + submit; the inline handler captures the value.
    const html = `
      <!doctype html>
      <title>Form</title>
      <script>window.__submitted = null;</script>
      <form onsubmit="window.__submitted = document.getElementById('email').value; event.preventDefault();">
        <label for="email">Email</label>
        <input id="email" type="email" placeholder="you@example.com">
        <button type="submit">Send</button>
      </form>
    `;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    // Snapshot will include both input and button as interactive. Aids
    // depend on traversal order: input is aid=1, button is aid=2.
    const { provider } = scriptedProvider([
      { reply: { text: '{"action":"type","target":1,"text":"alice@example.com","submit":true}', tokens_in: 60, tokens_out: 15 } },
      { reply: { text: '{"action":"finish","reason":"submitted"}', tokens_in: 60, tokens_out: 5 } },
    ]);

    const agent = new BaselineA11yReactAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-form",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("submit alice's email", session, generousBudget(), {
      task_id: "form-test",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    const submitted = await session.evaluate<string | null>("window.__submitted");
    assert.equal(submitted, "alice@example.com");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("no LLM provider: agent declines cleanly", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-baseline-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-baseline-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C%2Ftitle%3E");
    const agent = new BaselineA11yReactAgent({
      // Replay-only client with no providers and no cache → first call throws
      // LLMReplayMissError. The agent must catch and DECLINE.
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "no-llm",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.match(traj.metadata.decline_reason ?? "", /replay miss/i);
    assert.equal(traj.stepCount, 1, "records one observation step before declining");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("tight steps budget short-circuits to BUDGET_EXCEEDED", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-baseline-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-baseline-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ca%20href%3D%22https%3A%2F%2Fx%22%3Ex%3C%2Fa%3E");

    const { provider, calls } = scriptedProvider([
      { reply: { text: '{"action":"click","target":1}', tokens_in: 10, tokens_out: 5 } },
      { reply: { text: '{"action":"finish","reason":"x"}', tokens_in: 10, tokens_out: 5 } },
    ]);

    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    // Pre-trip the steps axis so the FIRST budget.check() (before any LLM) fires.
    tight.recordStep();

    const agent = new BaselineA11yReactAgent({
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
    const traj = await agent.run("anything", session, tight, {
      task_id: "tight",
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

test("snapshot script tags interactive DOM elements with data-gba-aid", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `
      <!doctype html>
      <title>Tags</title>
      <a href="x">link</a>
      <button>btn</button>
      <span>not-interactive</span>
      <input type="text" placeholder="here">
    `;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const { snapshotPage } = await import("../../../agents/baseline-a11y-react/snapshot.js");
    const snap = await snapshotPage(session);
    assert.equal(snap.elements.length, 3, "3 interactive elements (a, button, input)");
    // Aids 1..3 in DOM order.
    assert.deepEqual(
      snap.elements.map((e) => e.aid),
      [1, 2, 3],
    );
    // Roles plausible.
    assert.equal(snap.elements[0]?.role, "link");
    assert.equal(snap.elements[1]?.role, "button");
    assert.equal(snap.elements[2]?.role, "textbox");

    // Calling snapshot again preserves aids on the same DOM.
    const snap2 = await snapshotPage(session);
    assert.deepEqual(
      snap2.elements.map((e) => e.aid),
      [1, 2, 3],
    );
    assert.equal(snap2.seq, snap.seq + 1, "seq increments");
  } finally {
    await session.close();
  }
});

// Quiet unused-import check for AgentAction (the tests assert via runtime
// shapes, so the import would otherwise be type-only).
const _typeProbe: AgentAction | undefined = undefined;
void _typeProbe;
