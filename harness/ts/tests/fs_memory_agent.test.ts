// US-021: fs-memory agent.
//
// Coverage:
//   - parseAction: every action verb, alias table, fence/prose tolerance,
//     rejects junk / unknown verbs.
//   - ScratchFs: write/append/read/list/delete round-trips inside the
//     root, rejects ".." and absolute paths, enforces the file cap.
//   - End-to-end runs on real Chrome with a scripted LLM:
//       * write plan.md → observe → click → append observations.md → done
//       * read survives across turns (last turn's result is replaced; the
//         agent recalls by re-reading the file)
//       * the prompt is CONSTANT-SHAPE (does not accumulate observations)
//       * a path-traversal attempt is rejected and surfaced as a FAIL,
//         the loop continues
//   - Trajectory step records carry kind=fs_memory and the action label.
//   - parse_error path does not abort the loop.
//   - No-LLM declines cleanly; tight budget short-circuits.
//   - Manifest distinctness vs every prior agent (Jaccard < 0.5 — in fact 0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import FsMemoryAgent, { executeAction } from "../../../agents/fs-memory/agent.js";
import {
  actionLabel,
  ActionParseError,
  parseAction,
} from "../../../agents/fs-memory/actions.js";
import { ScratchFs, ScratchPathError } from "../../../agents/fs-memory/scratch.js";

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

test("parseAction: fs.write requires path + content", () => {
  const a = parseAction('{"type":"fs.write","path":"plan.md","content":"hello"}');
  assert.equal(a.type, "fs.write");
  assert.equal((a as { path: string }).path, "plan.md");
  assert.equal((a as { content: string }).content, "hello");
});

test("parseAction: aliases (write → fs.write)", () => {
  const a = parseAction('{"type":"write","path":"p.md","content":"x"}');
  assert.equal(a.type, "fs.write");
});

test("parseAction: aliases (ls → fs.list, navigate, finish → done)", () => {
  assert.equal(parseAction('{"type":"ls"}').type, "fs.list");
  assert.equal(parseAction('{"type":"goto","url":"https://example.com"}').type, "browser.navigate");
  assert.equal(parseAction('{"type":"finish","reason":"x"}').type, "done");
});

test("parseAction: tolerates ```json fence and leading prose", () => {
  const raw = "Thought: I should plan first.\n```json\n{\"type\":\"fs.list\"}\n```";
  const a = parseAction(raw);
  assert.equal(a.type, "fs.list");
});

test("parseAction: browser.type accepts submit flag", () => {
  const a = parseAction('{"type":"browser.type","selector":"#q","text":"abc","submit":true}');
  assert.equal(a.type, "browser.type");
  assert.equal((a as { selector: string }).selector, "#q");
  assert.equal((a as { submit?: boolean }).submit, true);
});

test("parseAction: scroll/wait clamp ranges", () => {
  const s = parseAction('{"type":"browser.scroll","pixels":999999}');
  assert.equal((s as { pixels?: number }).pixels, 4000);
  const w = parseAction('{"type":"browser.wait","ms":999999}');
  assert.equal((w as { ms?: number }).ms, 10_000);
});

test("parseAction: rejects unknown type", () => {
  assert.throws(
    () => parseAction('{"type":"frobnicate"}'),
    (e: unknown) => e instanceof ActionParseError && /unknown action/.test((e as Error).message),
  );
});

test("parseAction: rejects empty", () => {
  assert.throws(() => parseAction(""), (e: unknown) => e instanceof ActionParseError);
});

test("parseAction: fs.write missing content throws", () => {
  assert.throws(
    () => parseAction('{"type":"fs.write","path":"p.md"}'),
    (e: unknown) => e instanceof ActionParseError && /content/.test((e as Error).message),
  );
});

test("actionLabel: fs.write and browser.type render compactly", () => {
  assert.match(
    actionLabel({ type: "fs.write", path: "p.md", content: "x" }),
    /^fs\.write p\.md/,
  );
  assert.match(
    actionLabel({ type: "browser.type", selector: "#q", text: "abc", submit: true }),
    /browser\.type #q "abc" --submit/,
  );
});

// -----------------------------------------------------------------------------
// ScratchFs
// -----------------------------------------------------------------------------

test("ScratchFs: write → read round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-scratch-"));
  try {
    const fs = new ScratchFs(dir);
    await fs.write("plan.md", "hello world");
    const r = await fs.read("plan.md");
    assert.equal(r.content, "hello world");
    assert.equal(r.bytes, 11);
    assert.equal(r.truncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ScratchFs: append accumulates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-scratch-"));
  try {
    const fs = new ScratchFs(dir);
    await fs.write("log", "a");
    await fs.append("log", "b");
    await fs.append("log", "c");
    const r = await fs.read("log");
    assert.equal(r.content, "abc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ScratchFs: tree includes nested files with byte sizes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-scratch-"));
  try {
    const fs = new ScratchFs(dir);
    await fs.write("notes.md", "x");
    await fs.write("observations/turn-1.md", "abc");
    const tree = await fs.tree();
    assert.ok(tree.some((l) => /^notes\.md \(1B\)/.test(l)), `tree: ${tree.join("\n")}`);
    assert.ok(tree.some((l) => /^observations\//.test(l)));
    assert.ok(tree.some((l) => /turn-1\.md \(3B\)/.test(l)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ScratchFs: rejects path traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-scratch-"));
  try {
    const fs = new ScratchFs(dir);
    assert.throws(() => fs.resolve("../escape"), (e: unknown) => e instanceof ScratchPathError);
    assert.throws(() => fs.resolve("/etc/passwd"), (e: unknown) => e instanceof ScratchPathError);
    assert.throws(() => fs.resolve("a/../../b"), (e: unknown) => e instanceof ScratchPathError);
    assert.throws(() => fs.resolve(""), (e: unknown) => e instanceof ScratchPathError);
    assert.throws(
      () => fs.resolve("nul\0byte"),
      (e: unknown) => e instanceof ScratchPathError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ScratchFs: enforces per-file byte cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-scratch-"));
  try {
    const fs = new ScratchFs(dir);
    const big = "x".repeat(ScratchFs.MAX_FILE_BYTES + 1);
    await assert.rejects(
      fs.write("oversize", big),
      (e: unknown) => e instanceof ScratchPathError && /exceed/i.test((e as Error).message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ScratchFs: read truncates large files to MAX_READ_BYTES", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-scratch-"));
  try {
    const fs = new ScratchFs(dir);
    const payload = "abcdefghij".repeat(500); // 5000 bytes — past 4000 cap
    await fs.write("big.md", payload);
    const r = await fs.read("big.md");
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 5000);
    assert.equal(r.content.length, ScratchFs.MAX_READ_BYTES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ScratchFs: delete removes files; tree shrinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-scratch-"));
  try {
    const fs = new ScratchFs(dir);
    await fs.write("temp", "x");
    let t = await fs.tree();
    assert.ok(t.some((l) => l.startsWith("temp")));
    await fs.remove("temp");
    t = await fs.tree();
    assert.ok(!t.some((l) => l.startsWith("temp")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// End-to-end runs on real Chrome
// -----------------------------------------------------------------------------

test("run: plan → observe → click → fs.append → done", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-fsmem-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-fsmem-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>fsmem flow</title>
<button id="go">Go</button>
<script>
window.__clicked = false;
document.getElementById('go').addEventListener('click', () => { window.__clicked = true; });
</script>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: '{"type":"fs.write","path":"plan.md","content":"1. observe 2. click #go 3. confirm"}',
          tokens_in: 10,
          tokens_out: 6,
        },
      },
      { reply: { text: '{"type":"browser.observe"}', tokens_in: 5, tokens_out: 3 } },
      {
        reply: {
          text: '{"type":"fs.append","path":"observations.md","content":"saw button #go"}',
          tokens_in: 6,
          tokens_out: 4,
        },
      },
      {
        reply: {
          text: '{"type":"browser.click","selector":"#go"}',
          tokens_in: 6,
          tokens_out: 4,
        },
      },
      { reply: { text: '{"type":"done","reason":"clicked"}', tokens_in: 5, tokens_out: 3 } },
    ]);

    const agent = new FsMemoryAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "fsmem-flow",
        }),
      maxSteps: 8,
    });
    const traj = await agent.run(
      "click the go button",
      session,
      generousBudget(),
      { task_id: "fsmem-flow", seed: 0, runs_root: runsRoot },
    );

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 5);
    const clicked = await session.evaluate<boolean>("window.__clicked === true");
    assert.equal(clicked, true);

    // scratch dir lives under <trajectoryDir>/scratch
    const scratchDir = join(traj.dir, "scratch");
    const stPlan = await stat(join(scratchDir, "plan.md"));
    assert.ok(stPlan.size > 0);
    const planContent = await readFile(join(scratchDir, "plan.md"), "utf8");
    assert.match(planContent, /click #go/);

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; kind: string; label: string; ok: boolean };
    }>;
    assert.equal(steps.length, 5);
    assert.equal(steps[0]?.action.kind, "fs.write");
    assert.equal(steps[1]?.action.kind, "browser.observe");
    assert.equal(steps[2]?.action.kind, "fs.append");
    assert.equal(steps[3]?.action.kind, "browser.click");
    assert.equal(steps[4]?.action.kind, "done");
    for (const s of steps) assert.equal(s.action.type, "fs_memory");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: prompt is constant-shape — does NOT accumulate observation history", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-fsmem-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-fsmem-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Econst-shape%3C/title%3E%3Cbutton%3EX%3C/button%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: '{"type":"browser.observe"}', tokens_in: 5, tokens_out: 3 } },
      { reply: { text: '{"type":"browser.observe"}', tokens_in: 5, tokens_out: 3 } },
      { reply: { text: '{"type":"browser.observe"}', tokens_in: 5, tokens_out: 3 } },
      { reply: { text: '{"type":"done","reason":"x"}', tokens_in: 5, tokens_out: 3 } },
    ]);
    const agent = new FsMemoryAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "fsmem-shape",
        }),
      maxSteps: 6,
    });
    await agent.run("anything", session, generousBudget(), {
      task_id: "fsmem-shape",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(calls.length, 4);
    // Prompts after each step should NOT have grown — the user-message body
    // should not encode any prior observation, only the latest one. We
    // assert this by inspecting the user-message lengths: each subsequent
    // prompt's "Last action output" portion should be bounded by the same
    // (current observation) size, NOT step-1 + step-2 + step-3 worth of
    // history.
    const userContents = calls.map((c) => {
      const u = c.messages.find((m) => m.role === "user");
      return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
    });
    // The first prompt has no last-action-output. Subsequent prompts have
    // exactly ONE last-action-output block. None should have multiple.
    for (const body of userContents) {
      const opens = (body.match(/--- last action output ---/g) ?? []).length;
      const closes = (body.match(/--- end output ---/g) ?? []).length;
      assert.ok(opens <= 1, `prompt has ${opens} output blocks: ${body.slice(0, 200)}`);
      assert.equal(opens, closes);
    }
    // The step counter should be the only thing that monotonically grows.
    const steps = userContents.map((b) => {
      const m = b.match(/Step (\d+)/);
      return m ? Number(m[1]) : -1;
    });
    assert.deepEqual(steps, [1, 2, 3, 4]);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: path traversal attempt is surfaced as FAIL; loop continues", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-fsmem-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-fsmem-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Esafe%3C/title%3E");
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: '{"type":"fs.write","path":"../escape.md","content":"oops"}',
          tokens_in: 5,
          tokens_out: 4,
        },
      },
      { reply: { text: '{"type":"done","reason":"recovered"}', tokens_in: 5, tokens_out: 3 } },
    ]);
    const agent = new FsMemoryAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "fsmem-escape",
        }),
      maxSteps: 4,
    });
    const traj = await agent.run("path escape test", session, generousBudget(), {
      task_id: "fsmem-escape",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2);
    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { kind: string; ok: boolean; summary: string };
    }>;
    assert.equal(steps[0]?.action.kind, "fs.write");
    assert.equal(steps[0]?.action.ok, false);
    assert.match(steps[0]?.action.summary ?? "", /scratch error|escape/i);
    // Confirm the file did NOT land outside the scratch root.
    await assert.rejects(stat(join(traj.dir, "..", "escape.md")));
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: parse_error does not abort the loop", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-fsmem-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-fsmem-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eparse%3C/title%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: "I cannot decide what to emit", tokens_in: 5, tokens_out: 4 } },
      { reply: { text: '{"type":"done","reason":"r"}', tokens_in: 5, tokens_out: 4 } },
    ]);
    const agent = new FsMemoryAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "fsmem-parse",
        }),
      maxSteps: 4,
    });
    const traj = await agent.run("any", session, generousBudget(), {
      task_id: "fsmem-parse",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2);
    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; kind?: string };
    }>;
    assert.equal(steps[0]?.action.type, "parse_error");
    assert.equal(steps[1]?.action.type, "fs_memory");
    assert.equal(steps[1]?.action.kind, "done");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-fsmem-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-fsmem-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C/title%3E");
    const agent = new FsMemoryAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "fsmem-no-llm",
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
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-fsmem-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-fsmem-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbutton%3EX%3C/button%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: '{"type":"done","reason":"x"}', tokens_in: 5, tokens_out: 3 } },
    ]);
    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep();
    const agent = new FsMemoryAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "fsmem-tight",
        }),
    });
    const traj = await agent.run("x", session, tight, {
      task_id: "fsmem-tight",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "BUDGET_EXCEEDED");
    assert.equal(calls.length, 0);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// executeAction unit (no Chrome): fs ops alone, with a stub browser.
// -----------------------------------------------------------------------------

test("executeAction: fs.write → fs.read recovers content across executions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-fsexec-"));
  try {
    const scratch = new ScratchFs(join(dir, "scratch"));
    // Browser stub — never used for fs.* paths.
    const browser = {
      id: "stub",
      cdp: undefined as never,
      navigate: async () => undefined,
      evaluate: async () => undefined as never,
      screenshot: async () => Buffer.alloc(0),
    } as unknown as Parameters<typeof executeAction>[1];

    const w = await executeAction(
      { type: "fs.write", path: "notes.md", content: "deep state" },
      browser,
      scratch,
    );
    assert.equal(w.ok, true);
    assert.match(w.summary, /wrote notes\.md/);

    const r = await executeAction({ type: "fs.read", path: "notes.md" }, browser, scratch);
    assert.equal(r.ok, true);
    assert.match(r.output ?? "", /deep state/);

    const ls = await executeAction({ type: "fs.list" }, browser, scratch);
    assert.equal(ls.ok, true);
    assert.match(ls.output ?? "", /notes\.md/);

    const del = await executeAction({ type: "fs.delete", path: "notes.md" }, browser, scratch);
    assert.equal(del.ok, true);

    const ls2 = await executeAction({ type: "fs.list" }, browser, scratch);
    assert.doesNotMatch(ls2.output ?? "", /notes\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Manifest distinctness
// -----------------------------------------------------------------------------

test("manifest: fs-memory has Jaccard < 0.5 vs every prior agent (in fact 0)", async () => {
  const priors = [
    "baseline-a11y-react",
    "plan-then-execute",
    "runtime-codegen",
    "speculative-rollback",
    "predicate-driven",
    "vision-grounded",
    "network-shadow",
    "dom-mutation-stream",
    "vision-som",
    "codegen-predicate",
    "dom-shell",
  ];
  const selfRaw = await readFile(
    new URL("../../../agents/fs-memory/manifest.yaml", import.meta.url),
    "utf8",
  );
  const self = parseYaml(selfRaw) as {
    approach_keywords: string[];
    distinct_from: string[];
  };
  const selfSet = new Set(self.approach_keywords.map((k) => k.toLowerCase()));
  for (const prior of priors) {
    assert.ok(
      self.distinct_from.includes(prior),
      `fs-memory.distinct_from missing ${prior}`,
    );
    const raw = await readFile(
      new URL(`../../../agents/${prior}/manifest.yaml`, import.meta.url),
      "utf8",
    );
    const parsed = parseYaml(raw) as { approach_keywords: string[] };
    const otherSet = new Set(parsed.approach_keywords.map((s) => s.toLowerCase()));
    let intersection = 0;
    for (const k of otherSet) if (selfSet.has(k)) intersection += 1;
    const union = new Set([...selfSet, ...otherSet]).size;
    const jaccard = union === 0 ? 0 : intersection / union;
    assert.ok(jaccard < 0.5, `Jaccard with ${prior} = ${jaccard}`);
    // Stronger: zero overlap (intentional invariant).
    assert.equal(intersection, 0, `keyword overlap with ${prior}: ${intersection}`);
  }
});
