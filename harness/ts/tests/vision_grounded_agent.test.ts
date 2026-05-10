// US-018: vision-grounded agent.
//
// Coverage:
//   - parseAction: success cases for every action kind, fences/prose,
//     coordinate normalisation (object / position / coords array forms),
//     scroll direction shorthand, alias normalisation (DoubleClick → double_click,
//     Hover → move, etc.), unknown-type rejection, missing-coord rejection,
//     missing-text rejection on type, missing-key rejection on press,
//     missing-url rejection on navigate, type clamps wait/scroll deltas.
//   - actionLabel: stable per-type formatting.
//   - executeAction (real Chrome):
//       * click(x,y) at the centre of a button fires its onclick.
//       * type(text) lands in the focused field after a click into it.
//       * press("Enter") submits a form.
//       * scroll(0,0,400) moves window.scrollY downward.
//       * drag(...) generates HTML5 drag-and-drop motion events.
//   - End-to-end runs on real Chrome with a scripted vision LLM:
//       * single-step finish → DONE on first action.
//       * multi-step click → finish.
//       * parse_error tolerated mid-loop.
//       * max-steps without finish → DECLINED.
//   - No-LLM (replay-only client) declines cleanly.
//   - Tight steps budget short-circuits to BUDGET_EXCEEDED.
//   - buildMessages emits multimodal content with image_url.
//   - buildMessages falls back to text when screenshot is empty.
//   - LLMMessage content arrays survive cache hashing (record/replay
//     round-trip with the same vision payload returns the cached entry).
//   - Manifest distinctness vs ALL five prior agents (Jaccard=0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import VisionGroundedAgent, {
  buildMessages,
} from "../../../agents/vision-grounded/agent.js";
import {
  ActionParseError,
  actionLabel,
  executeAction,
  parseAction,
} from "../../../agents/vision-grounded/actions.js";
import {
  digestObservation,
  observePage,
  toDataUrl,
  type VisionObservation,
} from "../../../agents/vision-grounded/observe.js";

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
      // Park on the LAST turn after exhausting the script — lets
      // unexpectedly-long loops keep going without throwing.
      const turn = turns[Math.min(i, turns.length - 1)];
      if (!turn) throw new Error("scriptedProvider: no turns left");
      i += 1;
      return turn.reply;
    },
  };
  return { provider, calls };
}

// -----------------------------------------------------------------------------
// parseAction
// -----------------------------------------------------------------------------

test("parseAction: click {x,y}", () => {
  const a = parseAction(`{"type":"click","x":120,"y":240,"thought":"the Go button"}`);
  assert.equal(a.type, "click");
  if (a.type !== "click") throw new Error("type narrowing");
  assert.equal(a.x, 120);
  assert.equal(a.y, 240);
  assert.equal(a.thought, "the Go button");
});

test("parseAction: ```json fence stripped", () => {
  const a = parseAction("```json\n{\"type\":\"click\",\"x\":10,\"y\":20}\n```");
  assert.equal(a.type, "click");
});

test("parseAction: leading prose tolerated", () => {
  const a = parseAction(
    'Sure! Here is the action:\n{"type":"click","x":30,"y":40}\n',
  );
  assert.equal(a.type, "click");
});

test("parseAction: position object form", () => {
  const a = parseAction(`{"type":"click","position":{"x":5,"y":6}}`);
  if (a.type !== "click") throw new Error("type narrowing");
  assert.equal(a.x, 5);
  assert.equal(a.y, 6);
});

test("parseAction: coords array form", () => {
  const a = parseAction(`{"type":"click","coords":[7,8]}`);
  if (a.type !== "click") throw new Error("type narrowing");
  assert.equal(a.x, 7);
  assert.equal(a.y, 8);
});

test("parseAction: action wrapper variant", () => {
  const a = parseAction(`{"action":{"type":"click","x":1,"y":2},"thought":"outer"}`);
  if (a.type !== "click") throw new Error("type narrowing");
  assert.equal(a.x, 1);
  assert.equal(a.y, 2);
  assert.equal(a.thought, "outer");
});

test("parseAction: alias DoubleClick → double_click", () => {
  const a = parseAction(`{"type":"DoubleClick","x":3,"y":4}`);
  assert.equal(a.type, "double_click");
});

test("parseAction: alias hover → move", () => {
  const a = parseAction(`{"type":"hover","x":3,"y":4}`);
  assert.equal(a.type, "move");
});

test("parseAction: alias goto → navigate", () => {
  const a = parseAction(`{"type":"goto","url":"https://example.com/"}`);
  assert.equal(a.type, "navigate");
  if (a.type !== "navigate") throw new Error("type narrowing");
  assert.equal(a.url, "https://example.com/");
});

test("parseAction: drag with x1/y1/x2/y2", () => {
  const a = parseAction(`{"type":"drag","x1":10,"y1":20,"x2":110,"y2":120}`);
  if (a.type !== "drag") throw new Error("type narrowing");
  assert.equal(a.x1, 10);
  assert.equal(a.y1, 20);
  assert.equal(a.x2, 110);
  assert.equal(a.y2, 120);
});

test("parseAction: drag tolerates from_x / to_x aliases", () => {
  const a = parseAction(
    `{"type":"drag","from_x":1,"from_y":2,"to_x":3,"to_y":4}`,
  );
  if (a.type !== "drag") throw new Error("type narrowing");
  assert.equal(a.x1, 1);
  assert.equal(a.x2, 3);
});

test("parseAction: type with text", () => {
  const a = parseAction(`{"type":"type","text":"hello world"}`);
  if (a.type !== "type") throw new Error("type narrowing");
  assert.equal(a.text, "hello world");
});

test("parseAction: type rejected if text missing", () => {
  assert.throws(() => parseAction(`{"type":"type"}`), ActionParseError);
});

test("parseAction: type rejected if text empty", () => {
  assert.throws(() => parseAction(`{"type":"type","text":""}`), ActionParseError);
});

test("parseAction: press with key", () => {
  const a = parseAction(`{"type":"press","key":"Enter"}`);
  if (a.type !== "press") throw new Error("type narrowing");
  assert.equal(a.key, "Enter");
});

test("parseAction: press rejected if key missing", () => {
  assert.throws(() => parseAction(`{"type":"press"}`), ActionParseError);
});

test("parseAction: scroll with delta_y", () => {
  const a = parseAction(`{"type":"scroll","x":100,"y":200,"delta_y":600}`);
  if (a.type !== "scroll") throw new Error("type narrowing");
  assert.equal(a.x, 100);
  assert.equal(a.y, 200);
  assert.equal(a.delta_y, 600);
});

test("parseAction: scroll with direction shorthand defaults to centre", () => {
  const a = parseAction(`{"type":"scroll","direction":"up"}`);
  if (a.type !== "scroll") throw new Error("type narrowing");
  assert.equal(a.delta_y, -400);
  assert.equal(a.x, 400);
  assert.equal(a.y, 300);
});

test("parseAction: scroll deltas clamped to ±5000", () => {
  const a = parseAction(`{"type":"scroll","x":0,"y":0,"delta_y":99999}`);
  if (a.type !== "scroll") throw new Error("type narrowing");
  assert.equal(a.delta_y, 5000);
});

test("parseAction: wait clamps ms to 0..10000", () => {
  const a = parseAction(`{"type":"wait","ms":99999}`);
  if (a.type !== "wait") throw new Error("type narrowing");
  assert.equal(a.ms, 10_000);
  const b = parseAction(`{"type":"wait","seconds":2}`);
  if (b.type !== "wait") throw new Error("type narrowing");
  assert.equal(b.ms, 2000);
});

test("parseAction: navigate requires url", () => {
  assert.throws(() => parseAction(`{"type":"navigate"}`), ActionParseError);
});

test("parseAction: finish accepted with reason", () => {
  const a = parseAction(`{"type":"finish","reason":"goal looks met"}`);
  if (a.type !== "finish") throw new Error("type narrowing");
  assert.equal(a.reason, "goal looks met");
});

test("parseAction: finish gets default reason if absent", () => {
  const a = parseAction(`{"type":"finish"}`);
  if (a.type !== "finish") throw new Error("type narrowing");
  assert.match(a.reason, /goal/i);
});

test("parseAction: unknown type rejected", () => {
  assert.throws(() => parseAction(`{"type":"yodel","x":1,"y":2}`), ActionParseError);
});

test("parseAction: missing JSON object rejected", () => {
  assert.throws(() => parseAction(`absolutely no json here`), ActionParseError);
});

test("parseAction: missing coords on click rejected", () => {
  assert.throws(() => parseAction(`{"type":"click"}`), ActionParseError);
});

// -----------------------------------------------------------------------------
// actionLabel
// -----------------------------------------------------------------------------

test("actionLabel: stable per type", () => {
  assert.equal(actionLabel({ type: "click", x: 1, y: 2 }), "click(1,2)");
  assert.equal(
    actionLabel({ type: "double_click", x: 3, y: 4 }),
    "double_click(3,4)",
  );
  assert.equal(actionLabel({ type: "move", x: 5, y: 6 }), "move(5,6)");
  assert.equal(
    actionLabel({ type: "drag", x1: 1, y1: 2, x2: 3, y2: 4 }),
    "drag(1,2→3,4)",
  );
  assert.equal(actionLabel({ type: "type", text: "abc" }), `type("abc")`);
  assert.equal(actionLabel({ type: "press", key: "Enter" }), "press(Enter)");
  assert.equal(
    actionLabel({ type: "scroll", x: 0, y: 0, delta_y: 100 }),
    "scroll(0,0,dy=100)",
  );
  assert.equal(actionLabel({ type: "wait", ms: 250 }), "wait(250ms)");
  assert.equal(
    actionLabel({ type: "navigate", url: "https://x/" }),
    "navigate(https://x/)",
  );
  assert.equal(
    actionLabel({ type: "finish", reason: "done" }),
    "finish(done)",
  );
});

// -----------------------------------------------------------------------------
// executeAction on real Chrome (CDP Input.* dispatch)
// -----------------------------------------------------------------------------

test("executeAction click(x,y): centre of a button fires its onclick", async () => {
  const session = await CdpBrowserSession.create();
  try {
    // Place a single button at a known viewport position so we can click its
    // visible centre. Use a wide button so floating-point rounding is harmless.
    const html = `<!doctype html><body style="margin:0">
<button id="b" style="position:fixed;left:50px;top:50px;width:200px;height:80px"
  onclick="window.__test=(window.__test||0)+1">Hit me</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    // Centre of the button in viewport coords: 50+100=150, 50+40=90.
    const r = await executeAction(
      { type: "click", x: 150, y: 90 },
      session,
      { width: 800, height: 600 },
    );
    assert.equal(r.ok, true);
    const hits = await session.evaluate<number>("(window.__test || 0)");
    assert.equal(hits, 1);
  } finally {
    await session.close();
  }
});

test("executeAction type(text) lands in focused input after a click", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<input id="i" type="text" style="position:fixed;left:20px;top:20px;width:300px;height:40px;font-size:24px">
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    // Click into the input centre: 20+150=170, 20+20=40.
    await executeAction({ type: "click", x: 170, y: 40 }, session, {
      width: 800,
      height: 600,
    });
    const r = await executeAction(
      { type: "type", text: "ralph" },
      session,
      { width: 800, height: 600 },
    );
    assert.equal(r.ok, true);
    const v = await session.evaluate<string>(
      "document.getElementById('i').value",
    );
    assert.equal(v, "ralph");
  } finally {
    await session.close();
  }
});

test("executeAction press('Enter') submits a form", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<form id="f" onsubmit="window.__submitted=true;return false">
  <input id="i" type="text" style="position:fixed;left:20px;top:20px;width:300px;height:40px;font-size:24px">
</form>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    await executeAction({ type: "click", x: 170, y: 40 }, session, {
      width: 800,
      height: 600,
    });
    await executeAction({ type: "type", text: "x" }, session, {
      width: 800,
      height: 600,
    });
    await executeAction({ type: "press", key: "Enter" }, session, {
      width: 800,
      height: 600,
    });
    const ok = await session.evaluate<boolean>("Boolean(window.__submitted)");
    assert.equal(ok, true);
  } finally {
    await session.close();
  }
});

test("executeAction scroll(x,y,dy=400) advances window.scrollY", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<div style="height:5000px;background:linear-gradient(180deg,red,blue)"></div>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const beforeY = await session.evaluate<number>("window.scrollY");
    await executeAction(
      { type: "scroll", x: 400, y: 300, delta_y: 800 },
      session,
      { width: 800, height: 600 },
    );
    // Wheel scrolls are async; poll for a brief moment.
    let afterY = beforeY;
    for (let i = 0; i < 20 && afterY <= beforeY; i++) {
      await new Promise((r) => setTimeout(r, 20));
      afterY = await session.evaluate<number>("window.scrollY");
    }
    assert.ok(afterY > beforeY, `expected scrollY to advance, got ${afterY} <= ${beforeY}`);
  } finally {
    await session.close();
  }
});

test("executeAction drag generates intermediate mousemove events", async () => {
  const session = await CdpBrowserSession.create();
  try {
    // Page records every mousemove between mousedown and mouseup.
    const html = `<!doctype html><body style="margin:0">
<div id="surface" style="width:800px;height:600px;background:#eef"></div>
<script>
window.__mousedowns = 0;
window.__moves_during_drag = 0;
window.__mouseups = 0;
let dragging = false;
document.addEventListener('mousedown', () => { dragging = true; window.__mousedowns++; });
document.addEventListener('mousemove', () => { if (dragging) window.__moves_during_drag++; });
document.addEventListener('mouseup', () => { dragging = false; window.__mouseups++; });
</script>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    await executeAction(
      { type: "drag", x1: 100, y1: 100, x2: 500, y2: 400 },
      session,
      { width: 800, height: 600 },
    );
    const downs = await session.evaluate<number>("window.__mousedowns");
    const moves = await session.evaluate<number>("window.__moves_during_drag");
    const ups = await session.evaluate<number>("window.__mouseups");
    assert.equal(downs, 1);
    assert.equal(ups, 1);
    assert.ok(moves >= 4, `expected several intermediate mousemove events, got ${moves}`);
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// observePage on real Chrome
// -----------------------------------------------------------------------------

test("observePage: returns viewport meta + non-empty JPEG", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(
      "data:text/html,%3Ctitle%3Eobs-test%3C%2Ftitle%3E%3Cbody%3Ehello%3C%2Fbody%3E",
    );
    const obs = await observePage(session);
    assert.equal(obs.title, "obs-test");
    assert.ok(obs.viewport.width > 0);
    assert.ok(obs.viewport.height > 0);
    assert.ok(obs.screenshot_jpeg.length > 0);
    // JPEG magic bytes: FF D8 FF.
    assert.equal(obs.screenshot_jpeg[0], 0xff);
    assert.equal(obs.screenshot_jpeg[1], 0xd8);
    assert.equal(obs.screenshot_jpeg[2], 0xff);
    const dataUrl = toDataUrl(obs);
    assert.match(dataUrl, /^data:image\/jpeg;base64,/);
    assert.match(digestObservation(obs), /jpeg=/);
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// buildMessages: multimodal + text-fallback
// -----------------------------------------------------------------------------

test("buildMessages: multimodal user content with image_url, default detail=high", () => {
  const obs: VisionObservation = {
    url: "https://x/",
    title: "T",
    viewport: { width: 800, height: 600 },
    seq: 1,
    screenshot_jpeg: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
  };
  const msgs = buildMessages("do the thing", obs, []);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.role, "system");
  assert.equal(typeof msgs[0]?.content, "string");
  assert.equal(msgs[1]?.role, "user");
  const userContent = msgs[1]?.content;
  assert.ok(Array.isArray(userContent), "user content must be a multimodal array");
  if (!Array.isArray(userContent)) throw new Error("array narrowing");
  assert.equal(userContent.length, 2);
  assert.equal(userContent[0]?.type, "text");
  assert.equal(userContent[1]?.type, "image_url");
  if (userContent[1]?.type !== "image_url") throw new Error("type narrowing");
  assert.match(userContent[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(
    userContent[1].image_url.detail,
    "high",
    "default detail tier is 'high' for accurate pixel localisation",
  );
});

test("buildMessages: caller can override image detail to low", () => {
  const obs: VisionObservation = {
    url: "https://x/",
    title: "T",
    viewport: { width: 800, height: 600 },
    seq: 1,
    screenshot_jpeg: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
  };
  const msgs = buildMessages("g", obs, [], "low");
  const userContent = msgs[1]?.content;
  if (!Array.isArray(userContent)) throw new Error("array narrowing");
  if (userContent[1]?.type !== "image_url") throw new Error("type narrowing");
  assert.equal(userContent[1].image_url.detail, "low");
});

test("buildMessages: empty screenshot falls back to plain text user message", () => {
  const obs: VisionObservation = {
    url: "",
    title: "(observation failed: x)",
    viewport: { width: 800, height: 600 },
    seq: -1,
    screenshot_jpeg: Buffer.alloc(0),
  };
  const msgs = buildMessages("g", obs, []);
  assert.equal(typeof msgs[1]?.content, "string");
  assert.match(msgs[1]?.content as string, /SCREENSHOT UNAVAILABLE/);
});

// -----------------------------------------------------------------------------
// Cache key: vision message round-trips through record/replay
// -----------------------------------------------------------------------------

test("LLMClient: cache key handles multimodal content; record then replay returns the same entry", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-vision-cache-"));
  try {
    const calls: ProviderRequest[] = [];
    const provider: LLMProvider = {
      name: "openai",
      async call(req) {
        calls.push(req);
        return { text: '{"type":"finish","reason":"ok"}', tokens_in: 10, tokens_out: 5 };
      },
    };
    const client = new LLMClient({
      cacheRoot,
      mode: "record",
      providers: { openai: provider },
    });
    const messages = [
      { role: "system" as const, content: "system prompt" },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "look at this" },
          {
            type: "image_url" as const,
            image_url: { url: "data:image/jpeg;base64,/9j/AAA=", detail: "auto" as const },
          },
        ],
      },
    ];
    const r1 = await client.call("gpt-4o-mini", messages, { temperature: 0 });
    assert.equal(r1.cached, false);
    assert.equal(calls.length, 1);
    // Same payload again → cached.
    const r2 = await client.call("gpt-4o-mini", messages, { temperature: 0 });
    assert.equal(r2.cached, true);
    assert.equal(calls.length, 1, "second call must hit cache, not provider");
    assert.equal(r1.prompt_hash, r2.prompt_hash);
    // A different image bumps the cache key.
    const messages2 = [
      messages[0]!,
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "look at this" },
          {
            type: "image_url" as const,
            image_url: { url: "data:image/jpeg;base64,/9j/BBB=", detail: "auto" as const },
          },
        ],
      },
    ];
    const r3 = await client.call("gpt-4o-mini", messages2, { temperature: 0 });
    assert.equal(r3.cached, false);
    assert.equal(calls.length, 2);
    assert.notEqual(r1.prompt_hash, r3.prompt_hash);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// End-to-end runs on real Chrome
// -----------------------------------------------------------------------------

test("run: single-step finish → DONE", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-vis-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-vis-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(
      "data:text/html,%3Ctitle%3Edone%3C%2Ftitle%3E%3Cbody%3Eok%3C%2Fbody%3E",
    );
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"type":"finish","reason":"page already shows ok"}`,
          tokens_in: 50,
          tokens_out: 15,
        },
      },
    ]);
    const agent = new VisionGroundedAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "vis-finish",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("do nothing", session, generousBudget(), {
      task_id: "vis-finish",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 1);
    // First call should have been multimodal (the user content is an array).
    const userMsg = calls[0]?.messages?.[1];
    assert.ok(Array.isArray(userMsg?.content), "vision call must send array content");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: click then finish → DONE; click landed on the right button via coords", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-vis-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-vis-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><body style="margin:0">
<button id="left" style="position:fixed;left:0;top:0;width:200px;height:100px"
  onclick="window.__which='left'">L</button>
<button id="right" style="position:fixed;left:400px;top:0;width:200px;height:100px"
  onclick="window.__which='right'">R</button>
</body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const { provider, calls } = scriptedProvider([
      // First action: click the right button at its visible centre (500, 50).
      {
        reply: {
          text: `{"type":"click","x":500,"y":50}`,
          tokens_in: 50,
          tokens_out: 15,
        },
      },
      // Second action: finish.
      {
        reply: {
          text: `{"type":"finish","reason":"clicked the right one"}`,
          tokens_in: 30,
          tokens_out: 10,
        },
      },
    ]);

    const agent = new VisionGroundedAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "vis-click",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run(
      "click the right button",
      session,
      generousBudget(),
      { task_id: "vis-click", seed: 0, runs_root: runsRoot },
    );
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2);
    const which = await session.evaluate<string | null>("window.__which || null");
    assert.equal(which, "right");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; x?: number; y?: number };
    }>;
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.action.type, "click");
    assert.equal(steps[0]?.action.x, 500);
    assert.equal(steps[0]?.action.y, 50);
    assert.equal(steps[1]?.action.type, "finish");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: parse_error tolerated mid-loop, agent recovers and finishes", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-vis-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-vis-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eparse%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      // Garbage first turn.
      { reply: { text: "I have no idea", tokens_in: 10, tokens_out: 5 } },
      // Then finish.
      {
        reply: {
          text: `{"type":"finish","reason":"recovered"}`,
          tokens_in: 10,
          tokens_out: 5,
        },
      },
    ]);
    const agent = new VisionGroundedAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "vis-parse",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "vis-parse",
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

test("run: max steps without finish → DECLINED", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-vis-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-vis-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(
      "data:text/html,%3Ctitle%3Estuck%3C%2Ftitle%3E%3Cbody%3Estuck%3C%2Fbody%3E",
    );
    const { provider, calls } = scriptedProvider([
      // Will be served on every turn (parked on last).
      {
        reply: {
          text: `{"type":"wait","ms":1}`,
          tokens_in: 5,
          tokens_out: 5,
        },
      },
    ]);
    const agent = new VisionGroundedAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "vis-stuck",
        }),
      maxSteps: 3,
    });
    const traj = await agent.run("never finish", session, generousBudget(), {
      task_id: "vis-stuck",
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
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-vis-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-vis-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C%2Ftitle%3E");
    const agent = new VisionGroundedAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("nothing", session, generousBudget(), {
      task_id: "vis-no-llm",
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

test("run: tight steps budget short-circuits to BUDGET_EXCEEDED with no LLM calls", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-vis-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-vis-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Et%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      {
        reply: { text: `{"type":"finish","reason":"x"}`, tokens_in: 1, tokens_out: 1 },
      },
    ]);
    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep();
    const agent = new VisionGroundedAgent({
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
      task_id: "vis-tight",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "BUDGET_EXCEEDED");
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

test("manifest: vision-grounded distinct_from all five prior agents, with zero keyword overlap", async () => {
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
  const visRaw = await readFile(
    new URL("../../../agents/vision-grounded/manifest.yaml", import.meta.url),
    "utf8",
  );
  const baseline = parseYaml(baselineRaw) as { approach_keywords: string[] };
  const pte = parseYaml(pteRaw) as { approach_keywords: string[] };
  const rcg = parseYaml(rcgRaw) as { approach_keywords: string[] };
  const srb = parseYaml(srbRaw) as { approach_keywords: string[] };
  const pred = parseYaml(predRaw) as { approach_keywords: string[] };
  const vis = parseYaml(visRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };

  for (const target of [
    "baseline-a11y-react",
    "plan-then-execute",
    "runtime-codegen",
    "speculative-rollback",
    "predicate-driven",
  ]) {
    assert.ok(
      vis.distinct_from.includes(target),
      `vision-grounded.distinct_from must include ${target}`,
    );
  }

  const visSet = new Set(vis.approach_keywords.map((k) => k.toLowerCase()));
  for (const [name, manifest] of [
    ["baseline-a11y-react", baseline],
    ["plan-then-execute", pte],
    ["runtime-codegen", rcg],
    ["speculative-rollback", srb],
    ["predicate-driven", pred],
  ] as const) {
    const other = new Set(manifest.approach_keywords.map((k) => k.toLowerCase()));
    let overlap = 0;
    for (const k of visSet) if (other.has(k)) overlap += 1;
    assert.equal(overlap, 0, `no shared approach_keywords with ${name}`);
  }
});
