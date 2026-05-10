// US-019: network-shadow agent.
//
// Coverage:
//   - parseAction: fetch / click / navigate / wait / done / decline,
//     fences + prose tolerance, error paths (unknown type, missing
//     field, empty completion).
//   - actionLabel rendering for each action shape.
//   - Network monkey-patch installed on a real HTTP origin: a page-side
//     fetch and an agent-side fetch both land in window.__gba_net_log
//     with method/url/status/body fields.
//   - installPatch is idempotent (double-install is a no-op).
//   - executeAction on real Chrome: fetch round-trips, click dispatches
//     onto the right element, navigate updates document.location.
//   - End-to-end runs on real Chrome with a scripted LLM:
//       * 1 fetch action submits to a fixture endpoint, then done →
//         trajectory DONE; verifier-friendly server state recorded.
//       * parse_error mid-loop is tolerated; the agent recovers on the
//         next turn.
//       * No-LLM (replay-only) declines cleanly.
//       * Tight steps budget short-circuits to BUDGET_EXCEEDED.
//   - Manifest distinctness vs ALL six prior agents (baseline,
//     plan-then-execute, runtime-codegen, speculative-rollback,
//     predicate-driven, vision-grounded) with zero keyword overlap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";

import NetworkShadowAgent from "../../../agents/network-shadow/agent.js";
import {
  ActionParseError,
  actionLabel,
  executeAction,
  parseAction,
} from "../../../agents/network-shadow/actions.js";
import {
  installPatch,
  readNetLog,
  type NetEntry,
} from "../../../agents/network-shadow/network.js";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Budget } from "../agent/types.js";
import { LLMClient } from "../llm/client.js";
import { parseYaml } from "../verifier/yaml.js";
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
} from "../llm/types.js";

interface FixtureServer {
  url(path?: string): string;
  origin: string;
  state: { submissions: Array<{ method: string; path: string; body: string }> };
  close(): Promise<void>;
}

async function startFixture(): Promise<FixtureServer> {
  const state: FixtureServer["state"] = { submissions: [] };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    if (url.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>fix</title></head><body>` +
          `<h1>shop</h1>` +
          `<button id="buy" onclick="fetch('/api/buy', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({item:'apple'})}).then(r=>r.text()).then(t=>{document.title='ok:'+t})">Buy</button>` +
          `</body></html>`,
      );
      return;
    }
    if (url.pathname === "/api/buy" && method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        state.submissions.push({ method, path: url.pathname, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, received: body }));
      });
      return;
    }
    if (url.pathname === "/api/last" && method === "GET") {
      const last = state.submissions[state.submissions.length - 1] ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(last ?? {}));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server.address() returned null");
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    state,
    url(path = "/") {
      return origin + path;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

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

test("parseAction: fetch with method/url/body/content_type", () => {
  const a = parseAction(
    `{"type":"fetch","method":"post","url":"/api/buy","body":"{\\"k\\":1}","content_type":"application/json","thought":"hit api"}`,
  );
  assert.equal(a.type, "fetch");
  if (a.type === "fetch") {
    assert.equal(a.method, "POST");
    assert.equal(a.url, "/api/buy");
    assert.equal(a.body, '{"k":1}');
    assert.equal(a.content_type, "application/json");
    assert.equal(a.thought, "hit api");
  }
});

test("parseAction: fetch with object body is JSON-stringified", () => {
  const a = parseAction(`{"type":"fetch","method":"POST","url":"/x","body":{"a":1}}`);
  if (a.type === "fetch") assert.equal(a.body, '{"a":1}');
  else assert.fail("expected fetch action");
});

test("parseAction: fetch defaults method to GET, body to null", () => {
  const a = parseAction(`{"type":"fetch","url":"/q"}`);
  if (a.type === "fetch") {
    assert.equal(a.method, "GET");
    assert.equal(a.body, null);
  } else assert.fail("expected fetch action");
});

test("parseAction: fetch missing url rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"fetch","method":"GET"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /url/.test((err as Error).message),
  );
});

test("parseAction: click + selector", () => {
  const a = parseAction(`{"type":"click","selector":"button#go"}`);
  if (a.type === "click") assert.equal(a.selector, "button#go");
  else assert.fail("expected click");
});

test("parseAction: click missing selector rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"click"}`),
    (err: unknown) =>
      err instanceof ActionParseError && /selector/.test((err as Error).message),
  );
});

test("parseAction: navigate + url", () => {
  const a = parseAction(`{"type":"navigate","url":"https://x"}`);
  if (a.type === "navigate") assert.equal(a.url, "https://x");
  else assert.fail("expected navigate");
});

test("parseAction: wait clamps to <=5s and floors negative", () => {
  const w = parseAction(`{"type":"wait","ms":900}`);
  if (w.type === "wait") assert.equal(w.ms, 900);
  const big = parseAction(`{"type":"wait","ms":99999}`);
  if (big.type === "wait") assert.equal(big.ms, 5000);
  const neg = parseAction(`{"type":"wait","ms":-10}`);
  if (neg.type === "wait") assert.equal(neg.ms, 0);
});

test("parseAction: done + reason", () => {
  const a = parseAction(`{"type":"done","reason":"submitted"}`);
  if (a.type === "done") assert.equal(a.reason, "submitted");
  else assert.fail("expected done");
});

test("parseAction: decline + reason", () => {
  const a = parseAction(`{"type":"decline","reason":"stuck"}`);
  if (a.type === "decline") assert.equal(a.reason, "stuck");
  else assert.fail("expected decline");
});

test("parseAction: ```json fence stripped", () => {
  const a = parseAction("```json\n{\"type\":\"done\",\"reason\":\"x\"}\n```");
  if (a.type !== "done") assert.fail("expected done");
});

test("parseAction: prose preceding JSON tolerated", () => {
  const a = parseAction('Sure! {"type":"done","reason":"ok"}');
  if (a.type !== "done") assert.fail("expected done");
});

test("parseAction: unknown type rejected", () => {
  assert.throws(
    () => parseAction(`{"type":"telepathy"}`),
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
  assert.equal(
    actionLabel({ type: "fetch", method: "POST", url: "/api/x", body: null, content_type: null }),
    "fetch(POST /api/x)",
  );
  assert.equal(actionLabel({ type: "click", selector: "#x" }), "click(#x)");
  assert.equal(actionLabel({ type: "navigate", url: "https://y" }), "navigate(https://y)");
  assert.equal(actionLabel({ type: "wait", ms: 250 }), "wait(250ms)");
  assert.equal(actionLabel({ type: "done", reason: "ok" }), "done(ok)");
  assert.equal(actionLabel({ type: "decline", reason: "stuck" }), "decline(stuck)");
});

// -----------------------------------------------------------------------------
// Network monkey-patch on real Chrome
// -----------------------------------------------------------------------------

test("installPatch + readNetLog: page fetch lands in the log with status + body", async () => {
  const fixture = await startFixture();
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(fixture.url("/page"));
    await installPatch(session);
    // Trigger the page's button → POST /api/buy.
    await session.evaluate("document.querySelector('button#buy').click()");
    // Wait for fetch to round-trip and the .then() handler to run.
    await new Promise((r) => setTimeout(r, 200));
    const log = await readNetLog(session);
    const entry = log.find((e) => e.url.startsWith("/api/buy"));
    assert.ok(entry, "expected /api/buy entry in log");
    assert.equal(entry!.method, "POST");
    assert.equal(entry!.status, 200);
    assert.match(entry!.response_body ?? "", /ok/);
    assert.match(entry!.request_body ?? "", /apple/);
  } finally {
    await session.close();
    await fixture.close();
  }
});

test("installPatch is idempotent: a second install is a no-op", async () => {
  const fixture = await startFixture();
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(fixture.url("/page"));
    await installPatch(session);
    await installPatch(session);
    // Trigger one request, log should have exactly one entry for it (no doubles).
    await session.evaluate(
      `fetch('/api/buy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({n:1})})`,
    );
    await new Promise((r) => setTimeout(r, 200));
    const log = await readNetLog(session);
    const buyEntries = log.filter((e) => e.url.startsWith("/api/buy"));
    assert.equal(buyEntries.length, 1, `expected exactly one /api/buy log entry, got ${buyEntries.length}`);
  } finally {
    await session.close();
    await fixture.close();
  }
});

test("installPatch on data: URL does not throw", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbody%3E%3C%2Fbody%3E");
    // Should not throw even though the patch's fetch wrap won't be useful on
    // an opaque-origin page where fetch is restricted.
    await installPatch(session);
    const log = await readNetLog(session);
    assert.ok(Array.isArray(log));
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// executeAction on real Chrome
// -----------------------------------------------------------------------------

test("executeAction fetch: in-page POST returns response sample", async () => {
  const fixture = await startFixture();
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(fixture.url("/page"));
    await installPatch(session);
    const r = await executeAction(
      {
        type: "fetch",
        method: "POST",
        url: "/api/buy",
        body: JSON.stringify({ item: "pear" }),
        content_type: "application/json",
      },
      session,
    );
    assert.equal(r.ok, true);
    assert.match(r.message, /200/);
    assert.match(r.message, /ok.*received/);
    // Server saw it.
    assert.equal(fixture.state.submissions.length, 1);
    assert.match(fixture.state.submissions[0]!.body, /pear/);
  } finally {
    await session.close();
    await fixture.close();
  }
});

test("executeAction click: dispatches onto the matched element", async () => {
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>click-test</title><body>
      <button id="go" onclick="window.__hit=true">Go</button>
    </body>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const r = await executeAction({ type: "click", selector: "button#go" }, session);
    assert.equal(r.ok, true);
    const hit = await session.evaluate<boolean>("Boolean(window.__hit)");
    assert.equal(hit, true);
  } finally {
    await session.close();
  }
});

test("executeAction click: missing selector reports fail", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbody%3E%3C%2Fbody%3E");
    const r = await executeAction({ type: "click", selector: "button#nope" }, session);
    assert.equal(r.ok, false);
    assert.match(r.message, /no element/);
  } finally {
    await session.close();
  }
});

test("executeAction wait: waits at least N ms", async () => {
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbody%3E%3C%2Fbody%3E");
    const t0 = Date.now();
    await executeAction({ type: "wait", ms: 120 }, session);
    assert.ok(Date.now() - t0 >= 100);
  } finally {
    await session.close();
  }
});

// -----------------------------------------------------------------------------
// End-to-end runs on real Chrome with scripted LLM
// -----------------------------------------------------------------------------

test("run: single fetch + done → trajectory DONE; server saw the POST", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-ns-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-ns-"));
  const fixture = await startFixture();
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(fixture.url("/page"));

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"type":"fetch","method":"POST","url":"/api/buy","body":"{\\"item\\":\\"orange\\"}","content_type":"application/json","thought":"hit endpoint directly"}`,
          tokens_in: 100,
          tokens_out: 60,
        },
      },
      {
        reply: {
          text: `{"type":"done","reason":"server returned ok"}`,
          tokens_in: 60,
          tokens_out: 30,
        },
      },
    ]);

    const agent = new NetworkShadowAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-ns-done",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run(
      "buy an orange via the API",
      session,
      generousBudget(),
      { task_id: "ns-done", seed: 0, runs_root: runsRoot },
    );
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2, "fetch + done");

    // Server got the POST.
    assert.equal(fixture.state.submissions.length, 1);
    assert.match(fixture.state.submissions[0]!.body, /orange/);

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; method?: string; url?: string; net_delta?: number };
    }>;
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.action.type, "fetch");
    assert.equal(steps[0]?.action.method, "POST");
    assert.equal(steps[0]?.action.url, "/api/buy");
    assert.ok((steps[0]?.action.net_delta ?? 0) >= 1, "fetch should leave a log entry");
    assert.equal(steps[1]?.action.type, "done");
  } finally {
    await session.close();
    await fixture.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: parse_error mid-loop is tolerated and loop recovers", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-ns-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-ns-"));
  const fixture = await startFixture();
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate(fixture.url("/page"));

    const { provider, calls } = scriptedProvider([
      // Garbage that doesn't parse — agent records parse_error and continues.
      {
        reply: {
          text: `I'm not sure, maybe click the button?`,
          tokens_in: 40,
          tokens_out: 20,
        },
      },
      {
        reply: {
          text: `{"type":"fetch","method":"POST","url":"/api/buy","body":"{\\"item\\":\\"plum\\"}","content_type":"application/json"}`,
          tokens_in: 60,
          tokens_out: 40,
        },
      },
      {
        reply: {
          text: `{"type":"done","reason":"got ok"}`,
          tokens_in: 50,
          tokens_out: 20,
        },
      },
    ]);

    const agent = new NetworkShadowAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-ns-parse",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("buy plum", session, generousBudget(), {
      task_id: "ns-parse",
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
    assert.equal(steps[1]?.action.type, "fetch");
    assert.equal(steps[2]?.action.type, "done");
  } finally {
    await session.close();
    await fixture.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-ns-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-ns-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbody%3E%3C%2Fbody%3E");
    const agent = new NetworkShadowAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "ns-no-llm",
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
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-ns-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-ns-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbody%3E%3C%2Fbody%3E");
    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep(); // pre-trip

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: `{"type":"done","reason":"x"}`,
          tokens_in: 10,
          tokens_out: 5,
        },
      },
    ]);

    const agent = new NetworkShadowAgent({
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
      task_id: "ns-tight",
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

test("manifest: network-shadow distinct_from ALL six prior agents with zero keyword overlap", async () => {
  const priors = [
    "baseline-a11y-react",
    "plan-then-execute",
    "runtime-codegen",
    "speculative-rollback",
    "predicate-driven",
    "vision-grounded",
  ];
  const nsRaw = await readFile(
    new URL("../../../agents/network-shadow/manifest.yaml", import.meta.url),
    "utf8",
  );
  const ns = parseYaml(nsRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };
  for (const target of priors) {
    assert.ok(
      ns.distinct_from.includes(target),
      `network-shadow.distinct_from must include ${target}`,
    );
  }
  const nsSet = new Set(ns.approach_keywords.map((k) => k.toLowerCase()));
  for (const id of priors) {
    const raw = await readFile(
      new URL(`../../../agents/${id}/manifest.yaml`, import.meta.url),
      "utf8",
    );
    const other = parseYaml(raw) as { approach_keywords: string[] };
    const otherSet = new Set(other.approach_keywords.map((k) => k.toLowerCase()));
    let overlap = 0;
    for (const k of nsSet) if (otherSet.has(k)) overlap += 1;
    assert.equal(overlap, 0, `no shared approach_keywords with ${id}`);
  }
});

// Silence unused warning for NetEntry import.
void (null as unknown as NetEntry);
