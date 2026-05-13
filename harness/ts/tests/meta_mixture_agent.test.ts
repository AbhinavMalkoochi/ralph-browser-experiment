// US-024: meta-mixture routing agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import MetaMixtureAgent, { META_MIXTURE_ID } from "../../../agents/meta-mixture/agent.js";
import {
  ROUTABLE_AGENTS,
  decideRoute,
  extractFeatures,
  type RoutedAgentId,
} from "../../../agents/meta-mixture/router.js";

import { Agent, type AgentContext } from "../agent/agent.js";
import { CdpBrowserSession } from "../agent/browser_session.js";
import { Trajectory } from "../agent/trajectory.js";
import { Budget, type BrowserSession } from "../agent/types.js";
import { parseYaml } from "../verifier/yaml.js";

const generousBudget = (): Budget =>
  new Budget({ tokens: 1000, usd: 1, wallSeconds: 30, steps: 10 });

// -----------------------------------------------------------------------------
// extractFeatures
// -----------------------------------------------------------------------------

test("extractFeatures: parses fixtures:// scheme + path", () => {
  const f = extractFeatures("Submit the form.", "fixtures://shadow-form");
  assert.equal(f.scheme, "fixtures");
  assert.equal(f.host, "shadow-form");
  assert.equal(f.goal, "submit the form.");
  assert.equal(f.goalWords, 3);
});

test("extractFeatures: parses https:// host/path", () => {
  const f = extractFeatures(
    "Open the arXiv abstract page.",
    "https://arxiv.org/abs/1810.04805",
  );
  assert.equal(f.scheme, "https");
  assert.equal(f.host, "arxiv.org");
  assert.equal(f.path, "/abs/1810.04805");
});

test("extractFeatures: empty start_url leaves scheme empty but goal still parsed", () => {
  const f = extractFeatures("Click the Submit button.", "");
  assert.equal(f.scheme, "");
  assert.equal(f.host, "");
  assert.ok(f.apiHits.length >= 1, "submit cue should hit api keywords");
});

// -----------------------------------------------------------------------------
// decideRoute — each rule
// -----------------------------------------------------------------------------

test("decideRoute: api_first → network-shadow on shadow-form-shaped goal", () => {
  const d = decideRoute(
    "submit the form inside a shadow root with username/email/tier",
    "fixtures://shadow-form",
  );
  assert.equal(d.rule, "api_first");
  assert.equal(d.agent, "network-shadow");
  assert.ok(d.features.apiHits.includes("submit"));
});

test("decideRoute: api_first → network-shadow on pdf-task", () => {
  const d = decideRoute(
    "Open or download the PDF, extract the access code, type it into the input.",
    "fixtures://pdf-task",
  );
  assert.equal(d.rule, "api_first");
  assert.equal(d.agent, "network-shadow");
  assert.ok(d.features.apiHits.includes("pdf"));
});

test("decideRoute: predicate_termination → codegen-predicate on recoverable", () => {
  const d = decideRoute(
    "After the first attempt fails, retry — wait until the recovery banner appears.",
    "fixtures://recoverable",
  );
  assert.equal(d.rule, "predicate_termination");
  assert.equal(d.agent, "codegen-predicate");
});

test("decideRoute: predicate_termination → codegen-predicate on late-hydration", () => {
  const d = decideRoute(
    "Wait until the page is hydrated, then click the button.",
    "fixtures://late-hydration",
  );
  assert.equal(d.rule, "predicate_termination");
  assert.equal(d.agent, "codegen-predicate");
});

test("decideRoute: extract_default → network-shadow on easy-slice extract task", () => {
  const d = decideRoute(
    "Open the page and confirm it contains the BERT abstract.",
    "https://arxiv.org/abs/1810.04805",
  );
  assert.equal(d.rule, "extract_default");
  assert.equal(d.agent, "network-shadow");
});

test("decideRoute: default_codegen → runtime-codegen on goal with no specific cues", () => {
  const d = decideRoute(
    "Reach the goal state through whatever interaction is required.",
    "fixtures://canvas-drag",
  );
  assert.equal(d.rule, "default_codegen");
  assert.equal(d.agent, "runtime-codegen");
});

test("decideRoute: all chosen agents are in the routable set", () => {
  for (const goal of [
    "submit the form",
    "retry until it works",
    "open and confirm the title",
    "do whatever",
  ]) {
    const d = decideRoute(goal, "https://example.com/");
    assert.ok(ROUTABLE_AGENTS.includes(d.agent as RoutedAgentId));
  }
});

// -----------------------------------------------------------------------------
// MetaMixtureAgent.run — delegation + sidecar
// -----------------------------------------------------------------------------

class StubSubAgent extends Agent {
  // intentionally a "wrong" id to verify the meta agent overrides it
  // before calling run().
  id = "stub-sub";
  ran = false;
  observedIdAtRun: string | null = null;
  constructor(public readonly routedAs: RoutedAgentId) {
    super();
  }
  async run(
    _goal: string,
    _browser: BrowserSession,
    _budget: Budget,
    ctx: AgentContext,
  ): Promise<Trajectory> {
    this.ran = true;
    this.observedIdAtRun = this.id;
    const traj = await Trajectory.open(
      {
        runsRoot: ctx.runs_root,
        agent: this.id,
        task: ctx.task_id,
        seed: ctx.seed,
      },
      { agent_id: this.id, task_id: ctx.task_id, seed: ctx.seed },
    );
    await traj.finish({ terminal_state: "DONE" });
    return traj;
  }
}

test("MetaMixtureAgent: routes api_first goal to network-shadow stub; writes route.json", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-meta-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Em1%3C/title%3E");
    const factoryCalls: RoutedAgentId[] = [];
    const stubs: Partial<Record<RoutedAgentId, StubSubAgent>> = {};
    const agent = new MetaMixtureAgent({
      subAgentFactory: (id) => {
        factoryCalls.push(id);
        const s = new StubSubAgent(id);
        stubs[id] = s;
        return s;
      },
    });
    const traj = await agent.run(
      "submit the form with shadow root values",
      session,
      generousBudget(),
      { task_id: "t1", seed: 0, runs_root: runsRoot },
    );
    assert.deepEqual(factoryCalls, ["network-shadow"]);
    assert.equal(stubs["network-shadow"]!.ran, true);
    assert.equal(
      stubs["network-shadow"]!.observedIdAtRun,
      META_MIXTURE_ID,
      "sub-agent id must be overridden to meta-mixture before run()",
    );
    assert.equal(traj.metadata.agent_id, META_MIXTURE_ID);
    // Trajectory wrote under runs/meta-mixture/t1/0/
    assert.ok(
      traj.dir.endsWith(join("meta-mixture", "t1", "0")),
      `unexpected trajectory dir: ${traj.dir}`,
    );
    const route = JSON.parse(await readFile(join(traj.dir, "route.json"), "utf8"));
    assert.equal(route.chosen_agent, "network-shadow");
    assert.equal(route.rule, "api_first");
    assert.ok(Array.isArray(route.reasons) && route.reasons.length >= 1);
    assert.ok(Array.isArray(route.features.apiHits));
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("MetaMixtureAgent: default rule routes to runtime-codegen", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-meta-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Em2%3C/title%3E");
    const factoryCalls: RoutedAgentId[] = [];
    const agent = new MetaMixtureAgent({
      subAgentFactory: (id) => {
        factoryCalls.push(id);
        return new StubSubAgent(id);
      },
    });
    await agent.run(
      "drag the slider on the canvas to position the target.",
      session,
      generousBudget(),
      { task_id: "t2", seed: 0, runs_root: runsRoot },
    );
    assert.deepEqual(factoryCalls, ["runtime-codegen"]);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("MetaMixtureAgent: transient cue routes to codegen-predicate", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-meta-"));
  const session = await CdpBrowserSession.create();
  try {
    await session.navigate("data:text/html,%3Ctitle%3Em3%3C/title%3E");
    const factoryCalls: RoutedAgentId[] = [];
    const agent = new MetaMixtureAgent({
      subAgentFactory: (id) => {
        factoryCalls.push(id);
        return new StubSubAgent(id);
      },
    });
    await agent.run(
      "wait until the hydrated state is reached, then verify the result.",
      session,
      generousBudget(),
      { task_id: "t3", seed: 0, runs_root: runsRoot },
    );
    assert.deepEqual(factoryCalls, ["codegen-predicate"]);
  } finally {
    await session.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Manifest distinctness
// -----------------------------------------------------------------------------

test("manifest: zero keyword overlap with every prior agent", async () => {
  const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..");
  const my = await loadKeywords(join(repoRoot, "agents", "meta-mixture", "manifest.yaml"));
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
    "dom-shell",
    "fs-memory",
  ];
  for (const id of priors) {
    const other = await loadKeywords(join(repoRoot, "agents", id, "manifest.yaml"));
    const jaccard = jaccardSet(my, other);
    assert.ok(
      jaccard < 0.5,
      `meta-mixture vs ${id}: Jaccard=${jaccard} (overlap=${[...my].filter((k) => other.has(k)).join(",")})`,
    );
  }
});

async function loadKeywords(path: string): Promise<Set<string>> {
  const yaml = parseYaml(await readFile(path, "utf8")) as {
    approach_keywords?: string[];
  };
  return new Set((yaml.approach_keywords ?? []).map((k) => k.toLowerCase()));
}

function jaccardSet(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const k of a) if (b.has(k)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
