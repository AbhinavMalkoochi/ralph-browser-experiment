// loadTaskFile + validateTaskSpec — every required field, every kind, every
// reject path. Failures here mean a malformed YAML file would slip into the
// tournament runner without being caught at load time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadTaskFile,
  validateTaskSpec,
  validateVerifierSpec,
} from "../verifier/loader.js";
import { InvalidTaskSpecError } from "../verifier/types.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "gba-tasks-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadTaskFile: parses a complete task with js verifier", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "task.yaml");
    await writeFile(
      path,
      `id: t1
goal: do the thing
start_url: about:blank
difficulty: easy
tags: [easy, smoke]
verifier:
  kind: js
  expression: window.__test === true
`,
    );
    const task = await loadTaskFile(path);
    assert.equal(task.id, "t1");
    assert.equal(task.difficulty, "easy");
    assert.deepEqual(task.tags, ["easy", "smoke"]);
    assert.equal(task.verifier.kind, "js");
    if (task.verifier.kind === "js") {
      assert.equal(task.verifier.expression, "window.__test === true");
    }
  });
});

test("validateTaskSpec: rejects missing id", () => {
  assert.throws(
    () =>
      validateTaskSpec({
        goal: "g",
        start_url: "about:blank",
        difficulty: "easy",
        tags: [],
        verifier: { kind: "js", expression: "true" },
      }),
    /missing or empty "id"/,
  );
});

test("validateTaskSpec: rejects unknown difficulty", () => {
  assert.throws(
    () =>
      validateTaskSpec({
        id: "t",
        goal: "g",
        start_url: "about:blank",
        difficulty: "extreme",
        tags: [],
        verifier: { kind: "js", expression: "true" },
      }),
    /difficulty must be one of/,
  );
});

test("validateTaskSpec: rejects non-string tag entries", () => {
  assert.throws(
    () =>
      validateTaskSpec({
        id: "t",
        goal: "g",
        start_url: "about:blank",
        difficulty: "easy",
        tags: [1, 2],
        verifier: { kind: "js", expression: "true" },
      }),
    /every "tags" entry must be a string/,
  );
});

test("validateVerifierSpec: rejects unknown kind", () => {
  assert.throws(
    () =>
      validateVerifierSpec({ kind: "magic", expression: "x" }, [], "<task>"),
    /verifier.kind must be one of/,
  );
});

test("validateVerifierSpec: rejects llm_judge without judge_required tag", () => {
  assert.throws(
    () =>
      validateVerifierSpec(
        { kind: "llm_judge", question: "Did the agent succeed?" },
        ["easy"],
        "<task>",
      ),
    /requires the task to be tagged "judge_required"/,
  );
});

test("validateVerifierSpec: accepts llm_judge with judge_required tag", () => {
  const spec = validateVerifierSpec(
    { kind: "llm_judge", question: "Did the agent succeed?", model: "gpt-4o" },
    ["judge_required"],
    "<task>",
  );
  assert.equal(spec.kind, "llm_judge");
  if (spec.kind === "llm_judge") {
    assert.equal(spec.question, "Did the agent succeed?");
    assert.equal(spec.model, "gpt-4o");
  }
});

test("validateVerifierSpec: rejects trajectory_predicate with bad expression", () => {
  assert.throws(
    () =>
      validateVerifierSpec(
        { kind: "trajectory_predicate", expression: "this is not (((( valid)))" },
        [],
        "<task>",
      ),
    /failed to compile/,
  );
});

test("validateVerifierSpec: trajectory_predicate compiles valid expression", () => {
  const spec = validateVerifierSpec(
    {
      kind: "trajectory_predicate",
      expression: "traj.steps.some(s => s.action.type === 'click_link')",
    },
    [],
    "<task>",
  );
  assert.equal(spec.kind, "trajectory_predicate");
});

test("validateVerifierSpec: rejects empty expression on js", () => {
  assert.throws(
    () => validateVerifierSpec({ kind: "js", expression: "" }, [], "<task>"),
    /expression is required/,
  );
});
