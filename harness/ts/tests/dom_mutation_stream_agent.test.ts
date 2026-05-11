// US-020: dom-mutation-stream agent.
//
// Coverage:
//   - parseAction: click / type / scroll / wait / await_change /
//     navigate / done / decline, fences + prose tolerance, aliases
//     (target / target_aid / id → aid), defaults, error paths.
//   - actionLabel rendering for each shape.
//   - isStateChanging predicate (drives auto-settle).
//   - Observer install on real Chrome:
//       * MutationObserver fires for added/removed/attribute/text
//         mutations; entries land in window.__gba_dom_log with
//         monotonic seq.
//       * Idempotent double-install is a no-op.
//       * readMutations(since) returns only the newer slice.
//       * snapshotPage tags interactive elements with
//         data-gba-stream-aid and the same aid persists across
//         snapshots.
//   - settleAfter blocks until a triggered mutation lands.
//   - awaitChange returns {changed:true} when a mutation arrives,
//     {changed:false} when the timeout fires.
//   - executeAction on real Chrome: click flips state, type sets
//     value + dispatches input/change, scroll moves window.scrollY,
//     wait waits.
//   - End-to-end runs on real Chrome with scripted LLM:
//       * click + done → trajectory DONE, mutation_delta recorded.
//       * parse_error mid-loop is tolerated; loop recovers.
//       * No-LLM (replay-only) declines cleanly.
//       * Tight steps budget short-circuits to BUDGET_EXCEEDED.
//   - Manifest distinctness vs ALL seven prior agents (baseline,
//     plan-then-execute, runtime-codegen, speculative-rollback,
//     predicate-driven, vision-grounded, network-shadow) with zero
//     keyword overlap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import DomMutationStreamAgent from "../../../agents/dom-mutation-stream/agent.js";
import {
  ActionParseError,
  actionLabel,
  executeAction,
  isStateChanging,
  parseAction,
} from "../../../agents/dom-mutation-stream/actions.js";
import {
  awaitChange,
  clearMutations,
  installObserver,
  readCurrentSeq,
  readMutations,
  settleAfter,
  snapshotPage,
} from "../../../agents/dom-mutation-stream/observer.js";

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
// parseAction
// -----------------------------------------------------------------------------

test("parseAction: click + aid", () => {
  const a = parseAction(`{"type":"click","aid":7,"thought":"go"}`);
  assert.equal(a.type, "click");
  if (a.type === "click") {
    assert.equal(a.aid, 7);
    assert.equal(a.thought, "go");
  }
});

test("parseAction: click accepts target / target_aid / id aliases", () => {
  for (const k of ["target", "target_aid", "id"]) {
    const obj: Record<string, unknown> = { type: "click" };
    obj[k] = 12;
    const a = parseAction(JSON.stringify(obj));
    if (a.type === "click") assert.equal(a.aid, 12);
    else assert.fail(`alias ${k} did not produce click`);
  }
});

test("parseAction: click string aid coerces to number", () => {
  const a = parseAction(`{"type":"click","aid":"15"}`);
  if (a.type === "click") assert.equal(a.aid, 15);
  else assert.fail("expected click");
});

test("parseAction: click missing aid rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"click"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /aid/.test((err as Error).message),
  );
});

test("parseAction: type + aid + text + submit", () => {
  const a = parseAction(`{"type":"type","aid":3,"text":"hi","submit":true}`);
  if (a.type === "type") {
    assert.equal(a.aid, 3);
    assert.equal(a.text, "hi");
    assert.equal(a.submit, true);
  } else assert.fail("expected type");
});

test("parseAction: type missing text rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"type","aid":3}`),
    (err: unknown) =>
      err instanceof ActionParseError && /text/.test((err as Error).message),
  );
});

test("parseAction: scroll defaults to down, accepts pixels", () => {
  const a = parseAction(`{"type":"scroll","direction":"up","pixels":900}`);
  if (a.type === "scroll") {
    assert.equal(a.direction, "up");
    assert.equal(a.pixels, 900);
  } else assert.fail();
  const b = parseAction(`{"type":"scroll"}`);
  if (b.type === "scroll") assert.equal(b.direction, "down");
  else assert.fail();
});

test("parseAction: wait clamps to <=5s and floors negative", () => {
  const w = parseAction(`{"type":"wait","ms":900}`);
  if (w.type === "wait") assert.equal(w.ms, 900);
  const big = parseAction(`{"type":"wait","ms":99999}`);
  if (big.type === "wait") assert.equal(big.ms, 5000);
  const neg = parseAction(`{"type":"wait","ms":-10}`);
  if (neg.type === "wait") assert.equal(neg.ms, 0);
});

test("parseAction: await_change defaults to 1500ms if zero, clamps to 10s", () => {
  const z = parseAction(`{"type":"await_change","timeout_ms":0}`);
  if (z.type === "await_change") assert.equal(z.timeout_ms, 1500);
  const big = parseAction(`{"type":"await_change","timeout_ms":999999}`);
  if (big.type === "await_change") assert.equal(big.timeout_ms, 10_000);
  const ok = parseAction(`{"type":"await_change","timeout_ms":2200}`);
  if (ok.type === "await_change") assert.equal(ok.timeout_ms, 2200);
});

test("parseAction: await_change accepts hyphen alias", () => {
  const a = parseAction(`{"type":"await-change","timeout_ms":1000}`);
  assert.equal(a.type, "await_change");
});

test("parseAction: navigate + url", () => {
  const a = parseAction(`{"type":"navigate","url":"https://x"}`);
  if (a.type === "navigate") assert.equal(a.url, "https://x");
  else assert.fail();
});

test("parseAction: navigate missing url rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"navigate"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /url/.test((err as Error).message),
  );
});

test("parseAction: done + decline + reason defaults", () => {
  const d = parseAction(`{"type":"done"}`);
  if (d.type === "done") assert.equal(d.reason, "goal reached");
  else assert.fail();
  const x = parseAction(`{"type":"decline"}`);
  if (x.type === "decline") assert.equal(x.reason, "cannot proceed");
  else assert.fail();
});

test("parseAction: ```json fence stripped", () => {
  const a = parseAction("```json\n{\"type\":\"done\",\"reason\":\"x\"}\n```");
  assert.equal(a.type, "done");
});

test("parseAction: prose preceding JSON tolerated", () => {
  const a = parseAction('Looking at the mutation tail, {"type":"done","reason":"ok"}');
  assert.equal(a.type, "done");
});

test("parseAction: unknown type rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"teleport"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /unknown/.test((err as Error).message),
  );
});

test("parseAction: empty completion rejected", () => {
  assert.throws(
    () => parseAction(""),
    (err: unknown) => err instanceof ActionParseError,
  );
});

// -----------------------------------------------------------------------------
// actionLabel
// -----------------------------------------------------------------------------

test("actionLabel renders each action shape", () => {
  assert.equal(actionLabel({ type: "click", aid: 4 }), "click(aid=4)");
  assert.equal(actionLabel({ type: "type", aid: 1, text: "hello" }), 'type(aid=1, "hello")');
  assert.equal(actionLabel({ type: "type", aid: 1, text: "hi", submit: true }), 'type(aid=1, "hi", submit)');
  assert.equal(actionLabel({ type: "scroll", direction: "down" }), "scroll(down)");
  assert.equal(actionLabel({ type: "scroll", direction: "up", pixels: 200 }), "scroll(up, 200px)");
  assert.equal(actionLabel({ type: "wait", ms: 500 }), "wait(500ms)");
  assert.equal(actionLabel({ type: "await_change", timeout_ms: 1500 }), "await_change(1500ms)");
  assert.equal(actionLabel({ type: "navigate", url: "https://y" }), "navigate(https://y)");
  assert.equal(actionLabel({ type: "done", reason: "ok" }), "done(ok)");
  assert.equal(actionLabel({ type: "decline", reason: "stuck" }), "decline(stuck)");
});

test("isStateChanging gates settle-after-action correctly", () => {
  assert.equal(isStateChanging({ type: "click", aid: 1 }), true);
  assert.equal(isStateChanging({ type: "type", aid: 1, text: "x" }), true);
  assert.equal(isStateChanging({ type: "scroll", direction: "down" }), true);
  assert.equal(isStateChanging({ type: "navigate", url: "x" }), true);
  assert.equal(isStateChanging({ type: "wait", ms: 1 }), false);
  assert.equal(isStateChanging({ type: "await_change", timeout_ms: 1 }), false);
  assert.equal(isStateChanging({ type: "done", reason: "x" }), false);
  assert.equal(isStateChanging({ type: "decline", reason: "x" }), false);
});

// -----------------------------------------------------------------------------
// MutationObserver install on real Chrome
// -----------------------------------------------------------------------------

test("installObserver captures childList + attribute + text mutations with monotonic seq", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>mut</title><body>
      <div id="root"><p id="p1">hello</p></div>
    </body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    await installObserver(session);

    // Trigger a few mutations.
    await session.evaluate(`(() => {
      const root = document.getElementById('root');
      const span = document.createElement('span');
      span.id = 'added';
      span.textContent = 'new';
      root.appendChild(span);
      const p = document.getElementById('p1');
      p.setAttribute('data-x', 'one');
      p.firstChild.data = 'world';
      root.removeChild(span);
    })()`);

    // Mutations are async — wait one tick.
    await new Promise((r) => setTimeout(r, 100));
    const slice = await readMutations(session, 0);
    assert.ok(slice.entries.length >= 4, `got ${slice.entries.length} entries`);

    // seq strictly increasing
    for (let i = 1; i < slice.entries.length; i++) {
      assert.ok(slice.entries[i]!.seq > slice.entries[i - 1]!.seq, "seq strictly increasing");
    }

    // Kinds we expect to see at least once.
    const kinds = new Set(slice.entries.map((e) => e.kind));
    assert.ok(kinds.has("added"));
    assert.ok(kinds.has("removed"));
    assert.ok(kinds.has("attr"));
  } finally {
    await session.close();
  }
});

test("installObserver is idempotent: a second install is a no-op", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body><div id=r></div></body>");
    await installObserver(session);
    await installObserver(session);

    await session.evaluate(
      `document.getElementById('r').appendChild(document.createElement('span'))`,
    );
    await new Promise((r) => setTimeout(r, 80));
    const slice = await readMutations(session, 0);
    const added = slice.entries.filter((e) => e.kind === "added");
    // If the observer were installed twice, each childList mutation would
    // produce two log entries. The idempotency guard short-circuits the
    // second install so each mutation produces exactly one entry.
    assert.equal(added.length, 1, `expected one added entry, got ${added.length}`);
  } finally {
    await session.close();
  }
});

test("readMutations with `since` returns only entries newer than the cursor", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body><div id=r></div></body>");
    await installObserver(session);
    await session.evaluate(
      `document.getElementById('r').appendChild(document.createElement('span'))`,
    );
    await new Promise((r) => setTimeout(r, 60));
    const first = await readMutations(session, 0);
    assert.ok(first.entries.length >= 1);
    const cursor = first.currentSeq;
    // No new mutations → slice should be empty.
    const empty = await readMutations(session, cursor);
    assert.equal(empty.entries.length, 0);
    assert.equal(empty.currentSeq, cursor);
    // New mutation → slice should contain only it.
    await session.evaluate(
      `document.getElementById('r').appendChild(document.createElement('b'))`,
    );
    await new Promise((r) => setTimeout(r, 60));
    const next = await readMutations(session, cursor);
    assert.equal(next.entries.length, 1);
    assert.ok(next.entries[0]!.seq > cursor);
  } finally {
    await session.close();
  }
});

test("snapshotPage tags interactive elements with stable data-gba-stream-aid", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(
      "data:text/html," +
        encodeURIComponent(
          `<body><button id="a">A</button><input id="b" name="b"/><a href="#x">link</a></body>`,
        ),
    );
    const s1 = await snapshotPage(session);
    assert.ok(s1.elements.length >= 3);
    // Distinct aids
    const aids = new Set(s1.elements.map((e) => e.aid));
    assert.equal(aids.size, s1.elements.length);

    // Re-snapshot: aids stable
    const s2 = await snapshotPage(session);
    assert.equal(s2.elements.length, s1.elements.length);
    for (let i = 0; i < s1.elements.length; i++) {
      assert.equal(s2.elements[i]!.aid, s1.elements[i]!.aid);
    }
  } finally {
    await session.close();
  }
});

test("clearMutations drains the log", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body><div id=r></div></body>");
    await installObserver(session);
    await session.evaluate(
      `document.getElementById('r').appendChild(document.createElement('span'))`,
    );
    await new Promise((r) => setTimeout(r, 60));
    const before = await readMutations(session, 0);
    assert.ok(before.entries.length >= 1);
    await clearMutations(session);
    // currentSeq stays advanced (monotonic counter), but the log array is empty.
    const after = await readMutations(session, 0);
    assert.equal(after.entries.length, 0);
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// settleAfter / awaitChange
// -----------------------------------------------------------------------------

test("settleAfter blocks until a triggered mutation lands and quiesces", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body><div id=r></div></body>");
    await installObserver(session);
    const seqBefore = await readCurrentSeq(session);
    // Fire a delayed mutation from inside the page (settleAfter awaits in-page).
    void session.evaluate(`
      setTimeout(() => {
        document.getElementById('r').appendChild(document.createElement('span'));
      }, 50)
    `);
    const t0 = Date.now();
    const r = await settleAfter(session, seqBefore, 1200, 100);
    assert.ok(r.changed, "settle should have observed the mutation");
    assert.ok(r.newSeq > seqBefore, "newSeq advanced");
    assert.ok(Date.now() - t0 < 1000, "settled long before timeout");
  } finally {
    await session.close();
  }
});

test("awaitChange returns {changed:false} when no mutation arrives before timeout", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body><div id=r></div></body>");
    await installObserver(session);
    const seqBefore = await readCurrentSeq(session);
    const t0 = Date.now();
    const r = await awaitChange(session, seqBefore, 200);
    assert.equal(r.changed, false);
    assert.ok(Date.now() - t0 >= 150);
    assert.equal(r.newSeq, seqBefore);
  } finally {
    await session.close();
  }
});

test("awaitChange returns {changed:true} as soon as a mutation arrives", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body><div id=r></div></body>");
    await installObserver(session);
    const seqBefore = await readCurrentSeq(session);
    void session.evaluate(`
      setTimeout(() => {
        document.getElementById('r').appendChild(document.createElement('i'));
      }, 30)
    `);
    const r = await awaitChange(session, seqBefore, 1000);
    assert.equal(r.changed, true);
    assert.ok(r.newSeq > seqBefore);
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// executeAction on real Chrome
// -----------------------------------------------------------------------------

test("executeAction click: dispatches onto aid-tagged element", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(
      "data:text/html," +
        encodeURIComponent(
          `<body><button id="b" onclick="window.__hit=true">Go</button></body>`,
        ),
    );
    const snap = await snapshotPage(session);
    const btn = snap.elements.find((e) => e.tag === "button");
    assert.ok(btn, "expected a button in the snapshot");
    const r = await executeAction({ type: "click", aid: btn!.aid }, session, snap);
    assert.equal(r.ok, true);
    const hit = await session.evaluate<boolean>("Boolean(window.__hit)");
    assert.equal(hit, true);
  } finally {
    await session.close();
  }
});

test("executeAction click: missing aid reports fail", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(
      "data:text/html," +
        encodeURIComponent(`<body><button>A</button></body>`),
    );
    const snap = await snapshotPage(session);
    const r = await executeAction({ type: "click", aid: 999 }, session, snap);
    assert.equal(r.ok, false);
    assert.match(r.message, /no element/);
  } finally {
    await session.close();
  }
});

test("executeAction type: sets value, dispatches input/change, optional submit", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<body>
      <form id=f onsubmit="window.__submitted=true; return false">
        <input id=i name=n />
      </form>
    </body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const snap = await snapshotPage(session);
    const inp = snap.elements.find((e) => e.tag === "input");
    assert.ok(inp);
    const r = await executeAction(
      { type: "type", aid: inp!.aid, text: "hello", submit: true },
      session,
      snap,
    );
    assert.equal(r.ok, true);
    const v = await session.evaluate<string>(`document.getElementById('i').value`);
    assert.equal(v, "hello");
    const submitted = await session.evaluate<boolean>("Boolean(window.__submitted)");
    assert.equal(submitted, true);
  } finally {
    await session.close();
  }
});

test("executeAction scroll: moves window.scrollY", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<body style="margin:0">
      <div style="height:3000px;width:100px"></div>
    </body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const r = await executeAction({ type: "scroll", direction: "down", pixels: 500 }, session, null);
    assert.equal(r.ok, true);
    const y = await session.evaluate<number>("window.scrollY");
    assert.ok(y >= 400, `scrollY ${y} should be at least 400`);
  } finally {
    await session.close();
  }
});

test("executeAction wait: waits at least N ms", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body></body>");
    const t0 = Date.now();
    await executeAction({ type: "wait", ms: 120 }, session, null);
    assert.ok(Date.now() - t0 >= 100);
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// End-to-end runs on real Chrome with scripted LLM
// -----------------------------------------------------------------------------

test("run: click + done → trajectory DONE with mutation_delta>=1", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-dms-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-dms-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<body>
      <button id=b onclick="
        document.title='hit';
        const span = document.createElement('span');
        span.id='added';
        span.textContent='ok';
        document.body.appendChild(span);
      ">Buy</button>
    </body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    // Pre-discover the aid so the scripted LLM can quote it. snapshotPage
    // assigns aids in author order; the agent will see the same numbering
    // when it snapshots on step 1.
    const probe = await snapshotPage(session);
    const btn = probe.elements.find((e) => e.tag === "button");
    assert.ok(btn);

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"type":"click","aid":${btn!.aid},"thought":"buy"}`,
          tokens_in: 100,
          tokens_out: 60,
        },
      },
      {
        reply: {
          text: `{"type":"done","reason":"title flipped to hit"}`,
          tokens_in: 60,
          tokens_out: 30,
        },
      },
    ]);

    const agent = new DomMutationStreamAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-dms-done",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("click the buy button", session, generousBudget(), {
      task_id: "dms-done",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2, "click + done");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; aid?: number; mutation_delta?: number };
    }>;
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.action.type, "click");
    assert.equal(steps[0]?.action.aid, btn!.aid);
    assert.ok((steps[0]?.action.mutation_delta ?? 0) >= 1, "click should produce mutation delta");
    assert.equal(steps[1]?.action.type, "done");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: parse_error mid-loop is tolerated and loop recovers", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-dms-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-dms-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(
      "data:text/html," +
        encodeURIComponent(`<body><button id=b onclick="window.__hit=true">A</button></body>`),
    );
    const probe = await snapshotPage(session);
    const btn = probe.elements.find((e) => e.tag === "button");
    assert.ok(btn);

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `Not sure — maybe click?`,
          tokens_in: 40,
          tokens_out: 20,
        },
      },
      {
        reply: {
          text: `{"type":"click","aid":${btn!.aid}}`,
          tokens_in: 60,
          tokens_out: 30,
        },
      },
      {
        reply: {
          text: `{"type":"done","reason":"clicked"}`,
          tokens_in: 50,
          tokens_out: 20,
        },
      },
    ]);

    const agent = new DomMutationStreamAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-dms-parse",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("click", session, generousBudget(), {
      task_id: "dms-parse",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 3);

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string };
    }>;
    assert.equal(steps.length, 3);
    assert.equal(steps[0]?.action.type, "parse_error");
    assert.equal(steps[1]?.action.type, "click");
    assert.equal(steps[2]?.action.type, "done");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-dms-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-dms-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body></body>");
    const agent = new DomMutationStreamAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "dms-no-llm",
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
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-dms-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-dms-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,<body></body>");
    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep();

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"type":"done","reason":"x"}`,
          tokens_in: 10,
          tokens_out: 5,
        },
      },
    ]);

    const agent = new DomMutationStreamAgent({
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
      task_id: "dms-tight",
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

test("manifest: dom-mutation-stream distinct_from ALL seven prior agents with zero keyword overlap", async () => {
  const priors = [
    "baseline-a11y-react",
    "plan-then-execute",
    "runtime-codegen",
    "speculative-rollback",
    "predicate-driven",
    "vision-grounded",
    "network-shadow",
  ];
  const ownRaw = await readFile(
    new URL("../../../agents/dom-mutation-stream/manifest.yaml", import.meta.url),
    "utf8",
  );
  const own = parseYaml(ownRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };
  for (const target of priors) {
    assert.ok(
      own.distinct_from.includes(target),
      `dom-mutation-stream.distinct_from must include ${target}`,
    );
  }
  const ownSet = new Set(own.approach_keywords.map((k) => k.toLowerCase()));
  for (const id of priors) {
    const raw = await readFile(
      new URL(`../../../agents/${id}/manifest.yaml`, import.meta.url),
      "utf8",
    );
    const other = parseYaml(raw) as { approach_keywords: string[] };
    const otherSet = new Set(other.approach_keywords.map((k) => k.toLowerCase()));
    let overlap = 0;
    for (const k of ownSet) if (otherSet.has(k)) overlap += 1;
    assert.equal(overlap, 0, `no shared approach_keywords with ${id}`);
  }
});
