// Hard-auth slice (US-028) contract tests.
//
// Validates: every YAML loads, declares requires_env, an `auth` block (or
// is explicitly the no-auth Google Form), uses an HTTPS start URL, has a
// JS verifier with case-insensitive matching, and that the SKIP path in
// the tournament runner records terminal_state="SKIPPED_AUTH" without
// counting toward leaderboard totals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { loadTaskFile } from "../verifier/loader.js";
import { missingEnv, substituteEnv, authSecretValues } from "../auth/inject.js";
import { aggregate } from "../tournament/leaderboard.js";
import type { CellSummary } from "../tournament/types.js";

const SLICE_DIR = join(process.cwd(), "tasks", "suite", "hard-auth");

test("hard-auth: directory has 4-6 yaml task specs", async () => {
  const files = (await readdir(SLICE_DIR)).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length >= 4 && files.length <= 6, `expected 4-6 yaml, got ${files.length}`);
});

test("hard-auth: every task declares requires_env, https start_url, js verifier", async () => {
  const files = (await readdir(SLICE_DIR)).filter((f) => f.endsWith(".yaml"));
  for (const f of files) {
    const task = await loadTaskFile(join(SLICE_DIR, f));
    assert.equal(task.difficulty, "hard", `${f}: difficulty must be hard`);
    assert.ok(task.start_url.startsWith("https://"), `${f}: start_url must be https`);
    assert.ok(
      task.requires_env && task.requires_env.length > 0,
      `${f}: requires_env must be a non-empty list`,
    );
    assert.equal(task.verifier.kind, "js", `${f}: verifier.kind must be js`);
    if (task.verifier.kind === "js") {
      assert.ok(/\/i/.test(task.verifier.expression), `${f}: verifier should use /.../i regex`);
      assert.ok(
        /document\.location|document\.body|document\.title/.test(task.verifier.expression),
        `${f}: verifier should check document.location / body / title`,
      );
    }
  }
});

test("hard-auth: at least one task declares browser-layer auth (cookies or headers)", async () => {
  const files = (await readdir(SLICE_DIR)).filter((f) => f.endsWith(".yaml"));
  let withAuth = 0;
  for (const f of files) {
    const task = await loadTaskFile(join(SLICE_DIR, f));
    if (task.auth && (task.auth.cookies?.length || task.auth.headers)) withAuth++;
  }
  assert.ok(withAuth >= 3, `expected >=3 tasks with auth injection, got ${withAuth}`);
});

test("missingEnv reports unset requires_env entries", () => {
  const task = {
    id: "x",
    goal: "g",
    start_url: "https://example.com/",
    difficulty: "hard" as const,
    tags: [],
    verifier: { kind: "js" as const, expression: "true" },
    requires_env: ["GBA_TEST_PRESENT", "GBA_TEST_ABSENT"],
  };
  const env = { GBA_TEST_PRESENT: "x" } as NodeJS.ProcessEnv;
  assert.deepEqual(missingEnv(task, env), ["GBA_TEST_ABSENT"]);
});

test("substituteEnv replaces ${VAR} placeholders", () => {
  const env = { TOK: "secret-1234" } as NodeJS.ProcessEnv;
  assert.equal(substituteEnv("Bearer ${TOK}", env), "Bearer secret-1234");
  assert.equal(substituteEnv("${MISSING}", env), "");
});

test("authSecretValues returns substantive secret values", () => {
  const task = {
    id: "x",
    goal: "g",
    start_url: "https://example.com/",
    difficulty: "hard" as const,
    tags: [],
    verifier: { kind: "js" as const, expression: "true" },
    requires_env: ["TOK"],
  };
  const env = { TOK: "abcd1234efgh" } as NodeJS.ProcessEnv;
  assert.deepEqual(authSecretValues(task, env), ["abcd1234efgh"]);
});

test("leaderboard.aggregate excludes SKIPPED_AUTH cells from totals", () => {
  const base = (over: Partial<CellSummary>): CellSummary => ({
    agent_id: "a",
    task_id: "t",
    seed: 0,
    difficulty: "hard",
    completed_at: "2026-05-11T00:00:00Z",
    terminal_state: "DONE",
    pass: true,
    score: 1,
    reason: "ok",
    decline_reason: null,
    steps: 1,
    llm_calls: 0,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 10,
    attempts: 1,
    ...over,
  });
  const rows = aggregate([
    base({ task_id: "t1" }),
    base({ task_id: "t2", pass: false, terminal_state: "ERROR", score: 0 }),
    base({ task_id: "t3", pass: false, terminal_state: "SKIPPED_AUTH", score: 0 }),
    base({ task_id: "t4", pass: false, terminal_state: "SKIPPED_AUTH", score: 0 }),
  ]);
  assert.equal(rows.length, 1);
  // 1 pass + 1 fail = 2 (SKIPPED_AUTH dropped)
  assert.equal(rows[0]!.total, 2);
  assert.equal(rows[0]!.passed, 1);
});
