// US-012: distinctness enforcement.
//
// validateDistinctness flags agents whose manifest.distinct_from claim
// fails because their approach_keywords overlap >50% (Jaccard) with the
// claimed-distinct agent. Discovery uses this to drop violators with a
// warning rather than letting the tournament run with an untruthfully
// labelled agent.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DISTINCTNESS_THRESHOLD,
  formatDistinctnessWarning,
  jaccardOverlap,
  validateDistinctness,
} from "../tournament/distinctness.js";
import { discoverAgents } from "../tournament/discovery.js";
import type { DiscoveredAgent } from "../tournament/types.js";

function fakeAgent(id: string, approach_keywords: string[], distinct_from: string[] = []): DiscoveredAgent {
  return {
    id,
    language: "typescript",
    dir: `/tmp/${id}`,
    agentFile: `/tmp/${id}/agent.ts`,
    manifest: {
      id,
      language: "typescript",
      summary: "fake",
      approach_keywords,
      distinct_from,
    },
  };
}

test("DISTINCTNESS_THRESHOLD is 0.5 (matches PRD '>50% overlap')", () => {
  assert.equal(DISTINCTNESS_THRESHOLD, 0.5);
});

test("jaccardOverlap: identical sets", () => {
  assert.equal(jaccardOverlap(["a", "b", "c"], ["a", "b", "c"]), 1);
});

test("jaccardOverlap: disjoint sets", () => {
  assert.equal(jaccardOverlap(["a", "b"], ["c", "d"]), 0);
});

test("jaccardOverlap: partial overlap is intersection / union", () => {
  // {a,b} vs {a,c,d} => intersection 1, union 4 => 0.25
  assert.equal(jaccardOverlap(["a", "b"], ["a", "c", "d"]), 1 / 4);
});

test("jaccardOverlap: empty list => 0", () => {
  assert.equal(jaccardOverlap([], ["a"]), 0);
  assert.equal(jaccardOverlap(["a"], []), 0);
  assert.equal(jaccardOverlap([], []), 0);
});

test("jaccardOverlap: case-insensitive", () => {
  assert.equal(jaccardOverlap(["ReAct"], ["react"]), 1);
});

test("jaccardOverlap: deduplicates inputs (set semantics)", () => {
  // ["a","a"] === {a}; ["a"] === {a}; intersection 1, union 1 => 1
  assert.equal(jaccardOverlap(["a", "a"], ["a"]), 1);
});

test("validateDistinctness: no claim => no issues", () => {
  const agents = [fakeAgent("a", ["x", "y"]), fakeAgent("b", ["x", "y"])];
  assert.deepEqual(validateDistinctness(agents), []);
});

test("validateDistinctness: claim with low overlap passes", () => {
  // a says distinct_from=[b]; jaccard({x,y}, {p,q,r}) = 0/5 = 0
  const agents = [
    fakeAgent("a", ["x", "y"], ["b"]),
    fakeAgent("b", ["p", "q", "r"]),
  ];
  assert.deepEqual(validateDistinctness(agents), []);
});

test("validateDistinctness: claim with high overlap fails", () => {
  // a's keywords {x,y}, b's keywords {x,y,z}; Jaccard = 2/3 ≈ 0.67 > 0.5
  const agents = [
    fakeAgent("a", ["x", "y"], ["b"]),
    fakeAgent("b", ["x", "y", "z"]),
  ];
  const issues = validateDistinctness(agents);
  assert.equal(issues.length, 1);
  const issue = issues[0]!;
  assert.equal(issue.agent_id, "a");
  assert.equal(issue.conflicts_with, "b");
  assert.ok(issue.overlap > 0.5);
  assert.deepEqual(issue.shared_keywords.sort(), ["x", "y"]);
});

test("validateDistinctness: 50% boundary does NOT trigger (strictly >0.5)", () => {
  // a={x,y}, b={x,z}; intersection 1, union 3 -> 0.33
  // Need overlap >0.5 boundary case: a={x,y,z}, b={x,y,w}; intersection 2, union 4 = 0.5 (not >)
  const agents = [
    fakeAgent("a", ["x", "y", "z"], ["b"]),
    fakeAgent("b", ["x", "y", "w"]),
  ];
  assert.deepEqual(validateDistinctness(agents), []);
});

test("validateDistinctness: distinct_from referencing unknown agent is ignored", () => {
  const agents = [fakeAgent("a", ["x", "y", "z"], ["nope"])];
  assert.deepEqual(validateDistinctness(agents), []);
});

test("validateDistinctness: self-reference is ignored", () => {
  const agents = [fakeAgent("a", ["x", "y"], ["a"])];
  assert.deepEqual(validateDistinctness(agents), []);
});

test("validateDistinctness: a single agent violating against multiple targets emits one issue per target", () => {
  const agents = [
    fakeAgent("a", ["x", "y", "z"], ["b", "c"]),
    fakeAgent("b", ["x", "y"]),
    fakeAgent("c", ["x", "y", "z"]),
  ];
  const issues = validateDistinctness(agents);
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((i) => i.conflicts_with).sort(),
    ["b", "c"],
  );
});

test("validateDistinctness: custom threshold", () => {
  // Jaccard = 1/4 = 0.25 — passes default 0.5 but fails threshold 0.2
  const agents = [
    fakeAgent("a", ["x", "y"], ["b"]),
    fakeAgent("b", ["x", "p", "q"]),
  ];
  assert.deepEqual(validateDistinctness(agents), []);
  const issues = validateDistinctness(agents, { threshold: 0.2 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.conflicts_with, "b");
});

test("formatDistinctnessWarning: contains agent ids, percentage, shared keywords", () => {
  const issue = {
    agent_id: "a",
    conflicts_with: "b",
    overlap: 2 / 3,
    threshold: 0.5,
    shared_keywords: ["x", "y"],
  };
  const msg = formatDistinctnessWarning(issue);
  assert.match(msg, /agents\/a/);
  assert.match(msg, /distinct_from=\[b\]/);
  assert.match(msg, /67%/);
  assert.match(msg, /50%/);
  assert.match(msg, /shared=x,y/);
});

async function makeFakeAgentsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gba-distinct-"));
  const agents = join(root, "agents");
  await mkdir(agents, { recursive: true });
  return agents;
}

async function writeAgentDir(
  agentsDir: string,
  id: string,
  approach_keywords: string[],
  distinct_from: string[],
): Promise<void> {
  const dir = join(agentsDir, id);
  await mkdir(dir, { recursive: true });
  const yaml = [
    `id: ${id}`,
    `language: typescript`,
    `summary: |`,
    `  fake agent ${id}`,
    `approach_keywords:`,
    ...approach_keywords.map((k) => `  - ${k}`),
    `distinct_from:`,
    ...distinct_from.map((k) => `  - ${k}`),
    "",
  ].join("\n");
  await writeFile(join(dir, "manifest.yaml"), yaml);
  await writeFile(join(dir, "agent.ts"), "export default class {}\n");
}

test("discoverAgents: drops agents whose distinct_from claim fails (>50% overlap), surfaces warning", async () => {
  const agentsDir = await makeFakeAgentsDir();
  await writeAgentDir(agentsDir, "alpha", ["x", "y"], ["beta"]);
  await writeAgentDir(agentsDir, "beta", ["x", "y", "z"], []);
  const warnings: string[] = [];
  const found = await discoverAgents({
    agentsDir,
    onWarn: (m) => warnings.push(m),
  });
  const ids = found.map((a) => a.id).sort();
  assert.deepEqual(ids, ["beta"]);
  assert.ok(
    warnings.some((w) => /distinctness violation/.test(w) && /alpha/.test(w)),
    `expected distinctness warning for alpha; got: ${warnings.join(" | ")}`,
  );
});

test("discoverAgents: enforceDistinctness=false keeps violators", async () => {
  const agentsDir = await makeFakeAgentsDir();
  await writeAgentDir(agentsDir, "alpha", ["x", "y"], ["beta"]);
  await writeAgentDir(agentsDir, "beta", ["x", "y", "z"], []);
  const warnings: string[] = [];
  const found = await discoverAgents({
    agentsDir,
    enforceDistinctness: false,
    onWarn: (m) => warnings.push(m),
  });
  const ids = found.map((a) => a.id).sort();
  assert.deepEqual(ids, ["alpha", "beta"]);
  // No distinctness warning should have been emitted.
  assert.ok(!warnings.some((w) => /distinctness violation/.test(w)));
});

test("discoverAgents: low-overlap distinct_from claim is allowed", async () => {
  const agentsDir = await makeFakeAgentsDir();
  await writeAgentDir(agentsDir, "alpha", ["a", "b"], ["beta"]);
  await writeAgentDir(agentsDir, "beta", ["x", "y", "z"], []);
  const warnings: string[] = [];
  const found = await discoverAgents({
    agentsDir,
    onWarn: (m) => warnings.push(m),
  });
  assert.deepEqual(found.map((a) => a.id).sort(), ["alpha", "beta"]);
  assert.ok(!warnings.some((w) => /distinctness violation/.test(w)));
});

test("live agents pass distinctness (sanity)", async () => {
  // The live click-first-link[+_py] reference agents have distinct_from=[]
  // so they cannot violate. This test catches accidental edits to either
  // manifest that would introduce a self-conflict.
  const agents = await discoverAgents({ enforceDistinctness: false });
  const issues = validateDistinctness(agents);
  assert.deepEqual(issues, [], `live agents have distinctness issues: ${JSON.stringify(issues)}`);
});
