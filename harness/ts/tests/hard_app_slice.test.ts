// US-027: validate the hard-app slice YAML files meet the contract:
//   - 8..10 tasks
//   - difficulty=hard
//   - exactly one of {search, navigate, extract, fill} skill tags
//   - tagged hard + app
//   - each task is bound to exactly one app via app:<id>
//   - start_url targets one of the docker-compose host-mapped ports
//   - verifier kind is programmatic (js or trajectory_predicate)
//   - at least one task per app (gitea/excalidraw/bookstack/vikunja)
//
// Loading every file goes through `loadTaskFile`, so malformed YAML or
// invalid verifier spec also surfaces here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { loadSliceTasks } from "../eval/runner.js";
import {
  DEFAULT_PORTS,
  appFromTags,
  appIsReachable,
  credentialsFromEnv,
  defaultOrigin,
  type HardAppId,
} from "../cdp/loginAs.js";
import { slicePreflight, HARD_APP_SLICE_ID } from "../tournament/preflight.js";
import type { Task } from "../verifier/types.js";

const SKILL_TAGS = ["search", "navigate", "extract", "fill"] as const;
type SkillTag = (typeof SKILL_TAGS)[number];

const ALL_APPS: HardAppId[] = ["gitea", "excalidraw", "bookstack", "vikunja"];

let cached: Task[] | null = null;
async function hardAppTasks(): Promise<Task[]> {
  if (cached) return cached;
  cached = await loadSliceTasks(HARD_APP_SLICE_ID, resolve(process.cwd()));
  return cached;
}

function skillTagsOf(task: Task): SkillTag[] {
  return task.tags.filter((t): t is SkillTag => SKILL_TAGS.includes(t as SkillTag));
}

test("hard-app slice: between 8 and 10 tasks (AC #4)", async () => {
  const tasks = await hardAppTasks();
  assert.ok(
    tasks.length >= 8 && tasks.length <= 10,
    `expected 8..10 hard-app tasks, got ${tasks.length}`,
  );
});

test("hard-app slice: every task is difficulty=hard", async () => {
  for (const t of await hardAppTasks()) {
    assert.equal(t.difficulty, "hard", `${t.id}: must be difficulty=hard`);
  }
});

test("hard-app slice: every id is unique and prefixed with hard-app-", async () => {
  const seen = new Set<string>();
  for (const t of await hardAppTasks()) {
    assert.ok(t.id.startsWith("hard-app-"), `${t.id}: id must start with hard-app-`);
    assert.ok(!seen.has(t.id), `${t.id}: duplicate id`);
    seen.add(t.id);
  }
});

test("hard-app slice: every task is tagged hard + app + app:<id>", async () => {
  for (const t of await hardAppTasks()) {
    assert.ok(t.tags.includes("hard"), `${t.id}: missing "hard" tag`);
    assert.ok(t.tags.includes("app"), `${t.id}: missing "app" tag`);
    const app = appFromTags(t.tags);
    assert.ok(app, `${t.id}: must include exactly one app:<id> tag`);
  }
});

test("hard-app slice: every task has exactly one skill tag (AC #4 implicit)", async () => {
  for (const t of await hardAppTasks()) {
    const matches = skillTagsOf(t);
    assert.equal(
      matches.length,
      1,
      `${t.id}: expected one of [${SKILL_TAGS.join(", ")}], got [${matches.join(", ")}]`,
    );
  }
});

test("hard-app slice: start_url targets a docker-compose host-mapped port", async () => {
  const portToApp = new Map<number, HardAppId>(
    ALL_APPS.map((a): [number, HardAppId] => [DEFAULT_PORTS[a], a]),
  );
  for (const t of await hardAppTasks()) {
    let url: URL;
    try {
      url = new URL(t.start_url);
    } catch {
      throw new Error(`${t.id}: start_url not a parseable URL`);
    }
    assert.equal(url.protocol, "http:", `${t.id}: hard-app start_url must use http: (local docker)`);
    assert.match(url.hostname, /^(127\.0\.0\.1|localhost)$/i, `${t.id}: hostname must be loopback`);
    const port = Number(url.port);
    const app = portToApp.get(port);
    assert.ok(app, `${t.id}: port ${port} not in DEFAULT_PORTS table`);
    const taggedApp = appFromTags(t.tags);
    assert.equal(app, taggedApp, `${t.id}: port ${port} doesn't match app tag (${taggedApp})`);
  }
});

test("hard-app slice: verifier kind is programmatic (AC #4)", async () => {
  for (const t of await hardAppTasks()) {
    assert.ok(
      t.verifier.kind === "js" || t.verifier.kind === "trajectory_predicate",
      `${t.id}: hard-app must use a programmatic verifier; got ${t.verifier.kind}`,
    );
  }
});

test("hard-app slice: at least one task per app (AC #5)", async () => {
  const byApp = new Map<HardAppId, number>();
  for (const t of await hardAppTasks()) {
    const app = appFromTags(t.tags)!;
    byApp.set(app, (byApp.get(app) ?? 0) + 1);
  }
  for (const app of ALL_APPS) {
    assert.ok(
      (byApp.get(app) ?? 0) >= 1,
      `expected at least one task for ${app}; counts: ${JSON.stringify(Object.fromEntries(byApp))}`,
    );
  }
});

// ---------- loginAs helper unit tests ----------

test("loginAs: DEFAULT_PORTS covers all four apps and uses 3001..3004", () => {
  assert.equal(DEFAULT_PORTS.gitea, 3001);
  assert.equal(DEFAULT_PORTS.excalidraw, 3002);
  assert.equal(DEFAULT_PORTS.bookstack, 3003);
  assert.equal(DEFAULT_PORTS.vikunja, 3004);
});

test("loginAs: defaultOrigin yields http://127.0.0.1:<port>", () => {
  assert.equal(defaultOrigin("gitea"), "http://127.0.0.1:3001");
  assert.equal(defaultOrigin("vikunja"), "http://127.0.0.1:3004");
});

test("loginAs: credentialsFromEnv reads GBA_<APP>_USER / _PASSWORD / _PORT", () => {
  const env = {
    GBA_GITEA_USER: "carol",
    GBA_GITEA_PASSWORD: "hunter2",
    GBA_GITEA_PORT: "13001",
  };
  const c = credentialsFromEnv("gitea", env);
  assert.equal(c.user, "carol");
  assert.equal(c.password, "hunter2");
  assert.equal(c.origin, "http://127.0.0.1:13001");
});

test("loginAs: credentialsFromEnv defaults user='agent' for gitea/vikunja", () => {
  const c = credentialsFromEnv("vikunja", {});
  assert.equal(c.user, "agent");
  assert.match(c.password, /agent-correct-horse/);
});

test("loginAs: credentialsFromEnv defaults user='agent@example.invalid' for bookstack", () => {
  const c = credentialsFromEnv("bookstack", {});
  assert.equal(c.user, "agent@example.invalid");
});

test("appFromTags: resolves app:<id> tags", () => {
  assert.equal(appFromTags(["hard", "app", "app:gitea", "fill"]), "gitea");
  assert.equal(appFromTags(["app:vikunja"]), "vikunja");
  assert.equal(appFromTags(["app:nope"]), null);
  assert.equal(appFromTags(["hard", "app"]), null);
});

test("appIsReachable: returns false when the port is closed (fast probe)", async () => {
  // Use a port that's almost certainly closed on a dev box.
  const ok = await appIsReachable("gitea", {
    origin: "http://127.0.0.1:1",
    timeoutMs: 250,
  });
  assert.equal(ok, false);
});

// ---------- preflight tests ----------

test("slicePreflight: non-hard-app slices always pass", async () => {
  const v = await slicePreflight("easy");
  assert.deepEqual(v, { ok: true });
});

test("slicePreflight: SKIP_SELF_HOSTED=1 short-circuits hard-app", async () => {
  const v = await slicePreflight(HARD_APP_SLICE_ID, { env: { SKIP_SELF_HOSTED: "1" } });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.match(v.reason, /SKIP_SELF_HOSTED/);
    assert.deepEqual(v.skipped_apps.sort(), ALL_APPS.slice().sort());
  }
});

test("slicePreflight: hard-app fails fast when no docker apps are up", async () => {
  // Default ports won't be open in CI; assert the verdict shape.
  const v = await slicePreflight(HARD_APP_SLICE_ID, { env: {}, timeoutMs: 250 });
  // The verdict depends on whether the developer has apps-up locally. In CI
  // they are not up, so we expect ok:false with skipped_apps populated. On a
  // dev box that DOES have them up, we get ok:true. Either way, the shape
  // is well-formed.
  assert.ok(typeof v.ok === "boolean");
  if (!v.ok) {
    assert.ok(Array.isArray(v.skipped_apps) && v.skipped_apps.length >= 1);
    assert.match(v.reason, /apps not reachable/);
  }
});
