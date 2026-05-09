// LlmJudgeVerifier — exercises the n=3 majority-vote contract using a mock
// provider that returns scripted responses per call. No real network or
// browser involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClient } from "../llm/client.js";
import type { LLMProvider, ProviderRequest, ProviderResponse } from "../llm/types.js";
import { verify } from "../verifier/runner.js";
import type { Task, VerifyContext } from "../verifier/types.js";

function scriptedProvider(replies: string[]): { provider: LLMProvider; calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  let i = 0;
  const provider: LLMProvider = {
    name: "openai",
    async call(req: ProviderRequest): Promise<ProviderResponse> {
      calls.push(req);
      const text = replies[i] ?? "FAIL";
      i++;
      return { text, tokens_in: 5, tokens_out: 2 };
    },
  };
  return { provider, calls };
}

function judgeTask(): Task {
  return {
    id: "judge-test",
    goal: "Find the answer to the universe",
    start_url: "about:blank",
    difficulty: "hard",
    tags: ["judge_required"],
    verifier: { kind: "llm_judge", question: "Did the agent answer 42?", model: "gpt-4o" },
  };
}

test("llm_judge: 3 PASS votes -> pass", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const { provider, calls } = scriptedProvider(["PASS", "PASS", "PASS"]);
    const llm = new LLMClient({ cacheRoot, providers: { openai: provider } });
    const ctx: VerifyContext = { llm };
    const verdict = await verify(judgeTask(), ctx, { writeAuditFile: false });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 1);
    assert.equal(calls.length, 3);
    // temperature=0 enforced
    assert.equal(calls[0]?.opts.temperature, 0);
    // each call has a unique paradigm_seed so cache entries don't collide
    const seeds = calls.map((c) => c.opts.paradigm_seed);
    assert.deepEqual(seeds, ["judge:0", "judge:1", "judge:2"]);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("llm_judge: PASS+PASS+FAIL -> pass (majority)", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const { provider } = scriptedProvider(["PASS", "PASS", "FAIL"]);
    const llm = new LLMClient({ cacheRoot, providers: { openai: provider } });
    const verdict = await verify(judgeTask(), { llm }, { writeAuditFile: false });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.score, 2 / 3);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("llm_judge: PASS+FAIL+FAIL -> fail (minority)", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const { provider } = scriptedProvider(["PASS", "FAIL", "FAIL"]);
    const llm = new LLMClient({ cacheRoot, providers: { openai: provider } });
    const verdict = await verify(judgeTask(), { llm }, { writeAuditFile: false });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 1 / 3);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("llm_judge: tolerant of yes/no variants", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const { provider } = scriptedProvider(["yes", "PASS", "FAIL"]);
    const llm = new LLMClient({ cacheRoot, providers: { openai: provider } });
    const verdict = await verify(judgeTask(), { llm }, { writeAuditFile: false });
    assert.equal(verdict.pass, true);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("llm_judge: refuses to run without ctx.llm", async () => {
  await assert.rejects(
    () => verify(judgeTask(), {}, { writeAuditFile: false }),
    /requires ctx.llm/,
  );
});
