// US-029: validate the easy slice v2 YAML files meet the contract:
//   - exactly 22 tasks
//   - difficulty=easy
//   - exactly one of {search, navigate, extract, fill} skill tags
//   - goal length <= 120 words
//   - public start_url (no fixtures://, no auth-required hosts)
//   - verifier kind in {js, trajectory_predicate} — no llm_judge in easy
//   - at least 10 distinct hostnames across the slice
//   - exactly one canary or interactive marker per task
//   - <= 8 extraction canaries (canary tag + extract skill)
//   - >= 14 interactive tasks (interactive tag + non-extract skill)
//   - interactive tasks' js verifier expressions reference document.location
//     and use a case-insensitive regex (mirrors hard-real invariant; ensures
//     cross-page navigation or hash change was actually observed)
//   - each task carries a unique pattern:<id> tag (no two tasks share the
//     same fixture pattern)
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

function patternTagOf(task: Task): string | null {
  const patterns = task.tags.filter((t) => t.startsWith("pattern:"));
  return patterns.length === 1 ? patterns[0]! : null;
}

let cached: Task[] | null = null;
async function easyTasks(): Promise<Task[]> {
  if (cached) return cached;
  cached = await loadSliceTasks("easy", resolve(process.cwd()));
  return cached;
}

test("easy slice v2: exactly 22 tasks", async () => {
  const tasks = await easyTasks();
  assert.equal(tasks.length, 22, `expected exactly 22 easy tasks, got ${tasks.length}`);
});

test("easy slice v2: every task has difficulty=easy", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    assert.equal(task.difficulty, "easy", `${task.id}: difficulty must be "easy"`);
  }
});

test("easy slice v2: every task has exactly one skill tag", async () => {
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

test("easy slice v2: every task is tagged 'easy' alongside its skill", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    assert.ok(task.tags.includes("easy"), `${task.id}: missing "easy" tag`);
  }
});

test("easy slice v2: every goal has <= 120 words", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    const n = wordCount(task.goal);
    assert.ok(n <= 120, `${task.id}: goal has ${n} words (limit is 120)`);
  }
});

test("easy slice v2: each id is unique and prefixed with easy-", async () => {
  const tasks = await easyTasks();
  const ids = new Set<string>();
  for (const task of tasks) {
    assert.ok(task.id.startsWith("easy-"), `${task.id}: id must be prefixed with "easy-"`);
    assert.ok(!ids.has(task.id), `${task.id}: duplicate id`);
    ids.add(task.id);
  }
});

test("easy slice v2: start_url is a public http(s) URL", async () => {
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

test("easy slice v2: verifier kind is programmatic (no llm_judge)", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    assert.ok(
      task.verifier.kind === "js" || task.verifier.kind === "trajectory_predicate",
      `${task.id}: easy slice must use a programmatic verifier; got ${task.verifier.kind}`,
    );
  }
});

test("easy slice v2: covers at least 10 distinct hostnames", async () => {
  const tasks = await easyTasks();
  const hosts = new Set(tasks.map((t) => hostOf(t.start_url)).filter(Boolean));
  assert.ok(
    hosts.size >= 10,
    `expected >= 10 distinct hosts, got ${hosts.size} (${Array.from(hosts).sort().join(", ")})`,
  );
});

test("easy slice v2: each of the four skill tags appears at least once", async () => {
  const tasks = await easyTasks();
  for (const skill of SKILL_TAGS) {
    const n = tasks.filter((t) => t.tags.includes(skill)).length;
    assert.ok(n >= 1, `easy slice has no task tagged "${skill}"`);
  }
});

test("easy slice v2: every task is marked exactly one of {canary, interactive}", async () => {
  const tasks = await easyTasks();
  for (const task of tasks) {
    const isCanary = task.tags.includes("canary");
    const isInteractive = task.tags.includes("interactive");
    assert.ok(
      isCanary !== isInteractive,
      `${task.id}: expected exactly one of {canary, interactive}; got canary=${isCanary} interactive=${isInteractive}`,
    );
  }
});

test("easy slice v2: <= 8 extraction canaries (AC #1)", async () => {
  const tasks = await easyTasks();
  const canaries = tasks.filter((t) => t.tags.includes("canary"));
  for (const task of canaries) {
    assert.ok(
      task.tags.includes("extract"),
      `${task.id}: canary tasks must have skill tag "extract"`,
    );
  }
  assert.ok(
    canaries.length <= 8,
    `expected <= 8 canary tasks, got ${canaries.length}`,
  );
});

test("easy slice v2: >= 14 interactive tasks (AC #1)", async () => {
  const tasks = await easyTasks();
  const interactive = tasks.filter((t) => t.tags.includes("interactive"));
  for (const task of interactive) {
    const skills = skillTagsOf(task);
    assert.notEqual(
      skills[0],
      "extract",
      `${task.id}: interactive tasks must not have skill tag "extract" (extraction is for canaries)`,
    );
  }
  assert.ok(
    interactive.length >= 14,
    `expected >= 14 interactive tasks, got ${interactive.length}`,
  );
});

test("easy slice v2: interactive js verifiers check document.location and use /.../i regex (AC #1: cross-page nav required)", async () => {
  const tasks = await easyTasks();
  const interactive = tasks.filter((t) => t.tags.includes("interactive"));
  for (const task of interactive) {
    if (task.verifier.kind !== "js") continue;
    const expr = task.verifier.expression;
    assert.match(
      expr,
      /document\.location/,
      `${task.id}: interactive verifier should check document.location (URL changed → cross-page nav or hash change)`,
    );
    assert.match(
      expr,
      /\/[^/]+\/i/,
      `${task.id}: interactive verifier should use a case-insensitive regex (/.../i) so minor copy edits do not break it`,
    );
  }
});

test("easy slice v2: each task carries exactly one pattern:* tag and pattern values are unique (AC #2)", async () => {
  const tasks = await easyTasks();
  const seen = new Set<string>();
  for (const task of tasks) {
    const p = patternTagOf(task);
    assert.ok(
      p,
      `${task.id}: expected exactly one pattern:* tag (e.g. "pattern:wiki_search_box")`,
    );
    assert.ok(
      !seen.has(p),
      `${task.id}: pattern tag "${p}" duplicates another task's pattern (AC: no fixture-pattern twice)`,
    );
    seen.add(p);
  }
});
