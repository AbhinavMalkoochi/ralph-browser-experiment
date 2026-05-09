// LLMCache + hashKey unit tests. These don't touch the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMCache, hashKey } from "../llm/cache.js";

test("hashKey is stable across object key order", () => {
  const a = hashKey({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    opts: { temperature: 0.2, max_tokens: 100 },
    paradigm_seed: "p1",
  });
  const b = hashKey({
    paradigm_seed: "p1",
    opts: { max_tokens: 100, temperature: 0.2 },
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
  });
  assert.equal(a, b);
});

test("hashKey is sensitive to content, model, and seed", () => {
  const base = {
    model: "gpt-4o",
    messages: [{ role: "user" as const, content: "hi" }],
    opts: {},
  };
  const k0 = hashKey(base);
  const k1 = hashKey({ ...base, model: "gpt-4o-mini" });
  const k2 = hashKey({ ...base, messages: [{ role: "user" as const, content: "hello" }] });
  const k3 = hashKey({ ...base, paradigm_seed: "x" });
  assert.notEqual(k0, k1);
  assert.notEqual(k0, k2);
  assert.notEqual(k0, k3);
});

test("LLMCache get returns null on miss, set+get round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gba-llm-cache-"));
  try {
    const cache = new LLMCache(dir);
    assert.equal(await cache.get("nope"), null);
    await cache.set({
      key: "abc1234",
      model: "mock-model",
      text: "ok",
      tokens_in: 1,
      tokens_out: 2,
      recorded_at: "2026-05-08T00:00:00Z",
    });
    const got = await cache.get("abc1234");
    assert.ok(got);
    assert.equal(got.text, "ok");
    assert.equal(got.tokens_in, 1);
    assert.equal(got.tokens_out, 2);

    // Sanity: file lives under <root>/<key[:2]>/<key>.json.
    const raw = await readFile(join(dir, "ab", "abc1234.json"), "utf8");
    assert.match(raw, /"model":\s*"mock-model"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
