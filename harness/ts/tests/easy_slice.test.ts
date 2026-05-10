// US-009: validate the easy slice YAML files meet the contract:
//   - >= 20 tasks
//   - difficulty=easy
//   - exactly one of {search, navigate, extract, fill} skill tags
//   - goal length <= 120 words
//   - public start_url (no fixtures://, no auth-required hosts)
//   - verifier kind in {js, trajectory_predicate} — no llm_judge in easy
//   - at least 10 distinct hostnames across the slice
//
// Loading every file goes through `loadTaskFile`, so any malformed YAML or
// invalid verifier spec also surfaces here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { loadSliceTasks } from "../eval/runner.js";
import type { Task } from "../verifier/types.js";

const SKILL_TAGS = ["search", "navigate", "extract", "fill"] as const;
type SkillTag = (typeof SKILL_TAGS)[number];

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

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
async function easyTasks(): Promise<Task[]> {
  if (cached) return cached;
  cached = await loadSliceTasks("easy", resolve(process.cwd()));
  return cached;
}

test("easy slice: at least 20 tasks", async () => {
  const tasks = await easyTasks();
  assert.ok(
    tasks.length >= 20,
    `expected >= 20 easy tasks, got ${tasks.length}`,
  );
});

test("easy slice: every task has difficulty=easy", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    assert.equal(task.difficulty, "easy", `${task.id}: difficulty must be "easy"`);
  }
});

test("easy slice: every task has exactly one skill tag", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    const matches = skillTagsOf(task);
    assert.equal(
      matches.length,
      1,
      `${task.id}: expected exactly one of [${SKILL_TAGS.join(", ")}]; got [${matches.join(", ")}]`,
    );
  }
});

test("easy slice: every task is tagged 'easy' alongside its skill", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    assert.ok(task.tags.includes("easy"), `${task.id}: missing "easy" tag`);
  }
});

test("easy slice: every goal has <= 120 words", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    const n = wordCount(task.goal);
    assert.ok(n <= 120, `${task.id}: goal has ${n} words (limit is 120)`);
  }
});

test("easy slice: each id is unique and prefixed with easy-", async () => {
  const tasks = await easyTasks();
  const ids = new Set<string>();
  for (const task of tasks) {
    assert.ok(task.id.startsWith("easy-"), `${task.id}: id must be prefixed with "easy-"`);
    assert.ok(!ids.has(task.id), `${task.id}: duplicate id`);
    ids.add(task.id);
  }
});

test("easy slice: start_url is a public http(s) URL", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    assert.match(
      task.start_url,
      /^https?:\/\//,
      `${task.id}: start_url must be a public http(s) URL; got ${task.start_url}`,
    );
    // No fixtures:// or file:// in easy slice.
    assert.doesNotMatch(
      task.start_url,
      /^fixtures:\/\//,
      `${task.id}: easy slice must not depend on local fixtures`,
    );
  }
});

test("easy slice: verifier kind is programmatic (no llm_judge)", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    assert.ok(
      task.verifier.kind === "js" || task.verifier.kind === "trajectory_predicate",
      `${task.id}: easy slice must use a programmatic verifier; got ${task.verifier.kind}`,
    );
  }
});

test("easy slice: covers at least 10 distinct hostnames", async () => {
  const tasks = await easyTasks();
  const hosts = new Set(tasks.map((t) => hostOf(t.start_url)).filter(Boolean));
  assert.ok(
    hosts.size >= 10,
    `expected >= 10 distinct hosts, got ${hosts.size} (${Array.from(hosts).sort().join(", ")})`,
  );
});

test("easy slice: each of the four skill tags appears at least once", async () => {
  const tasks = await easyTasks();
  for (const skill of SKILL_TAGS) {
    const n = tasks.filter((t) => t.tags.includes(skill)).length;
    assert.ok(n >= 1, `easy slice has no task tagged "${skill}"`);
  }
});
