// US-010: agent auto-discovery scans agents/<id>/, validates manifest.yaml,
// and skips invalid entries with a warning rather than aborting.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAgents, validateManifest } from "../tournament/discovery.js";

async function makeFakeAgentsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gba-discover-"));
  const agents = join(root, "agents");
  await mkdir(agents, { recursive: true });
  return agents;
}

test("discoverAgents: finds the live click-first-link[+_py] agents in this repo", async () => {
  const agents = await discoverAgents();
  const ids = agents.map((a) => a.id).sort();
  assert.ok(ids.includes("click-first-link"), `expected click-first-link in ${ids.join(",")}`);
  assert.ok(ids.includes("click-first-link-py"), `expected click-first-link-py in ${ids.join(",")}`);
  for (const a of agents) {
    assert.ok(a.dir.endsWith(a.id));
    assert.ok(a.agentFile.endsWith(a.language === "typescript" ? "agent.ts" : "agent.py"));
    assert.equal(a.manifest.id, a.id);
    assert.ok(Array.isArray(a.manifest.approach_keywords));
    assert.ok(Array.isArray(a.manifest.distinct_from));
  }
});

test("discoverAgents: filterIds excludes non-matching agents", async () => {
  const agents = await discoverAgents({ filterIds: ["click-first-link"] });
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.id, "click-first-link");
});

test("discoverAgents: skips dir with missing manifest, surfaces warning, continues", async () => {
  const agentsDir = await makeFakeAgentsDir();
  // Valid TS agent
  const goodDir = join(agentsDir, "good");
  await mkdir(goodDir, { recursive: true });
  await writeFile(
    join(goodDir, "manifest.yaml"),
    "id: good\nlanguage: typescript\nsummary: ok\napproach_keywords:\n  - test\ndistinct_from: []\n",
  );
  await writeFile(join(goodDir, "agent.ts"), "export default class {}");
  // Dir without manifest.yaml
  await mkdir(join(agentsDir, "no-manifest"), { recursive: true });
  await writeFile(join(agentsDir, "no-manifest", "agent.ts"), "export default class {}");
  // Dir with broken yaml
  const badDir = join(agentsDir, "broken");
  await mkdir(badDir, { recursive: true });
  await writeFile(join(badDir, "manifest.yaml"), "this is :: not valid\n  : yaml\n");
  await writeFile(join(badDir, "agent.ts"), "export default class {}");

  const warnings: string[] = [];
  const found = await discoverAgents({
    repoRoot: "/never-used",
    agentsDir,
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "good");
  // The broken/no-manifest dirs may emit warnings; broken definitely should.
  assert.ok(warnings.some((w) => /broken/.test(w)), `expected warning for broken: ${warnings.join("|")}`);
});

test("discoverAgents: rejects manifest where language doesn't match the present file", async () => {
  const agentsDir = await makeFakeAgentsDir();
  const dir = join(agentsDir, "mismatch");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.yaml"),
    "id: mismatch\nlanguage: python\nsummary: x\napproach_keywords: []\ndistinct_from: []\n",
  );
  // No agent.py file present.
  await writeFile(join(dir, "agent.ts"), "export default class {}");
  const warnings: string[] = [];
  const found = await discoverAgents({ agentsDir, onWarn: (m) => warnings.push(m) });
  assert.equal(found.length, 0);
  assert.ok(warnings.some((w) => /mismatch/.test(w) && /agent\.py/.test(w)));
});

test("validateManifest: requires id, language in {typescript,python}, summary", () => {
  assert.throws(() => validateManifest({}), /missing or empty "id"/);
  assert.throws(
    () => validateManifest({ id: "x", language: "rust", summary: "y" }),
    /language must be typescript\|python/,
  );
  assert.throws(
    () => validateManifest({ id: "x", language: "typescript" }),
    /missing or empty "summary"/,
  );
  const m = validateManifest({
    id: "x",
    language: "typescript",
    summary: "ok",
    approach_keywords: ["a", "b"],
    distinct_from: ["other"],
  });
  assert.equal(m.id, "x");
  assert.equal(m.language, "typescript");
  assert.deepEqual(m.approach_keywords, ["a", "b"]);
  assert.deepEqual(m.distinct_from, ["other"]);
});

test("validateManifest: rejects non-string entries in approach_keywords", () => {
  assert.throws(
    () =>
      validateManifest({
        id: "x",
        language: "typescript",
        summary: "ok",
        approach_keywords: ["a", 1],
      }),
    /every "approach_keywords" entry must be a string/,
  );
});
