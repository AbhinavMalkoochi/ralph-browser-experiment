// US-015: runtime-codegen agent.
//
// Coverage:
//   - extractScript: bare body, ```js / ```javascript / ``` fences, leading prose.
//   - extractScript: rejects empty body and body with no `return`.
//   - wrapBody: produces an async IIFE with an in-page try/catch returning {__error}.
//   - normaliseResult: handles done/navigate/sleep_ms, in-page error,
//     unknown shapes, missing message.
//   - End-to-end run on real Chrome with a scripted LLM:
//       * clicks a visible button via emitted JS, then finishes DONE.
//       * pierces a shadow root via shadowRoot.querySelector.
//       * an in-page throw is captured as {__error} and surfaced as the
//         next observation (one self-correcting retry).
//   - parse_error path doesn't abort the loop.
//   - No-LLM (replay-only client) declines cleanly.
//   - Tight steps budget short-circuits with BUDGET_EXCEEDED.
//   - Manifest distinctness vs baseline-a11y-react AND plan-then-execute.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import RuntimeCodegenAgent from "../../../agents/runtime-codegen/agent.js";
import {
  CodegenParseError,
  extractScript,
  normaliseResult,
  wrapBody,
} from "../../../agents/runtime-codegen/codegen.js";

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
// extractScript
// -----------------------------------------------------------------------------

test("extractScript: bare body with a return passes through", () => {
  const body = extractScript('return { done: true, message: "ok" };');
  assert.match(body, /return \{ done: true/);
});

test("extractScript: ```js fence", () => {
  const body = extractScript(
    "```js\nreturn { done: false, message: 'x' };\n```",
  );
  assert.match(body, /return \{ done: false/);
  assert.doesNotMatch(body, /```/);
});

test("extractScript: ```javascript fence", () => {
  const body = extractScript(
    "```javascript\nconst x = 1; return { done: false, message: 'x' };\n```",
  );
  assert.match(body, /const x = 1/);
});

test("extractScript: bare ``` fence", () => {
  const body = extractScript(
    "```\nreturn { done: true, message: 'ok' };\n```",
  );
  assert.match(body, /return \{ done: true/);
});

test("extractScript: leading prose before the fence is dropped", () => {
  const body = extractScript(
    "I'll click the button:\n```js\nreturn { done: false, message: 'clicked' };\n```",
  );
  assert.doesNotMatch(body, /I'll click/);
  assert.match(body, /return \{ done: false/);
});

test("extractScript: rejects empty completion", () => {
  assert.throws(
    () => extractScript(""),
    (err: unknown) => err instanceof CodegenParseError,
  );
});

test("extractScript: rejects body without a return", () => {
  assert.throws(
    () => extractScript("console.log('hello world');"),
    (err: unknown) =>
      err instanceof CodegenParseError && /return/.test((err as Error).message),
  );
});

// -----------------------------------------------------------------------------
// wrapBody
// -----------------------------------------------------------------------------

test("wrapBody: produces an async IIFE with in-page try/catch", () => {
  const w = wrapBody("return { done: true, message: 'x' };");
  assert.match(w, /\(async \(\) => \{/);
  assert.match(w, /try \{/);
  assert.match(w, /catch \(__err\) \{/);
  assert.match(w, /return \{__error:/);
  assert.match(w, /\}\)\(\)$/);
});

// -----------------------------------------------------------------------------
// normaliseResult
// -----------------------------------------------------------------------------

test("normaliseResult: done:true round-trips", () => {
  const r = normaliseResult({ done: true, message: "finished" });
  assert.equal(r.ok, true);
  assert.equal(r.done, true);
  assert.equal(r.message, "finished");
});

test("normaliseResult: navigate field surfaces", () => {
  const r = normaliseResult({
    done: false,
    navigate: "https://example.com/",
    message: "go",
  });
  assert.equal(r.navigate, "https://example.com/");
  assert.equal(r.done, false);
});

test("normaliseResult: sleep_ms clamps to [0,5000]", () => {
  const r = normaliseResult({ done: false, sleep_ms: 999_999, message: "wait" });
  assert.equal(r.sleep_ms, 5_000);
  const r2 = normaliseResult({ done: false, sleep_ms: -10, message: "wait" });
  assert.equal(r2.sleep_ms, 0);
  const r3 = normaliseResult({ done: false, message: "no sleep" });
  assert.equal(r3.sleep_ms, null);
});

test("normaliseResult: in-page error surfaces", () => {
  const r = normaliseResult({ __error: "TypeError: x is null", __stack: "frames..." });
  assert.equal(r.ok, false);
  assert.equal(r.done, false);
  assert.match(r.message, /TypeError: x is null/);
  assert.equal(r.error, "TypeError: x is null");
  assert.equal(r.stack, "frames...");
});

test("normaliseResult: null return yields ok:false with a descriptive message", () => {
  const r = normaliseResult(null);
  assert.equal(r.ok, false);
  assert.match(r.message, /no value/);
});

test("normaliseResult: non-object return is fail-with-message", () => {
  const r = normaliseResult(42);
  assert.equal(r.ok, false);
  assert.match(r.message, /number/);
});

test("normaliseResult: missing message gets a default", () => {
  const r = normaliseResult({ done: false });
  assert.equal(r.ok, true);
  assert.equal(r.message, "continuing");
});

// -----------------------------------------------------------------------------
// End-to-end run on real Chrome with a scripted LLM
// -----------------------------------------------------------------------------

test("run: clicks a visible button via emitted JS then finishes DONE", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-rcg-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-rcg-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `
      <!doctype html>
      <title>rcg click</title>
      <script>window.__clicked = null;</script>
      <button onclick="window.__clicked='go'">Continue</button>
    `;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const clickScript =
      "const btn = Array.from(document.querySelectorAll('button')).find(b => /Continue/i.test(b.textContent));\n" +
      "if (!btn) return { done: false, message: 'no Continue' };\n" +
      "btn.click();\n" +
      "return { done: false, message: 'clicked Continue' };";
    const finishScript =
      "const c = window.__clicked || null;\n" +
      "if (c === 'go') return { done: true, message: 'click recorded' };\n" +
      "return { done: false, message: 'not yet' };";
    const { provider, calls } = scriptedProvider([
      { reply: { text: clickScript, tokens_in: 80, tokens_out: 40 } },
      { reply: { text: finishScript, tokens_in: 80, tokens_out: 20 } },
    ]);

    const agent = new RuntimeCodegenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-click",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run(
      "click the Continue button",
      session,
      generousBudget(),
      { task_id: "rcg-click", seed: 0, runs_root: runsRoot },
    );

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2, "exactly two LLM turns");
    const clicked = await session.evaluate<string | null>("window.__clicked");
    assert.equal(clicked, "go");

    const lines = await readGzipLines(traj.gzPath);
    const kinds = lines.map((l) => (l as { kind: string }).kind);
    // meta + 2 llm_call + 2 step + end
    assert.deepEqual(
      kinds.filter(
        (k) => k === "step" || k === "llm_call" || k === "end" || k === "meta",
      ),
      ["meta", "llm_call", "step", "llm_call", "step", "end"],
    );

    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; ok: boolean; done: boolean; script: string };
    }>;
    assert.equal(steps[0]?.action.type, "emit");
    assert.equal(steps[0]?.action.ok, true);
    assert.equal(steps[0]?.action.done, false);
    assert.match(steps[0]?.action.script ?? "", /Continue/);
    assert.equal(steps[1]?.action.done, true);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: emitted JS pierces a shadow root and submits a form", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-rcg-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-rcg-"));
  const session = await CdpBrowserSession.create();
  try {
    // A custom element with an open shadow root containing a form. The
    // shadow root's submit handler bumps window.__submitted.
    const html = `<!doctype html>
<title>rcg shadow</title>
<my-form></my-form>
<script>
window.__submitted = null;
class MyForm extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({mode: 'open'});
    root.innerHTML = '<form><input name="code"><button type="submit">Go</button></form>';
    root.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      window.__submitted = root.querySelector('input').value;
    });
  }
}
customElements.define('my-form', MyForm);
</script>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const fillScript =
      "const host = document.querySelector('my-form');\n" +
      "const root = host && host.shadowRoot;\n" +
      "const input = root && root.querySelector('input[name=\"code\"]');\n" +
      "if (!input) return { done: false, message: 'no input' };\n" +
      "input.value = 'XYZ-42';\n" +
      "input.dispatchEvent(new Event('input', {bubbles:true}));\n" +
      "const form = root.querySelector('form');\n" +
      "form.requestSubmit();\n" +
      "return { done: false, message: 'submitted shadow form', sleep_ms: 50 };";
    const checkScript =
      "if (window.__submitted === 'XYZ-42') return { done: true, message: 'shadow submit observed' };\n" +
      "return { done: false, message: 'not seen yet' };";
    const { provider, calls } = scriptedProvider([
      { reply: { text: fillScript, tokens_in: 100, tokens_out: 60 } },
      { reply: { text: checkScript, tokens_in: 80, tokens_out: 20 } },
    ]);

    const agent = new RuntimeCodegenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-shadow",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run(
      "submit XYZ-42 to the shadow form",
      session,
      generousBudget(),
      { task_id: "rcg-shadow", seed: 0, runs_root: runsRoot },
    );

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2);
    const submitted = await session.evaluate<string | null>("window.__submitted");
    assert.equal(submitted, "XYZ-42", "shadow form was submitted by emitted JS");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: in-page exception comes back as a fail-result and the loop self-corrects", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-rcg-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-rcg-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eerr%3C%2Ftitle%3E");
    const throwScript =
      "const x = null;\n" +
      "x.y = 1;\n" +
      "return { done: false, message: 'unreachable' };";
    const recoverScript =
      "return { done: true, message: 'recovered after fail' };";
    const { provider, calls } = scriptedProvider([
      { reply: { text: throwScript, tokens_in: 50, tokens_out: 30 } },
      { reply: { text: recoverScript, tokens_in: 50, tokens_out: 10 } },
    ]);

    const agent = new RuntimeCodegenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-throw",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("recover from a script error", session, generousBudget(), {
      task_id: "rcg-throw",
      seed: 0,
      runs_root: runsRoot,
    });

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 2, "second turn re-prompts with the failure observation");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; ok: boolean; done: boolean; error?: string };
    }>;
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.action.ok, false, "first script's __error came back as fail");
    assert.match(steps[0]?.action.error ?? "", /null|Cannot set/);
    assert.equal(steps[1]?.action.done, true);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: parse_error does not abort the loop", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-rcg-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-rcg-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eparse%3C%2Ftitle%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: "I am not JavaScript", tokens_in: 30, tokens_out: 10 } },
      {
        reply: {
          text: "return { done: true, message: 'second try' };",
          tokens_in: 30,
          tokens_out: 10,
        },
      },
    ]);
    const agent = new RuntimeCodegenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "test-parse",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "rcg-parse",
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
    assert.equal(steps[1]?.action.type, "emit");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-rcg-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-rcg-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C%2Ftitle%3E");
    const agent = new RuntimeCodegenAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "rcg-no-llm",
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
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-rcg-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-rcg-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbutton%3EX%3C%2Fbutton%3E");
    const { provider, calls } = scriptedProvider([
      {
        reply: {
          text: "return { done: true, message: 'x' };",
          tokens_in: 10,
          tokens_out: 5,
        },
      },
    ]);
    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep(); // pre-trip the steps axis

    const agent = new RuntimeCodegenAgent({
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
      task_id: "rcg-tight",
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

test("manifest: runtime-codegen distinct_from baseline AND plan-then-execute, with zero keyword overlap", async () => {
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
  const baseline = parseYaml(baselineRaw) as { approach_keywords: string[] };
  const pte = parseYaml(pteRaw) as { approach_keywords: string[] };
  const rcg = parseYaml(rcgRaw) as {
    distinct_from: string[];
    approach_keywords: string[];
  };
  assert.ok(rcg.distinct_from.includes("baseline-a11y-react"));
  assert.ok(rcg.distinct_from.includes("plan-then-execute"));

  const rcgSet = new Set(rcg.approach_keywords.map((k) => k.toLowerCase()));
  const bSet = new Set(baseline.approach_keywords.map((k) => k.toLowerCase()));
  const pSet = new Set(pte.approach_keywords.map((k) => k.toLowerCase()));
  let bOverlap = 0;
  let pOverlap = 0;
  for (const k of rcgSet) {
    if (bSet.has(k)) bOverlap += 1;
    if (pSet.has(k)) pOverlap += 1;
  }
  assert.equal(bOverlap, 0, "no shared approach_keywords with baseline-a11y-react");
  assert.equal(pOverlap, 0, "no shared approach_keywords with plan-then-execute");
});
