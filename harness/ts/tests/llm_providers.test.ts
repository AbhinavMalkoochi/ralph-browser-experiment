// Provider-level tests with a stubbed fetch; no network.
//
// These verify the wire shape of OpenAI Chat Completions and Gemini
// generateContent so that a future swap to a real key catches regressions.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenAiProvider } from "../llm/providers/openai.js";
import { GeminiProvider } from "../llm/providers/gemini.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(captured: CapturedFetch[], responder: () => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: typeof input === "string" ? input : input.toString(), init });
    return responder();
  }) as unknown as typeof fetch;
}

test("OpenAiProvider posts the right JSON and parses usage", async () => {
  const captured: CapturedFetch[] = [];
  const fetchImpl = makeFetch(captured, () =>
    jsonResponse({
      choices: [{ message: { content: "hello!" } }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }),
  );
  const p = new OpenAiProvider({
    apiKey: "sk-fake",
    baseUrl: "https://api.example.test/v1",
    fetchImpl,
  });
  const out = await p.call({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "you are X" },
      { role: "user", content: "say hello" },
    ],
    opts: { temperature: 0.3, max_tokens: 50, json_mode: true },
  });
  assert.equal(out.text, "hello!");
  assert.equal(out.tokens_in, 11);
  assert.equal(out.tokens_out, 3);

  assert.equal(captured.length, 1);
  const c = captured[0]!;
  assert.equal(c.url, "https://api.example.test/v1/chat/completions");
  const headers = c.init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer sk-fake");
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(c.init?.body as string) as {
    model: string;
    messages: { role: string; content: string }[];
    temperature: number;
    max_tokens: number;
    response_format: { type: string };
  };
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0]?.role, "system");
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 50);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("OpenAiProvider surfaces non-2xx as Error", async () => {
  const captured: CapturedFetch[] = [];
  const fetchImpl = makeFetch(captured, () =>
    new Response("invalid token", { status: 401 }),
  );
  const p = new OpenAiProvider({
    apiKey: "sk-fake",
    baseUrl: "https://api.example.test/v1",
    fetchImpl,
  });
  await assert.rejects(
    () => p.call({ model: "gpt-4o", messages: [{ role: "user", content: "x" }], opts: {} }),
    /OpenAI 401/,
  );
});

test("GeminiProvider posts the right JSON, maps roles, and includes key in URL", async () => {
  const captured: CapturedFetch[] = [];
  const fetchImpl = makeFetch(captured, () =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "hi from gemini" }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
    }),
  );
  const p = new GeminiProvider({
    apiKey: "gem-fake-KEY",
    baseUrl: "https://gen.example.test/v1beta",
    fetchImpl,
  });
  const out = await p.call({
    model: "gemini-2.5-flash",
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "previous" },
      { role: "user", content: "follow up" },
    ],
    opts: { temperature: 0.1, max_tokens: 200, json_mode: true, stop: ["\n"] },
  });
  assert.equal(out.text, "hi from gemini");
  assert.equal(out.tokens_in, 8);
  assert.equal(out.tokens_out, 4);

  assert.equal(captured.length, 1);
  const c = captured[0]!;
  assert.match(c.url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent\?key=gem-fake-KEY$/);

  const body = JSON.parse(c.init?.body as string) as {
    contents: { role: string; parts: { text: string }[] }[];
    systemInstruction?: { parts: { text: string }[] };
    generationConfig?: {
      temperature?: number;
      maxOutputTokens?: number;
      responseMimeType?: string;
      stopSequences?: string[];
    };
  };
  assert.equal(body.contents.length, 3); // system pulled out
  assert.equal(body.contents[0]?.role, "user");
  assert.equal(body.contents[1]?.role, "model"); // assistant -> model
  assert.equal(body.contents[2]?.role, "user");
  assert.equal(body.systemInstruction?.parts[0]?.text, "be terse");
  assert.equal(body.generationConfig?.temperature, 0.1);
  assert.equal(body.generationConfig?.maxOutputTokens, 200);
  assert.equal(body.generationConfig?.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig?.stopSequences, ["\n"]);
});

test("OpenAiProvider retries 429 with the body's try-again hint then succeeds", async () => {
  const captured: CapturedFetch[] = [];
  const sleeps: number[] = [];
  let attempt = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: typeof input === "string" ? input : input.toString(), init });
    attempt += 1;
    if (attempt === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Rate limit reached. Please try again in 250ms.",
            type: "tokens",
          },
        }),
        { status: 429 },
      );
    }
    return jsonResponse({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
  }) as unknown as typeof fetch;
  const p = new OpenAiProvider({
    apiKey: "sk-fake",
    baseUrl: "https://api.example.test/v1",
    fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const out = await p.call({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "x" }],
    opts: {},
  });
  assert.equal(out.text, "ok");
  assert.equal(captured.length, 2, "second attempt after 429");
  assert.equal(sleeps.length, 1);
  // First attempt's backoff floor is 500ms; the body hint of 250ms is below
  // the floor, so we expect the floor to win. (Body hint > floor would win.)
  assert.ok(sleeps[0]! >= 500, `expected at least 500ms backoff, got ${sleeps[0]}`);
});

test("OpenAiProvider gives up after maxRetries and throws the last 429", async () => {
  const sleeps: number[] = [];
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ error: { message: "rate limit" } }),
      { status: 429 },
    )) as unknown as typeof fetch;
  const p = new OpenAiProvider({
    apiKey: "sk-fake",
    baseUrl: "https://api.example.test/v1",
    fetchImpl,
    maxRetries: 2,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  await assert.rejects(
    () =>
      p.call({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "x" }],
        opts: {},
      }),
    /OpenAI 429/,
  );
  // 3 attempts (initial + 2 retries) → 2 sleeps.
  assert.equal(sleeps.length, 2);
});

test("OpenAiProvider does NOT retry 4xx that are not 429", async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    return new Response("bad request", { status: 400 });
  }) as unknown as typeof fetch;
  const p = new OpenAiProvider({
    apiKey: "sk-fake",
    baseUrl: "https://api.example.test/v1",
    fetchImpl,
    sleep: () => Promise.resolve(),
  });
  await assert.rejects(
    () =>
      p.call({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "x" }],
        opts: {},
      }),
    /OpenAI 400/,
  );
  assert.equal(attempts, 1, "no retry on non-transient 4xx");
});

test("OpenAiProvider passes multimodal array content through unchanged", async () => {
  const captured: CapturedFetch[] = [];
  const fetchImpl = makeFetch(captured, () =>
    jsonResponse({
      choices: [{ message: { content: "{\"type\":\"finish\"}" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );
  const p = new OpenAiProvider({
    apiKey: "sk-fake",
    baseUrl: "https://api.example.test/v1",
    fetchImpl,
  });
  await p.call({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "x" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAA=" } },
        ],
      },
    ],
    opts: {},
  });
  const body = JSON.parse(captured[0]!.init?.body as string) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  assert.ok(Array.isArray(body.messages[1]?.content), "array content preserved");
});

test("GeminiProvider rejects multimodal array content with a clear error", async () => {
  const fetchImpl = (async () => jsonResponse({})) as unknown as typeof fetch;
  const p = new GeminiProvider({
    apiKey: "gem-fake",
    baseUrl: "https://gen.example.test/v1beta",
    fetchImpl,
  });
  await assert.rejects(
    () =>
      p.call({
        model: "gemini-2.5-flash",
        messages: [
          { role: "user", content: [{ type: "text", text: "x" }] },
        ],
        opts: {},
      }),
    /multimodal arrays are OpenAI-only/,
  );
});

test("GeminiProvider error includes status; LLMClient redaction is responsible for scrubbing", async () => {
  // We DON'T scrub at the provider layer. The provider's job is to surface
  // the error verbatim; the LLMClient redacts before it reaches the agent.
  const fetchImpl = makeFetch([], () =>
    new Response('{"error":{"message":"API key not valid: gem-LEAK"}}', { status: 400 }),
  );
  const p = new GeminiProvider({
    apiKey: "gem-LEAK",
    baseUrl: "https://gen.example.test/v1beta",
    fetchImpl,
  });
  await assert.rejects(
    () =>
      p.call({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "x" }],
        opts: {},
      }),
    /Gemini 400/,
  );
});
