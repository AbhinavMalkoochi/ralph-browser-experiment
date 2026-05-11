// US-026: validate the hard-real slice YAML files meet the contract:
//   - 8..10 tasks
//   - difficulty=hard
//   - exactly one of {search, navigate, extract, fill} skill tags
//   - tagged hard + real_site
//   - public https:// start_url (no fixtures://, no auth-required hosts)
//   - verifier kind in {js, trajectory_predicate} — no llm_judge in hard-real
//   - hostnames distinct from every easy-slice host AND from each other
//   - verifier expression checks document.location (cross-page navigation)
//     AND uses a case-insensitive regex (real sites change copy)
//
// Loading every file goes through `loadTaskFile`, so any malformed YAML or
// invalid verifier spec also surfaces here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { loadSliceTasks, SLICE_RETRIES, defaultRetriesForSlice } from "../eval/runner.js";
import type { Task } from "../verifier/types.js";

const SKILL_TAGS = ["search", "navigate", "extract", "fill"] as const;
type SkillTag = (typeof SKILL_TAGS)[number];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function skillTagsOf(task: Task): SkillTag[] {
  return task.tags.filter((t): t is SkillTag => SKILL_TAGS.includes(t as SkillTag));
}

let cached: Task[] | null = null;
async function hardRealTasks(): Promise<Task[]> {
  if (cached) return cached;
  cached = await loadSliceTasks("hard-real", resolve(process.cwd()));
  return cached;
}

let easyCached: Task[] | null = null;
async function easyTasks(): Promise<Task[]> {
  if (easyCached) return easyCached;
  easyCached = await loadSliceTasks("easy", resolve(process.cwd()));
  return easyCached;
}

test("hard-real slice: between 8 and 10 tasks (AC #1)", async () => {
  const tasks = await hardRealTasks();
  assert.ok(
    tasks.length >= 8 && tasks.length <= 10,
    `expected 8..10 hard-real tasks, got ${tasks.length}`,
  );
});

test("hard-real slice: every task has difficulty=hard", async () => {
  const tasks = await hardRealTasks();
  for (const task of tasks) {
    assert.equal(
      task.difficulty,
      "hard",
      `${task.id}: difficulty must be "hard" so hard-tier budgets apply`,
    );
  }
});

test("hard-real slice: every id is unique and prefixed with hard-real-", async () => {
  const tasks = await hardRealTasks();
  const ids = new Set<string>();
  for (const task of tasks) {
    assert.ok(
      task.id.startsWith("hard-real-"),
      `${task.id}: id must be prefixed with "hard-real-"`,
    );
    assert.ok(!ids.has(task.id), `${task.id}: duplicate id`);
    ids.add(task.id);
  }
});

test("hard-real slice: every task is tagged hard + real_site", async () => {
  const tasks = await hardRealTasks();
  for (const task of tasks) {
    assert.ok(task.tags.includes("hard"), `${task.id}: missing "hard" tag`);
    assert.ok(
      task.tags.includes("real_site"),
      `${task.id}: missing "real_site" tag (separates real slice from local fixtures)`,
    );
  }
});

test("hard-real slice: every task has exactly one skill tag", async () => {
  const tasks = await hardRealTasks();
  for (const task of tasks) {
    const matches = skillTagsOf(task);
    assert.equal(
      matches.length,
      1,
      `${task.id}: expected exactly one of [${SKILL_TAGS.join(", ")}]; got [${matches.join(", ")}]`,
    );
  }
});

test("hard-real slice: start_url is a public https URL (AC #4)", async () => {
  const tasks = await hardRealTasks();
  for (const task of tasks) {
    assert.match(
      task.start_url,
      /^https:\/\//,
      `${task.id}: start_url must be https://; got ${task.start_url}`,
    );
    assert.doesNotMatch(
      task.start_url,
      /^fixtures:\/\//,
      `${task.id}: hard-real slice must not depend on local fixtures`,
    );
  }
});

test("hard-real slice: verifier kind is programmatic (AC #4 — no llm_judge)", async () => {
  const tasks = await hardRealTasks();
  for (const task of tasks) {
    assert.ok(
      task.verifier.kind === "js" || task.verifier.kind === "trajectory_predicate",
      `${task.id}: hard-real slice must use a programmatic verifier; got ${task.verifier.kind}`,
    );
  }
});

test("hard-real slice: hostnames are distinct from each other AND from the easy slice (AC #2)", async () => {
  const tasks = await hardRealTasks();
  const easy = await easyTasks();
  const easyHosts = new Set(easy.map((t) => hostOf(t.start_url)).filter(Boolean));
  const seen = new Set<string>();
  for (const task of tasks) {
    const host = hostOf(task.start_url);
    assert.ok(host, `${task.id}: start_url has no parseable hostname`);
    assert.ok(
      !seen.has(host),
      `${task.id}: hostname ${host} collides with another hard-real task`,
    );
    assert.ok(
      !easyHosts.has(host),
      `${task.id}: hostname ${host} is already in the easy slice; pick a host the easy slice does not use`,
    );
    seen.add(host);
  }
});

test("hard-real slice: verifier expression matches document.location and uses /i (AC #3 cross-page, AC #5 regex-tolerant)", async () => {
  const tasks = await hardRealTasks();
  for (const task of tasks) {
    if (task.verifier.kind !== "js") continue;
    const expr = task.verifier.expression;
    assert.match(
      expr,
      /document\.location/,
      `${task.id}: verifier should check document.location (URL changed → cross-page nav)`,
    );
    assert.match(
      expr,
      /\/[^/]+\/i/,
      `${task.id}: verifier should use a case-insensitive regex (/.../i) — real sites change copy`,
    );
  }
});

test("hard-real slice: SLICE_RETRIES['hard-real'] is configured to absorb live-site flakes", () => {
  assert.equal(
    SLICE_RETRIES["hard-real"],
    2,
    "expected hard-real to default to 2 retries (real sites are flaky)",
  );
  assert.equal(
    defaultRetriesForSlice("hard-real"),
    2,
    "defaultRetriesForSlice('hard-real') should report 2",
  );
});

test("hard-real slice: each goal mentions the destination URL pattern (helps agent + verifier stay aligned)", async () => {
  const tasks = await hardRealTasks();
  for (const task of tasks) {
    // The verifier checks pathname; the goal text should hint at WHERE
    // the agent is heading so the prompt and the verifier match.
    assert.ok(
      /\/(.+\/?|[a-z0-9-]+)/i.test(task.goal),
      `${task.id}: goal should reference the destination URL pattern`,
    );
  }
});
