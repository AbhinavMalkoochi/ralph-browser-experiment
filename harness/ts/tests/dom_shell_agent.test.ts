// US-033: dom-shell agent.
//
// Coverage:
//   - tokenise: bare words, quoted strings, comments, escapes.
//   - parseCommand: every verb in the vocabulary; tolerant fence / leading prose;
//     rejects unknown commands and empty input.
//   - applyCd / cwdSelector / cwdDisplay: pure cwd algebra.
//   - End-to-end runs on real Chrome with a scripted LLM:
//       * cd into a form, fill inputs cwd-relative, submit, done.
//       * find --interactive filters to interactive elements only.
//       * cd into a shadow host's wrapper and operate.
//       * cd to a non-existent selector leaves cwd unchanged and the result
//         is surfaced as a failure.
//   - Trajectory step records carry the cwd field.
//   - parse_error path doesn't abort the loop.
//   - No-LLM declines cleanly; tight budget short-circuits.
//   - Manifest distinctness vs prior agents (Jaccard=0 on keywords).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";

import DomShellAgent from "../../../agents/dom-shell/agent.js";
import {
  applyCd,
  cwdDisplay,
  cwdSelector,
  parseCommand,
  ShellParseError,
  tokenise,
} from "../../../agents/dom-shell/shell.js";

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
// tokenise
// -----------------------------------------------------------------------------

test("tokenise: bare words", () => {
  assert.deepEqual(tokenise("ls form input"), ["ls", "form", "input"]);
});

test("tokenise: double-quoted string with spaces", () => {
  assert.deepEqual(tokenise('type input "hello world"'), [
    "type",
    "input",
    "hello world",
  ]);
});

test("tokenise: single-quoted string", () => {
  assert.deepEqual(tokenise("click 'a.btn primary'"), ["click", "a.btn primary"]);
});

test("tokenise: `#` is part of a CSS id selector, not a comment", () => {
  assert.deepEqual(tokenise("cd form#login"), ["cd", "form#login"]);
  assert.deepEqual(tokenise("ls #root"), ["ls", "#root"]);
});

test("tokenise: backslash escape inside quoted string", () => {
  assert.deepEqual(tokenise('type x "say \\"hi\\""'), ["type", "x", 'say "hi"']);
});

test("tokenise: unterminated quote throws ShellParseError", () => {
  assert.throws(
    () => tokenise('type x "oops'),
    (e: unknown) => e instanceof ShellParseError,
  );
});

// -----------------------------------------------------------------------------
// parseCommand
// -----------------------------------------------------------------------------

test("parseCommand: ls with no arg", () => {
  const c = parseCommand("ls");
  assert.equal(c.cmd, "ls");
});

test("parseCommand: cd target", () => {
  const c = parseCommand('cd form#login');
  assert.equal(c.cmd, "cd");
  assert.equal((c as { target: string }).target, "form#login");
});

test("parseCommand: cd .. and cd /", () => {
  assert.equal((parseCommand("cd ..") as { target: string }).target, "..");
  assert.equal((parseCommand("cd /") as { target: string }).target, "/");
});

test("parseCommand: find --interactive sets flag", () => {
  const c = parseCommand("find button --interactive");
  assert.equal(c.cmd, "find");
  assert.equal((c as { selector: string; interactive: boolean }).interactive, true);
  assert.equal((c as { selector: string; interactive: boolean }).selector, "button");
});

test("parseCommand: type with quoted text and --submit", () => {
  const c = parseCommand('type input[name="email"] "u@example.com" --submit');
  assert.equal(c.cmd, "type");
  const t = c as { selector: string; text: string; submit: boolean };
  assert.equal(t.selector, 'input[name="email"]');
  assert.equal(t.text, "u@example.com");
  assert.equal(t.submit, true);
});

test("parseCommand: scroll defaults", () => {
  const c = parseCommand("scroll");
  assert.equal(c.cmd, "scroll");
  assert.equal((c as { direction: string; pixels: number }).direction, "down");
  assert.equal((c as { direction: string; pixels: number }).pixels, 400);
});

test("parseCommand: scroll up 200", () => {
  const c = parseCommand("scroll up 200");
  assert.equal((c as { direction: string; pixels: number }).direction, "up");
  assert.equal((c as { direction: string; pixels: number }).pixels, 200);
});

test("parseCommand: grep with pattern only", () => {
  const c = parseCommand('grep "Order placed"');
  assert.equal(c.cmd, "grep");
  assert.equal((c as { pattern: string }).pattern, "Order placed");
});

test("parseCommand: attr name + selector", () => {
  const c = parseCommand("attr href a.next");
  assert.equal(c.cmd, "attr");
  assert.equal((c as { name: string; selector?: string }).name, "href");
  assert.equal((c as { name: string; selector?: string }).selector, "a.next");
});

test("parseCommand: done / decline include reason", () => {
  const d = parseCommand('done "order placed"');
  assert.equal(d.cmd, "done");
  assert.equal((d as { reason: string }).reason, "order placed");
  const x = parseCommand("decline cannot find form");
  assert.equal((x as { reason: string }).reason, "cannot find form");
});

test("parseCommand: tolerates a ```sh fence", () => {
  const c = parseCommand("```sh\nclick button\n```");
  assert.equal(c.cmd, "click");
});

test("parseCommand: tolerates leading prose, last non-empty line wins", () => {
  const c = parseCommand("Thought: I should list children first.\nls");
  assert.equal(c.cmd, "ls");
});

test("parseCommand: rejects empty completion", () => {
  assert.throws(
    () => parseCommand(""),
    (e: unknown) => e instanceof ShellParseError,
  );
});

test("parseCommand: rejects unknown command", () => {
  assert.throws(
    () => parseCommand("frobnicate the widget"),
    (e: unknown) => e instanceof ShellParseError && /unknown command/.test((e as Error).message),
  );
});

// -----------------------------------------------------------------------------
// cwd algebra
// -----------------------------------------------------------------------------

test("applyCd: / resets, .. pops, selector pushes", () => {
  assert.deepEqual(applyCd(["form", "input"], "/"), []);
  assert.deepEqual(applyCd(["form", "input"], ".."), ["form"]);
  assert.deepEqual(applyCd(["form"], "input[name='x']"), ["form", "input[name='x']"]);
  assert.deepEqual(applyCd([], ".."), []);
});

test("applyCd: absolute /x resets then pushes x", () => {
  assert.deepEqual(applyCd(["form", "input"], "/main"), ["main"]);
});

test("cwdSelector joins with descendant combinator; cwdDisplay shows '/' for root", () => {
  assert.equal(cwdSelector([]), "");
  assert.equal(cwdSelector(["form", "input"]), "form input");
  assert.equal(cwdDisplay([]), "/");
  assert.equal(cwdDisplay(["form", "input"]), "/form / input");
});

// -----------------------------------------------------------------------------
// End-to-end runs on real Chrome
// -----------------------------------------------------------------------------

test("run: cd into form, type cwd-relative, submit, done", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-domsh-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-domsh-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>domsh form</title>
<script>window.__submitted = null;</script>
<form id="login">
  <input name="email">
  <input name="password" type="password">
  <button type="submit">Sign in</button>
</form>
<script>
document.getElementById('login').addEventListener('submit', function(e) {
  e.preventDefault();
  window.__submitted = {
    email: document.querySelector('input[name="email"]').value,
    password: document.querySelector('input[name="password"]').value
  };
});
</script>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const { provider, calls } = scriptedProvider([
      { reply: { text: "cd form#login", tokens_in: 10, tokens_out: 4 } },
      {
        reply: {
          text: 'type input[name="email"] "u@example.com"',
          tokens_in: 10,
          tokens_out: 6,
        },
      },
      {
        reply: {
          text: 'type input[name="password"] "hunter2" --submit',
          tokens_in: 10,
          tokens_out: 6,
        },
      },
      {
        reply: { text: 'done "signed in"', tokens_in: 10, tokens_out: 4 },
      },
    ]);

    const agent = new DomShellAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "domsh-form",
        }),
      maxSteps: 8,
    });
    const traj = await agent.run(
      "sign in as u@example.com / hunter2",
      session,
      generousBudget(),
      { task_id: "domsh-form", seed: 0, runs_root: runsRoot },
    );

    assert.equal(traj.metadata.terminal_state, "DONE");
    assert.equal(calls.length, 4);
    const submitted = await session.evaluate<{ email: string; password: string } | null>(
      "window.__submitted",
    );
    assert.equal(submitted?.email, "u@example.com");
    assert.equal(submitted?.password, "hunter2");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { type: string; cmd: string; cwd: string; ok: boolean };
    }>;
    assert.equal(steps.length, 4);
    assert.equal(steps[0]?.action.cmd, "cd");
    assert.equal(steps[0]?.action.ok, true);
    // After cd, cwd is /form#login
    assert.match(steps[0]?.action.cwd ?? "", /form#login/);
    // type commands record the cwd as well
    assert.match(steps[1]?.action.cwd ?? "", /form#login/);
    assert.equal(steps[1]?.action.cmd, "type");
    assert.equal(steps[3]?.action.cmd, "done");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: find --interactive filters to interactive elements only", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-domsh-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-domsh-"));
  const session = await CdpBrowserSession.create();
  try {
    const html = `<!doctype html><title>domsh find</title>
<div id="root">
  <p>just text</p>
  <span>more text</span>
  <button id="go">Go</button>
  <a id="link" href="#">Link</a>
  <input id="i" name="x">
  <div>noisy wrapper</div>
</div>`;
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    let interactiveOutput = "";
    const { provider } = scriptedProvider([
      { reply: { text: "cd #root", tokens_in: 5, tokens_out: 4 } },
      { reply: { text: "find * --interactive", tokens_in: 5, tokens_out: 4 } },
      { reply: { text: "done found", tokens_in: 5, tokens_out: 4 } },
    ]);
    const agent = new DomShellAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "domsh-find",
        }),
      maxSteps: 6,
    });
    const traj = await agent.run("find interactive nodes", session, generousBudget(), {
      task_id: "domsh-find",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE");

    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { cmd: string; output?: string; extras?: { total?: number } };
    }>;
    const findStep = steps.find((s) => s.action.cmd === "find");
    assert.ok(findStep, "expected a find step");
    interactiveOutput = findStep!.action.output ?? "";
    // Should include the button, link, and input
    assert.match(interactiveOutput, /<button/);
    assert.match(interactiveOutput, /<a/);
    assert.match(interactiveOutput, /<input/);
    // Should NOT include <p> or <span> or <div>
    assert.doesNotMatch(interactiveOutput, /<p[ >]/);
    assert.doesNotMatch(interactiveOutput, /<span/);
    // Returned count exactly 3 (button, a, input)
    assert.equal(findStep!.action.extras?.total, 3);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: cd to a non-existent selector leaves cwd unchanged and surfaces an error", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-domsh-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-domsh-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cdiv%20id=%22a%22%3Ehi%3C/div%3E");
    const { provider } = scriptedProvider([
      { reply: { text: "cd #does-not-exist", tokens_in: 5, tokens_out: 4 } },
      { reply: { text: "done ok", tokens_in: 5, tokens_out: 4 } },
    ]);
    const agent = new DomShellAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "domsh-cd-fail",
        }),
      maxSteps: 5,
    });
    const traj = await agent.run("test cd failure", session, generousBudget(), {
      task_id: "domsh-cd-fail",
      seed: 0,
      runs_root: runsRoot,
    });
    assert.equal(traj.metadata.terminal_state, "DONE");
    const lines = await readGzipLines(traj.gzPath);
    const steps = lines.filter((l) => (l as { kind: string }).kind === "step") as Array<{
      action: { cmd: string; ok: boolean; cwd: string; error: string | null };
    }>;
    const cdStep = steps[0];
    assert.equal(cdStep?.action.cmd, "cd");
    assert.equal(cdStep?.action.ok, false);
    // cwd stayed at root
    assert.equal(cdStep?.action.cwd, "/");
    assert.match(cdStep?.action.error ?? "", /unresolved|did not resolve/i);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: parse_error does not abort the loop", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-domsh-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-domsh-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Edomsh%3C/title%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: "I am not a command", tokens_in: 5, tokens_out: 5 } },
      { reply: { text: "done recovered", tokens_in: 5, tokens_out: 5 } },
    ]);
    const agent = new DomShellAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "record",
          providers: { openai: provider },
          budget: b,
          trajectory: t,
          paradigmSeed: "domsh-parse",
        }),
      maxSteps: 4,
    });
    const traj = await agent.run("any goal", session, generousBudget(), {
      task_id: "domsh-parse",
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
    assert.equal(steps[1]?.action.type, "shell");
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("run: no LLM provider declines cleanly", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-domsh-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-domsh-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Eempty%3C/title%3E");
    const agent = new DomShellAgent({
      llmFactory: (b, t) =>
        new LLMClient({
          cacheRoot,
          mode: "replay",
          budget: b,
          trajectory: t,
        }),
    });
    const traj = await agent.run("anything", session, generousBudget(), {
      task_id: "domsh-no-llm",
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
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-domsh-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "gba-llm-domsh-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Cbutton%3EX%3C/button%3E");
    const { provider, calls } = scriptedProvider([
      { reply: { text: "done x", tokens_in: 5, tokens_out: 4 } },
    ]);
    const tight = new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 0 });
    tight.recordStep();
    const agent = new DomShellAgent({
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
      task_id: "domsh-tight",
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
// Manifest distinctness
// -----------------------------------------------------------------------------

test("manifest: dom-shell has zero approach_keyword overlap with prior agents", async () => {
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
  ];
  const selfRaw = await readFile(
    new URL("../../../agents/dom-shell/manifest.yaml", import.meta.url),
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
      `dom-shell.distinct_from missing ${prior}`,
    );
    const raw = await readFile(
      new URL(`../../../agents/${prior}/manifest.yaml`, import.meta.url),
      "utf8",
    );
    const parsed = parseYaml(raw) as { approach_keywords: string[] };
    let overlap = 0;
    for (const k of parsed.approach_keywords.map((s) => s.toLowerCase())) {
      if (selfSet.has(k)) overlap += 1;
    }
    assert.equal(overlap, 0, `keyword overlap with ${prior}: ${overlap}`);
  }
});
