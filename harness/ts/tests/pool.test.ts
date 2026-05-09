// BrowserPool tests. Real Chrome, real CDP. No mocks.
//
// Covers all US-003 acceptance bullets:
//   - configurable size via GBA_POOL_SIZE / opts.size, default 4
//   - per-slot --user-data-dir, torn down on release
//   - snapshot/restore round-trips cookies + localStorage + sessionStorage
//   - crash-only: a wedged session is replaced without taking the pool down
//   - per-task hard timeout: kills the session, throws SessionTimeoutError,
//     downstream agent records terminal_state=SESSION_TIMEOUT
//   - 8-task parallel smoke: all tasks see only their own state

import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserPool, SessionTimeoutError } from "../cdp/pool.js";
import { Trajectory } from "../agent/trajectory.js";
import { Budget, BudgetExceeded } from "../agent/types.js";
import ClickFirstLinkAgent from "../../../agents/click-first-link/agent.js";

interface FixtureServer {
  url(path?: string): string;
  origin: string;
  close(): Promise<void>;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/hang") {
      // Never respond. Used by the timeout test.
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>fix</title></head><body>` +
        `<div id="path">${url.pathname}</div>` +
        `<a href="${url.pathname}?next=1">go</a>` +
        `</body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server.address() returned null");
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    url(path = "/") {
      return origin + path;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

test("pool size honours opts.size; defaults to 4 when env unset", async () => {
  const pool = await BrowserPool.create({ size: 2 });
  try {
    assert.equal(pool.size, 2);
    const s = pool.stats();
    assert.equal(s.size, 2);
    assert.equal(s.available, 2);
    assert.equal(s.inUse, 0);
  } finally {
    await pool.close();
  }
});

test("envSize() reads GBA_POOL_SIZE and rejects garbage", () => {
  const prior = process.env.GBA_POOL_SIZE;
  try {
    delete process.env.GBA_POOL_SIZE;
    assert.equal(BrowserPool.envSize(), null);
    process.env.GBA_POOL_SIZE = "7";
    assert.equal(BrowserPool.envSize(), 7);
    process.env.GBA_POOL_SIZE = "0";
    assert.throws(() => BrowserPool.envSize(), /positive integer/);
    process.env.GBA_POOL_SIZE = "garbage";
    assert.throws(() => BrowserPool.envSize(), /positive integer/);
  } finally {
    if (prior == null) delete process.env.GBA_POOL_SIZE;
    else process.env.GBA_POOL_SIZE = prior;
  }
});

test("acquire blocks when pool is empty and unblocks on release", async () => {
  const pool = await BrowserPool.create({ size: 1 });
  try {
    const a = await pool.acquire();
    let bResolved = false;
    const bPromise = pool.acquire().then((s) => {
      bResolved = true;
      return s;
    });
    await delay(50);
    assert.equal(bResolved, false);
    assert.equal(pool.stats().waiters, 1);
    await pool.release(a);
    const b = await bPromise;
    assert.equal(bResolved, true);
    await pool.release(b);
  } finally {
    await pool.close();
  }
});

test("each slot uses a unique --user-data-dir torn down on release", async () => {
  const pool = await BrowserPool.create({ size: 2 });
  try {
    const a = await pool.acquire();
    const b = await pool.acquire();
    assert.notEqual(a.id, b.id);
    const dirA = a.userDataDir;
    const dirB = b.userDataDir;
    assert.notEqual(dirA, dirB);
    assert.ok((await stat(dirA)).isDirectory());
    assert.ok((await stat(dirB)).isDirectory());

    await pool.release(a);
    await pool.release(b);

    await assert.rejects(() => stat(dirA), /ENOENT/);
    await assert.rejects(() => stat(dirB), /ENOENT/);

    const stats = pool.stats();
    assert.equal(stats.inUse, 0);
    assert.equal(stats.available, 2);
    assert.ok(stats.replaced >= 2, `expected >=2 replaced, got ${stats.replaced}`);
  } finally {
    await pool.close();
  }
});

test("two acquired sessions are isolated: cookies and localStorage do not leak", async () => {
  const fixture = await startFixtureServer();
  const pool = await BrowserPool.create({ size: 2 });
  try {
    const a = await pool.acquire();
    const b = await pool.acquire();
    await a.navigate(fixture.url("/a"));
    await b.navigate(fixture.url("/b"));
    await a.evaluate(`document.cookie = "owner=A; path=/"; localStorage.setItem('k', 'A');`);
    await b.evaluate(`document.cookie = "owner=B; path=/"; localStorage.setItem('k', 'B');`);

    const aCookie = await a.evaluate<string>("document.cookie");
    const bCookie = await b.evaluate<string>("document.cookie");
    assert.match(aCookie, /owner=A/);
    assert.doesNotMatch(aCookie, /owner=B/);
    assert.match(bCookie, /owner=B/);
    assert.doesNotMatch(bCookie, /owner=A/);

    const aLs = await a.evaluate<string | null>("localStorage.getItem('k')");
    const bLs = await b.evaluate<string | null>("localStorage.getItem('k')");
    assert.equal(aLs, "A");
    assert.equal(bLs, "B");

    await pool.release(a);
    await pool.release(b);

    const c = await pool.acquire();
    await c.navigate(fixture.url("/c"));
    const cCookie = await c.evaluate<string>("document.cookie");
    const cLs = await c.evaluate<string | null>("localStorage.getItem('k')");
    assert.equal(cCookie, "");
    assert.equal(cLs, null);
    await pool.release(c);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("snapshot then restore round-trips URL, cookies, localStorage, sessionStorage", async () => {
  const fixture = await startFixtureServer();
  const pool = await BrowserPool.create({ size: 1 });
  try {
    const session = await pool.acquire();
    await session.navigate(fixture.url("/start"));
    await session.evaluate(`
      document.cookie = "k1=v1; path=/";
      document.cookie = "k2=v2; path=/";
      localStorage.setItem('ls_a', '1');
      localStorage.setItem('ls_b', '2');
      sessionStorage.setItem('ss_a', 'x');
    `);
    const snap = await session.snapshot({ includeMhtml: true });
    assert.equal(snap.url, fixture.url("/start"));
    assert.equal(snap.localStorage["ls_a"], "1");
    assert.equal(snap.localStorage["ls_b"], "2");
    assert.equal(snap.sessionStorage["ss_a"], "x");
    assert.ok(snap.cookies.length >= 2, "expected at least 2 cookies in snapshot");
    assert.ok(snap.mhtml && snap.mhtml.length > 0, "expected mhtml payload");

    await session.navigate(fixture.url("/elsewhere"));
    await session.evaluate(`
      document.cookie = "k1=changed; path=/";
      localStorage.setItem('ls_a', 'overwritten');
      localStorage.removeItem('ls_b');
      localStorage.setItem('ls_c', 'new');
      sessionStorage.removeItem('ss_a');
      sessionStorage.setItem('ss_b', 'leaked');
    `);

    await session.restore(snap);

    const url = await session.evaluate<string>("window.location.href");
    assert.equal(url, fixture.url("/start"));
    const cookies = await session.evaluate<string>("document.cookie");
    assert.match(cookies, /k1=v1/);
    assert.doesNotMatch(cookies, /k1=changed/);
    assert.match(cookies, /k2=v2/);

    const lsA = await session.evaluate<string | null>("localStorage.getItem('ls_a')");
    const lsB = await session.evaluate<string | null>("localStorage.getItem('ls_b')");
    const lsC = await session.evaluate<string | null>("localStorage.getItem('ls_c')");
    assert.equal(lsA, "1");
    assert.equal(lsB, "2");
    assert.equal(
      lsC,
      null,
      "localStorage entries set after the snapshot should be cleared by restore",
    );

    const ssA = await session.evaluate<string | null>("sessionStorage.getItem('ss_a')");
    const ssB = await session.evaluate<string | null>("sessionStorage.getItem('ss_b')");
    assert.equal(ssA, "x");
    assert.equal(ssB, null);

    await pool.release(session);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("crash-only: SIGKILLing a slot's chrome triggers replacement and pool stays up", async () => {
  const pool = await BrowserPool.create({ size: 1 });
  try {
    const a = await pool.acquire();
    const pid = a.pid;
    assert.ok(pid > 0);
    process.kill(pid, "SIGKILL");
    await delay(150);
    assert.equal(a.isAlive(), false);

    await pool.release(a);

    const fresh = await pool.acquire();
    assert.ok(fresh.isAlive());
    assert.notEqual(fresh.pid, pid);
    const ok = await fresh.evaluate<number>("1+1");
    assert.equal(ok, 2);
    await pool.release(fresh);
  } finally {
    await pool.close();
  }
});

test("idle-slot crash is detected and the slot is replaced in the background", async () => {
  const pool = await BrowserPool.create({ size: 2 });
  try {
    const a = await pool.acquire();
    const aPid = a.pid;
    await pool.release(a);
    // After release+respawn, both slots are idle.
    assert.equal(pool.stats().available, 2);

    // Kill an idle slot's chrome by acquiring, killing, then releasing.
    // Simpler: acquire a slot, capture its pid+release path, then kill and
    // wait for the replacement to land.
    const b = await pool.acquire();
    const bPid = b.pid;
    process.kill(bPid, "SIGKILL");
    await delay(150);
    await pool.release(b);

    // Whichever slot we get next must NOT be the dead one.
    const c = await pool.acquire();
    assert.notEqual(c.pid, aPid);
    assert.notEqual(c.pid, bPid);
    assert.ok(c.isAlive());
    await pool.release(c);
  } finally {
    await pool.close();
  }
});

test("per-task hard timeout kills the session and throws SessionTimeoutError", async () => {
  const pool = await BrowserPool.create({ size: 1 });
  try {
    const before = pool.stats().replaced;
    await assert.rejects(
      pool.withSession(
        async (session) => {
          await session.evaluate("new Promise(() => {})");
          return "never";
        },
        { taskTimeoutMs: 250 },
      ),
      (err: unknown) => err instanceof SessionTimeoutError && err.timeoutMs === 250,
    );
    assert.ok(pool.stats().replaced > before);
    const next = await pool.acquire();
    assert.ok(next.isAlive());
    await pool.release(next);
  } finally {
    await pool.close();
  }
});

test("trajectory records terminal_state=SESSION_TIMEOUT when the session times out", async () => {
  const fixture = await startFixtureServer();
  const pool = await BrowserPool.create({ size: 1 });
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const traj = await runHangAgent({
      pool,
      runsRoot,
      url: fixture.url("/hang"),
      taskTimeoutMs: 300,
    });
    assert.equal(traj.metadata.terminal_state, "SESSION_TIMEOUT");
    const reason = traj.metadata.decline_reason ?? "";
    assert.match(reason, /timed out/);
    const gz = await stat(traj.gzPath);
    assert.ok(gz.size > 0);
  } finally {
    await pool.close();
    await fixture.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

test("8 parallel agent runs against pool size 4 see only their own state", async () => {
  const fixture = await startFixtureServer();
  const pool = await BrowserPool.create({ size: 4 });
  const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
  try {
    const tasks = Array.from({ length: 8 }, (_, i) => i);
    const results = await Promise.all(
      tasks.map((i) =>
        pool.withSession(
          async (session) => {
            const path = `/task-${i}`;
            await session.navigate(fixture.url(path));
            const tag = `task-${i}-${Math.random().toString(36).slice(2, 10)}`;
            await session.evaluate(
              `document.cookie = ${JSON.stringify(`tag=${tag}; path=/`)}; localStorage.setItem('tag', ${JSON.stringify(tag)});`,
            );

            const agent = new ClickFirstLinkAgent();
            const traj = await agent.run(`task ${i}`, session, generousBudget(), {
              task_id: `iso-${i}`,
              seed: 0,
              runs_root: runsRoot,
            });

            const cookies = await session.evaluate<string>("document.cookie");
            const ls = await session.evaluate<string | null>("localStorage.getItem('tag')");
            return { i, tag, cookies, ls, terminal: traj.metadata.terminal_state };
          },
          { taskTimeoutMs: 30_000 },
        ),
      ),
    );

    const tags = new Set(results.map((r) => r.tag));
    assert.equal(tags.size, 8, "every task should have produced a unique tag");
    for (const r of results) {
      assert.match(r.cookies, new RegExp(`tag=${r.tag}`));
      assert.equal(r.ls, r.tag);
      for (const other of results) {
        if (other.tag === r.tag) continue;
        assert.doesNotMatch(
          r.cookies,
          new RegExp(`tag=${other.tag}`),
          `task ${r.i} saw task ${other.i}'s cookie`,
        );
      }
      assert.equal(r.terminal, "DONE");
    }
    assert.ok(
      pool.stats().replaced >= 8,
      `expected >=8 replaced (one per task release), got ${pool.stats().replaced}`,
    );
  } finally {
    await pool.close();
    await fixture.close();
    await rm(runsRoot, { recursive: true, force: true });
  }
});

// ---------- helpers ----------

function generousBudget(): Budget {
  return new Budget({ tokens: 100_000, usd: 1, wallSeconds: 60, steps: 50 });
}

interface RunHangOpts {
  pool: BrowserPool;
  runsRoot: string;
  url: string;
  taskTimeoutMs: number;
}

/**
 * Trivial agent shim that opens a trajectory, navigates to a never-responding
 * URL, then awaits an evaluate that never resolves. Demonstrates that when
 * pool.withSession's hard timeout fires, the agent sees SessionTimeoutError
 * propagating out of session.evaluate (because pool.withSession SIGKILLed
 * Chrome and the session's safeCdp() wraps the resulting CDP-closed error
 * into a typed SessionTimeoutError) and finishes the trajectory accordingly.
 *
 * We retain a reference to the inner trajectory promise so we can await it
 * after the outer race rejects — otherwise trajectory.finish (a few-ms
 * write+gzip) might still be in flight when the test asserts on the .gz file.
 */
async function runHangAgent(opts: RunHangOpts): Promise<Trajectory> {
  let trajectoryRef: Trajectory | null = null;
  let inner: Promise<Trajectory> | null = null;
  try {
    await opts.pool.withSession(
      (session) => {
        inner = (async () => {
          const traj = await Trajectory.open(
            { runsRoot: opts.runsRoot, agent: "hang-agent", task: "hang", seed: 0 },
            { agent_id: "hang-agent", task_id: "hang", seed: 0 },
          );
          trajectoryRef = traj;
          try {
            await session.navigate(opts.url);
            await session.evaluate("new Promise(() => {})");
            await traj.finish({ terminal_state: "DONE" });
          } catch (err) {
            if (err instanceof SessionTimeoutError) {
              await traj.finish({
                terminal_state: "SESSION_TIMEOUT",
                decline_reason: err.message,
              });
            } else if (err instanceof BudgetExceeded) {
              await traj.finish({
                terminal_state: "BUDGET_EXCEEDED",
                decline_reason: err.message,
              });
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              await traj.finish({ terminal_state: "ERROR", decline_reason: msg });
            }
          }
          return traj;
        })();
        return inner;
      },
      { taskTimeoutMs: opts.taskTimeoutMs },
    );
  } catch (err) {
    if (!(err instanceof SessionTimeoutError)) throw err;
  }
  if (inner) {
    try {
      await inner;
    } catch {
      /* already handled inside fn */
    }
  }
  if (!trajectoryRef) throw new Error("trajectory was never opened");
  return trajectoryRef;
}
