// LLMClient end-to-end behaviour with a mock provider:
//   - record-then-replay is deterministic and skips the provider
//   - replay mode without a prior cache throws LLMReplayMissError
//   - budget refusal: pre-tripped budget refuses without invoking provider
//   - over-budget after a call still throws BudgetExceeded
//   - secret redaction strips API keys from error messages
//   - trajectory records llm_call lines with the right shape

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import { LLMClient } from "../llm/client.js";
import {
  LLMReplayMissError,
  type LLMProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "../llm/types.js";
import { Budget, BudgetExceeded } from "../agent/types.js";
import { Trajectory } from "../agent/trajectory.js";

interface MockCall {
  req: ProviderRequest;
}

function makeMockProvider(reply: ProviderResponse, captured: MockCall[]): LLMProvider {
  return {
    name: "openai",
    async call(req: ProviderRequest): Promise<ProviderResponse> {
      captured.push({ req });
      return reply;
    },
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

test("record then replay: provider called exactly once, second call hits cache", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const captured: MockCall[] = [];
    const provider = makeMockProvider(
      { text: "the answer is 42", tokens_in: 5, tokens_out: 7 },
      captured,
    );
    const client = new LLMClient({
      cacheRoot,
      mode: "record",
      providers: { openai: provider },
    });
    const r1 = await client.call("gpt-4o-mini", [{ role: "user", content: "what?" }]);
    assert.equal(r1.text, "the answer is 42");
    assert.equal(r1.cached, false);
    assert.equal(r1.tokens_in, 5);
    assert.equal(r1.tokens_out, 7);
    assert.ok(r1.cost_usd > 0); // gpt-4o-mini is priced
    assert.equal(captured.length, 1);

    // Second client, replay-only, no provider — must not call the (absent)
    // provider, and must produce identical text + token counts.
    const replayClient = new LLMClient({ cacheRoot, mode: "replay" });
    const r2 = await replayClient.call("gpt-4o-mini", [{ role: "user", content: "what?" }]);
    assert.equal(r2.text, r1.text);
    assert.equal(r2.tokens_in, 5);
    assert.equal(r2.tokens_out, 7);
    assert.equal(r2.prompt_hash, r1.prompt_hash);
    assert.equal(r2.cached, true);
    assert.equal(captured.length, 1); // unchanged
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("replay miss throws LLMReplayMissError", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const client = new LLMClient({ cacheRoot, mode: "replay" });
    await assert.rejects(
      () => client.call("gpt-4o-mini", [{ role: "user", content: "fresh" }]),
      LLMReplayMissError,
    );
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("paradigm_seed differentiates the cache", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const captured: MockCall[] = [];
    const provider = makeMockProvider(
      { text: "x", tokens_in: 1, tokens_out: 1 },
      captured,
    );
    const a = new LLMClient({
      cacheRoot,
      providers: { openai: provider },
      paradigmSeed: "alpha",
    });
    const b = new LLMClient({
      cacheRoot,
      providers: { openai: provider },
      paradigmSeed: "beta",
    });
    await a.call("gpt-4o-mini", [{ role: "user", content: "same" }]);
    await b.call("gpt-4o-mini", [{ role: "user", content: "same" }]);
    assert.equal(captured.length, 2); // different seed → different key → both miss
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("budget refused before call: provider not invoked", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const captured: MockCall[] = [];
    const provider = makeMockProvider(
      { text: "should-not-be-called", tokens_in: 9, tokens_out: 9 },
      captured,
    );
    // Pre-trip the budget (steps axis).
    const budget = new Budget({ tokens: 100, usd: 1, wallSeconds: 60, steps: 0 });
    budget.recordStep();
    const client = new LLMClient({
      cacheRoot,
      providers: { openai: provider },
      budget,
    });
    await assert.rejects(
      () => client.call("gpt-4o-mini", [{ role: "user", content: "hi" }]),
      BudgetExceeded,
    );
    assert.equal(captured.length, 0);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("over-budget after call still throws BudgetExceeded but persists cache", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const captured: MockCall[] = [];
    const provider = makeMockProvider(
      { text: "yo", tokens_in: 100, tokens_out: 100 },
      captured,
    );
    // tokens limit lower than the response will report.
    const budget = new Budget({ tokens: 50, usd: 1, wallSeconds: 60, steps: 10 });
    const client = new LLMClient({
      cacheRoot,
      providers: { openai: provider },
      budget,
    });
    await assert.rejects(
      () => client.call("gpt-4o-mini", [{ role: "user", content: "hi" }]),
      BudgetExceeded,
    );
    assert.equal(captured.length, 1);

    // The result was cached even though the post-call budget tripped — so a
    // replay-mode rerun (with a fresh budget) will pick it up.
    const replay = new LLMClient({ cacheRoot, mode: "replay" });
    const r = await replay.call("gpt-4o-mini", [{ role: "user", content: "hi" }]);
    assert.equal(r.text, "yo");
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("secret redaction strips API key from provider errors", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const apiKey = "sk-test-DO-NOT-LEAK-1234567890";
    const provider: LLMProvider = {
      name: "openai",
      async call(): Promise<ProviderResponse> {
        throw new Error(`Gemini 401: invalid key=${apiKey}, please try again`);
      },
    };
    const client = new LLMClient({
      cacheRoot,
      providers: { openai: provider },
      redactValues: [apiKey],
    });
    let caught: Error | null = null;
    try {
      await client.call("gpt-4o-mini", [{ role: "user", content: "x" }]);
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught);
    assert.ok(!caught.message.includes(apiKey), `message leaked the key: ${caught.message}`);
    assert.match(caught.message, /\[REDACTED\]/);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("trajectory records an llm_call line per call with the right shape", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const captured: MockCall[] = [];
    const provider = makeMockProvider(
      { text: "ok", tokens_in: 4, tokens_out: 6 },
      captured,
    );
    const traj = await Trajectory.open(
      { runsRoot, agent: "t", task: "q", seed: 0 },
      { agent_id: "t", task_id: "q", seed: 0 },
    );
    const client = new LLMClient({
      cacheRoot,
      providers: { openai: provider },
      trajectory: traj,
    });
    const r = await client.call("gpt-4o-mini", [{ role: "user", content: "hello" }]);

    assert.equal(traj.snapshotLlmCalls().length, 1);
    const rec = traj.snapshotLlmCalls()[0];
    assert.ok(rec);
    assert.equal(rec.model, "gpt-4o-mini");
    assert.equal(rec.prompt_hash, r.prompt_hash);
    assert.equal(rec.prompt_tokens, 4);
    assert.equal(rec.completion_tokens, 6);
    assert.equal(rec.cached, false);

    await traj.finish({ terminal_state: "DONE" });
    const lines = await readGzipLines(traj.gzPath);
    // meta + llm_call + end
    assert.equal(lines.length, 3);
    const llmLine = lines[1] as { kind: string; model: string; prompt_hash: string };
    assert.equal(llmLine.kind, "llm_call");
    assert.equal(llmLine.model, "gpt-4o-mini");
    assert.equal(llmLine.prompt_hash, r.prompt_hash);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("cache files do not contain provider auth material", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const apiKey = "sk-do-not-leak-XYZ";
    const provider: LLMProvider = {
      name: "openai",
      async call(req: ProviderRequest): Promise<ProviderResponse> {
        // Sanity: provider received the messages but the auth material was
        // configured at construction time, never in the request.
        assert.ok(JSON.stringify(req).indexOf(apiKey) === -1);
        return { text: "fine", tokens_in: 1, tokens_out: 1 };
      },
    };
    const client = new LLMClient({
      cacheRoot,
      providers: { openai: provider },
      redactValues: [apiKey],
    });
    await client.call("gpt-4o-mini", [{ role: "user", content: "ping" }]);

    // Walk the cache directory and assert no file contains the key.
    const { readdir, readFile, stat } = await import("node:fs/promises");
    async function walk(dir: string): Promise<string[]> {
      const ents = await readdir(dir);
      const out: string[] = [];
      for (const ent of ents) {
        const p = join(dir, ent);
        const st = await stat(p);
        if (st.isDirectory()) out.push(...(await walk(p)));
        else out.push(p);
      }
      return out;
    }
    const files = await walk(cacheRoot);
    assert.ok(files.length > 0);
    for (const f of files) {
      const blob = await readFile(f, "utf8");
      assert.ok(!blob.includes(apiKey), `${f} leaked the key`);
    }
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
