// US-031: vision-som agent (Set-of-Marks).
//
// Coverage:
//   - parseAction: success cases, fences, alias normalisation, bad inputs.
//   - actionLabel: stable per-type formatting.
//   - observePage on real Chrome: marks injected on visible interactive
//     elements, overlay torn down, JPEG returned.
//   - executeAction click(mark): dispatches CDP Input at the bbox centre
//     of the marked element.
//   - executeAction type(mark, text, submit): focuses field, types, submits.
//   - End-to-end: scripted LLM picks click(mark=N) → DONE; click landed.
//   - parse_error tolerated mid-loop.
//   - max-steps without done → DECLINED.
//   - No LLM provider → DECLINED.
//   - Manifest distinctness vs ALL prior agents (Jaccard=0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import VisionSomAgent, {
  buildMessages,
} from "../../../agents/vision-som/agent.js";
import {
  ActionParseError,
  actionLabel,
  executeAction,
  parseAction,
} from "../../../agents/vision-som/actions.js";
import {
  observePage,
  toDataUrl,
  type SomObservation,
} from "../../../agents/vision-som/observe.js";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Budget } from "../agent/types.js";
import { LLMClient } from "../llm/client.js";
import { parseYaml } from "../verifier/yaml.js";
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
} from "../llm/types.js";

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

// ---------------------------------------------------------------------------
// parseAction
// ---------------------------------------------------------------------------

test("parseAction: click {mark}", () => {
  const a = parseAction(`{"type":"click","mark":7,"thought":"the Go button"}`);
  if (a.type !== "click") throw new Error("type narrowing");
  assert.equal(a.mark, 7);
  assert.equal(a.thought, "the Go button");
});

test("parseAction: ```json fence stripped", () => {
  const a = parseAction("```json\n{\"type\":\"click\",\"mark\":1}\n```");
  assert.equal(a.type, "click");
});

test("parseAction: alias finish→done", () => {
  const a = parseAction(`{"type":"finish","reason":"ok"}`);
  assert.equal(a.type, "done");
});

test("parseAction: alias goto→navigate", () => {
  const a = parseAction(`{"type":"goto","url":"https://x/"}`);
  assert.equal(a.type, "navigate");
});

test("parseAction: type with text + submit", () => {
  const a = parseAction(`{"type":"type","mark":3,"text":"hi","submit":true}`);
  if (a.type !== "type") throw new Error("type narrowing");
  assert.equal(a.mark, 3);
  assert.equal(a.text, "hi");
  assert.equal(a.submit, true);
});

test("parseAction: type missing text rejected", () => {
  assert.throws(() => parseAction(`{"type":"type","mark":1}`), ActionParseError);
});

test("parseAction: type missing mark rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"type","text":"x"}`),
    ActionParseError,
  );
});

test("parseAction: scroll defaults", () => {
  const a = parseAction(`{"type":"scroll"}`);
  if (a.type !== "scroll") throw new Error("type narrowing");
  assert.equal(a.direction, "down");
  assert.equal(a.pixels, undefined);
});

test("parseAction: scroll with explicit pixels clamped", () => {
  const a = parseAction(`{"type":"scroll","direction":"up","pixels":99999}`);
  if (a.type !== "scroll") throw new Error("type narrowing");
  assert.equal(a.direction, "up");
  assert.equal(a.pixels, 5000);
});

test("parseAction: wait clamps", () => {
  const a = parseAction(`{"type":"wait","ms":99999}`);
  if (a.type !== "wait") throw new Error("type narrowing");
  assert.equal(a.ms, 10_000);
});

test("parseAction: navigate requires url", () => {
  assert.throws(() => parseAction(`{"type":"navigate"}`), ActionParseError);
});

test("parseAction: done with reason", () => {
  const a = parseAction(`{"type":"done","reason":"goal met"}`);
  if (a.type !== "done") throw new Error("type narrowing");
  assert.equal(a.reason, "goal met");
});

test("parseAction: decline with reason", () => {
  const a = parseAction(`{"type":"decline","reason":"stuck"}`);
  if (a.type !== "decline") throw new Error("type narrowing");
  assert.equal(a.reason, "stuck");
});

test("parseAction: unknown rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"yodel","mark":1}`),
    ActionParseError,
  );
});

test("parseAction: click missing mark rejected", () => {
  assert.throws(() => parseAction(`{"type":"click"}`), ActionParseError);
});

// ---------------------------------------------------------------------------
// actionLabel
// ---------------------------------------------------------------------------

test("actionLabel: stable per type", () => {
  assert.equal(actionLabel({ type: "click", mark: 7 }), "click(mark=7)");
  assert.equal(
    actionLabel({ type: "type", mark: 2, text: "hi", submit: true }),
    `type(mark=2,"hi",submit)`,
  );
  assert.equal(
    actionLabel({ type: "scroll", direction: "down", pixels: 200 }),
    "scroll(down,200px)",
  );
  assert.equal(actionLabel({ type: "wait", ms: 250 }), "wait(250ms)");
  assert.equal(
    actionLabel({ type: "navigate", url: "https://x/" }),
    "navigate(https://x/)",
  );
  assert.equal(
    actionLabel({ type: "done", reason: "ok" }),
    "done(ok)",
  );
  assert.equal(
    actionLabel({ type: "decline", reason: "no" }),
    "decline(no)",
  );
});

// ---------------------------------------------------------------------------
// observePage on real Chrome
// ---------------------------------------------------------------------------

test("observePage: marks visible interactive elements + tears overlay down", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<button id="b1" style="position:fixed;left:50px;top:50px;width:120px;height:40px">A</button>
<button id="b2" style="position:fixed;left:200px;top:50px;width:120px;height:40px">B</button>
<input id="i1" type="text" style="position:fixed;left:50px;top:120px;width:200px;height:30px">
<div>not interactive</div>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const obs = await observePage(session);
    assert.ok(obs.marks.length >= 3, `expected >=3 marks, got ${obs.marks.length}`);
    const ids = obs.marks.map((m) => m.id).sort((a, b) => a - b);
    assert.deepEqual(ids.slice(0, 3), [1, 2, 3]);
    // JPEG returned.
    assert.ok(obs.screenshot_jpeg.length > 0);
    assert.equal(obs.screenshot_jpeg[0], 0xff);
    assert.equal(obs.screenshot_jpeg[1], 0xd8);
    // Overlay should have been torn down.
    const overlayCount = await session.evaluate<number>(
      `document.querySelectorAll('#__gba_som_overlay').length`,
    );
    assert.equal(overlayCount, 0, "overlay must be removed after observation");
    // data-gba-som-id remains on the elements (executor relies on it).
    const stamped = await session.evaluate<number>(
      `document.querySelectorAll('[data-gba-som-id]').length`,
    );
    assert.ok(stamped >= 3);
  } finally {
    await session.close();
  }
});

test("observePage: re-running clears prior stamps and re-numbers", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<button id="b" style="position:fixed;left:0;top:0;width:80px;height:30px">x</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const a = await observePage(session);
    const b = await observePage(session);
    assert.equal(a.marks.length, 1);
    assert.equal(b.marks.length, 1);
    // Each step starts fresh at id=1.
    assert.equal(a.marks[0]?.id, 1);
    assert.equal(b.marks[0]?.id, 1);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// executeAction on real Chrome
// ---------------------------------------------------------------------------

test("executeAction click(mark): fires the marked element's onclick", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<button id="left" style="position:fixed;left:0;top:0;width:200px;height:100px"
  onclick="window.__which='left'">L</button>
<button id="right" style="position:fixed;left:300px;top:0;width:200px;height:100px"
  onclick="window.__which='right'">R</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const obs = await observePage(session);
    const right = obs.marks.find((m) => m.bbox.x >= 300);
    assert.ok(right, "expected to find a mark for the right button");
    if (!right) return;
    const r = await executeAction(
      { type: "click", mark: right.id },
      session,
      obs.marks,
    );
    assert.equal(r.ok, true);
    const which = await session.evaluate<string | null>("window.__which || null");
    assert.equal(which, "right");
  } finally {
    await session.close();
  }
});

test("executeAction type(mark, text, submit): types into the field and submits", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<form id="f" onsubmit="window.__submitted=true;window.__val=document.getElementById('i').value;return false">
  <input id="i" type="text" style="position:fixed;left:20px;top:20px;width:300px;height:40px;font-size:24px">
</form>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const obs = await observePage(session);
    const input = obs.marks.find((m) => m.tag === "input");
    assert.ok(input, "expected an input mark");
    if (!input) return;
    const r = await executeAction(
      { type: "type", mark: input.id, text: "ralph", submit: true },
      session,
      obs.marks,
    );
    assert.equal(r.ok, true);
    const ok = await session.evaluate<boolean>("Boolean(window.__submitted)");
    const v = await session.evaluate<string>("window.__val || ''");
    assert.equal(ok, true);
    assert.equal(v, "ralph");
  } finally {
    await session.close();
  }
});

test("executeAction click(unknown mark): fails softly", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbody%3Eempty%3C%2Fbody%3E");
    const r = await executeAction({ type: "click", mark: 99 }, session, []);
    assert.equal(r.ok, false);
    assert.match(r.message, /unknown mark/);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// buildMessages
// ---------------------------------------------------------------------------

test("buildMessages: multimodal user content with image_url + mark table", () => {
  const obs: SomObservation = {
    url: "https://x/",
    title: "T",
    viewport: { width: 800, height: 600 },
    seq: 1,
    screenshot_jpeg: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    marks: [
      {
        id: 1,
        role: "button",
        name: "Go",
        tag: "button",
        bbox: { x: 10, y: 20, w: 50, h: 30 },
      },
    ],
    text: "",
  };
  const msgs = buildMessages("do thing", obs, []);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.role, "system");
  const userContent = msgs[1]?.content;
  assert.ok(Array.isArray(userContent));
  if (!Array.isArray(userContent)) return;
  assert.equal(userContent.length, 2);
  assert.equal(userContent[0]?.type, "text");
  if (userContent[0]?.type !== "text") return;
  assert.match(userContent[0].text, /Marks \(1\)/);
  assert.match(userContent[0].text, /\[1\] button/);
  assert.equal(userContent[1]?.type, "image_url");
  if (userContent[1]?.type !== "image_url") return;
  assert.match(userContent[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(userContent[1].image_url.detail, "high");
});

test("buildMessages: empty screenshot falls back to text", () => {
  const obs: SomObservation = {
    url: "",
    title: "(observation failed)",
    viewport: { width: 800, height: 600 },
    seq: -1,
    screenshot_jpeg: Buffer.alloc(0),
    marks: [],
    text: "",
  };
  const msgs = buildMessages("g", obs, []);
  assert.equal(typeof msgs[1]?.content, "string");
  assert.match(msgs[1]?.content as string, /SCREENSHOT UNAVAILABLE/);
});

test("toDataUrl: base64 jpeg", () => {
  const obs: SomObservation = {
    url: "",
    title: "",
    viewport: { width: 1, height: 1 },
    seq: 1,
    screenshot_jpeg: Buffer.from([0xff, 0xd8, 0xff]),
    marks: [],
    text: "",
  };
  assert.match(toDataUrl(obs), /^data:image\/jpeg;base64,/);
});

// ---------------------------------------------------------------------------
// End-to-end on real Chrome
// ---------------------------------------------------------------------------

test("run: scripted LLM picks click(mark) → DONE; click landed", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-som-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-som-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<button id="left" style="position:fixed;left:0;top:0;width:200px;height:100px"
  onclick="window.__which='left'">L</button>
<button id="right" style="position:fixed;left:300px;top:0;width:200px;height:100px"
  onclick="window.__which='right'">R</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    // Pre-observe so we know the mark ids are stable (they are 1-based in
    // DOM order). The agent will re-observe and assign the same ids.
    const probe = await observePage(session);
    const right = probe.marks.find((m) => m.bbox.x >= 300);
    assert.ok(right);
    if (!right) return;

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"type":"click","mark":${right.id}}`,
          tokens_in: 50,
          tokens_out: 15,
        },
      },
      {
        reply: {
          text: `{"type":"done","reason":"clicked right"}`,
          tokens_in: 30,
          tokens_out: 10,
        },
      },
    ]);
    const agent = new VisionSomAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "som-click",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run(
      "click the right button",
      session,
      generousBudget(),
      { task_id: "som-click", seed: 0, runs_root: runsRoot },
    );
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2);
    const which = await session.evaluate<string | null>("window.__which || null");
    assert.equal(which, "right");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: parse_error tolerated mid-loop, then done", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-som-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-som-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eparse%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: "no idea", tokens_in: 10, tokens_out: 5 } },
      {
        reply: {
          text: `{"type":"done","reason":"recovered"}`,
          tokens_in: 10,
          tokens_out: 5,
        },
      },
    ]);
    const agent = new VisionSomAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "som-parse",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "som-parse",
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

test("run: max steps without done → DECLINED", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-som-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-som-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Estuck%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"type":"wait","ms":1}`,
          tokens_in: 5,
          tokens_out: 5,
        },
      },
    ]);
    const agent = new VisionSomAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "som-stuck",
        }),
      maxSteps: 3,
    });
    const traj = await agent.run("never finish", session, generousBudget(), {
      task_id: "som-stuck",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DECLINED");
    assert.match(traj.metadata.decline_reason ?? "", /max steps/);
    assert.equal(calls.length, 3);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly on first turn", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-som-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-som-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C%2Ftitle%3E");
    const agent = new VisionSomAgent({
      llmFactory: (b, t) =>
        new LLMClient({ cacheRoot, mode: "replay", budget: b, trajectory: t }),
    });
    const traj = await agent.run("nothing", session, generousBudget(), {
      task_id: "som-no-llm",
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

// ---------------------------------------------------------------------------
// Manifest distinctness
// ---------------------------------------------------------------------------

test("manifest: vision-som distinct_from prior agents, with zero keyword overlap", async () => {
  const priors = [
    "baseline-a11y-react",
    "plan-then-execute",
    "runtime-codegen",
    "speculative-rollback",
    "predicate-driven",
    "vision-grounded",
    "network-shadow",
    "dom-mutation-stream",
  ];
  const somRaw = await readFile(
    new URL("../../../agents/vision-som/manifest.yaml", import.meta.url),
    "utf8",
  );
  const som = parseYaml(somRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };
  for (const target of priors) {
    assert.ok(
      som.distinct_from.includes(target),
      `vision-som.distinct_from must include ${target}`,
    );
  }
  const somSet = new Set(som.approach_keywords.map((k) => k.toLowerCase()));
  for (const target of priors) {
    const raw = await readFile(
      new URL(`../../../agents/${target}/manifest.yaml`, import.meta.url),
      "utf8",
    );
    const m = parseYaml(raw) as { approach_keywords: string[] };
    const other = new Set(m.approach_keywords.map((k) => k.toLowerCase()));
    let overlap = 0;
    for (const k of somSet) if (other.has(k)) overlap += 1;
    assert.equal(overlap, 0, `no shared approach_keywords with ${target}`);
  }
});
