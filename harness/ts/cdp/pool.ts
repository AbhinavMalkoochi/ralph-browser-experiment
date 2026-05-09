// BrowserPool: N parallel Chrome processes with per-task isolation,
// snapshot/restore, hard wall-clock timeout, and crash-only replacement.
//
// Why one Chrome per slot rather than one Chrome with N browser contexts?
// True profile isolation (--user-data-dir) is the only way to guarantee no
// cross-contamination of cookies, localStorage, IndexedDB, service workers,
// HTTP cache, and credentials. CDP "browser contexts" are not as strict.
//
// Lifecycle:
//   create({size}) -> spawns `size` Chromes, each with its own user-data-dir
//   acquire()      -> hands out a PooledBrowserSession bound to one slot
//   release(s)     -> tears the slot down and respawns a fresh one
//   close()        -> rejects waiters, tears every slot down
//
// release-then-respawn is heavier than reusing slots, but it's the only design
// that preserves the FR-4 isolation guarantee without a separate cookie/storage
// scrub step that is easy to forget. ~1s of spawn cost per task is acceptable
// for this research harness.

import { launchChrome, type ChromeHandle, type LaunchOptions } from "./launch.js";
import { CdpSession, fetchTargets } from "./client.js";
import type { BrowserSession } from "../agent/types.js";

export interface BrowserPoolOptions {
  /** Pool size; falls back to env GBA_POOL_SIZE, then 4. */
  size?: number;
  /** Forwarded to launchChrome for every slot. */
  launchOptions?: LaunchOptions;
  /** Default per-task hard timeout used by withSession when none is given. */
  defaultTaskTimeoutMs?: number;
}

export interface AcquireOptions {
  /** Per-task hard timeout. Overrides BrowserPoolOptions.defaultTaskTimeoutMs. */
  taskTimeoutMs?: number;
}

export interface BrowserSnapshot {
  url: string;
  cookies: Record<string, unknown>[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  /** base64 MHTML from Page.captureSnapshot, only present when requested. */
  mhtml?: string;
  capturedAt: string;
}

export class SessionTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`session timed out after ${timeoutMs}ms`);
    this.name = "SessionTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

interface Slot {
  id: string;
  chrome: ChromeHandle;
  cdp: CdpSession;
  alive: boolean;
}

interface SessionInternals {
  slot: Slot;
  deadlineHit: boolean;
  timeoutMs: number;
}

const internalOf = new WeakMap<PooledBrowserSession, SessionInternals>();

export class PooledBrowserSession implements BrowserSession {
  readonly id: string;
  readonly cdp: CdpSession;

  /** @internal */
  constructor(slot: Slot) {
    this.id = slot.id;
    this.cdp = slot.cdp;
    internalOf.set(this, { slot, deadlineHit: false, timeoutMs: 0 });
  }

  private internals(): SessionInternals {
    const i = internalOf.get(this);
    if (!i) throw new Error("PooledBrowserSession internals missing (released?)");
    return i;
  }

  isAlive(): boolean {
    const i = internalOf.get(this);
    if (!i) return false;
    return i.slot.alive && i.slot.chrome.process.exitCode === null;
  }

  /** Read-only path to the underlying Chrome --user-data-dir. */
  get userDataDir(): string {
    return this.internals().slot.chrome.userDataDir;
  }

  /** PID of the underlying Chrome process. -1 if it has exited. */
  get pid(): number {
    return this.internals().slot.chrome.process.pid ?? -1;
  }

  private async safeCdp<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const i = internalOf.get(this);
      if (i?.deadlineHit) throw new SessionTimeoutError(i.timeoutMs);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async navigate(url: string): Promise<void> {
    await this.safeCdp(() => this.cdp.send("Page.navigate", { url }));
    await this.waitForLoad();
  }

  private waitForLoad(timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    return new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        if (Date.now() - start > timeoutMs) {
          const i = internalOf.get(this);
          if (i?.deadlineHit) reject(new SessionTimeoutError(i.timeoutMs));
          else reject(new Error(`navigate: load timeout after ${timeoutMs}ms`));
          return;
        }
        this.cdp
          .send<{ result: { value: string } }>("Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true,
          })
          .then((r) => {
            if (r.result.value === "complete" || r.result.value === "interactive") resolve();
            else setTimeout(tick, 25);
          })
          .catch((err) => {
            const i = internalOf.get(this);
            if (i?.deadlineHit) reject(new SessionTimeoutError(i.timeoutMs));
            else reject(err as Error);
          });
      };
      tick();
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.safeCdp(() =>
      this.cdp.send<{ result: { value: T; type: string }; exceptionDetails?: { text: string } }>(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
      ),
    );
    if (r.exceptionDetails) throw new Error(`evaluate threw: ${r.exceptionDetails.text}`);
    return r.result.value;
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.safeCdp(() =>
      this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }),
    );
    return Buffer.from(r.data, "base64");
  }

  /** Capture URL + storage state. Pass {includeMhtml:true} for a DOM snapshot. */
  async snapshot(opts: { includeMhtml?: boolean } = {}): Promise<BrowserSnapshot> {
    const url = await this.evaluate<string>("window.location.href");
    const cookieRes = await this.safeCdp(() =>
      this.cdp.send<{ cookies: Record<string, unknown>[] }>("Network.getAllCookies"),
    );
    const localStorage = await this.evaluate<Record<string, string>>(LS_DUMP);
    const sessionStorage = await this.evaluate<Record<string, string>>(SS_DUMP);
    let mhtml: string | undefined;
    if (opts.includeMhtml) {
      const r = await this.safeCdp(() =>
        this.cdp.send<{ data: string }>("Page.captureSnapshot", { format: "mhtml" }),
      );
      mhtml = r.data;
    }
    return {
      url,
      cookies: cookieRes.cookies,
      localStorage,
      sessionStorage,
      ...(mhtml !== undefined ? { mhtml } : {}),
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Restore prior URL + cookies + storage. Order is:
   *   1. clear current cookies
   *   2. set cookies from snapshot (so the navigation request sees them)
   *   3. navigate to the snapshot URL
   *   4. replay localStorage / sessionStorage on the new origin
   * MHTML payloads are not replayed: they are an audit artefact, not a substrate
   * for re-running the page. Restore is intended for state, not for arbitrary DOM.
   */
  async restore(snap: BrowserSnapshot): Promise<void> {
    await this.safeCdp(() => this.cdp.send("Network.clearBrowserCookies"));
    // Best-effort storage clear on the *current* origin. about:blank and
    // opaque origins throw SecurityError, which we ignore.
    try {
      await this.evaluate(
        "(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} })()",
      );
    } catch {
      /* ignore */
    }
    if (snap.cookies.length) {
      await this.safeCdp(() => this.cdp.send("Network.setCookies", { cookies: snap.cookies }));
    }
    await this.navigate(snap.url);
    if (Object.keys(snap.localStorage).length) {
      await this.evaluate(
        `(() => { const o = ${JSON.stringify(snap.localStorage)}; try { for (const k of Object.keys(o)) localStorage.setItem(k, o[k]); } catch (e) {} })()`,
      );
    }
    if (Object.keys(snap.sessionStorage).length) {
      await this.evaluate(
        `(() => { const o = ${JSON.stringify(snap.sessionStorage)}; try { for (const k of Object.keys(o)) sessionStorage.setItem(k, o[k]); } catch (e) {} })()`,
      );
    }
  }
}

const LS_DUMP = `(() => {
  const o = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k != null) o[k] = window.localStorage.getItem(k) ?? '';
    }
  } catch (e) {}
  return o;
})()`;

const SS_DUMP = `(() => {
  const o = {};
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k != null) o[k] = window.sessionStorage.getItem(k) ?? '';
    }
  } catch (e) {}
  return o;
})()`;

export interface PoolStats {
  size: number;
  available: number;
  inUse: number;
  waiters: number;
  /** Number of slots that have been replaced over the pool's lifetime. */
  replaced: number;
}

interface Waiter {
  resolve: (s: PooledBrowserSession) => void;
  reject: (e: Error) => void;
}

export class BrowserPool {
  /** Configured slot count (may temporarily be lower if a respawn is in flight). */
  readonly size: number;
  private readonly launchOpts: LaunchOptions;
  private readonly defaultTaskTimeoutMs: number;
  private readonly idle: Slot[] = [];
  private readonly inUse = new Set<Slot>();
  private readonly waiters: Waiter[] = [];
  private replaced = 0;
  private slotSeq = 0;
  private closing = false;

  /** Read GBA_POOL_SIZE; null when unset, throws on invalid values. */
  static envSize(): number | null {
    const env = process.env.GBA_POOL_SIZE;
    if (env == null || env === "") return null;
    const n = Number(env);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      throw new Error(`GBA_POOL_SIZE must be a positive integer, got '${env}'`);
    }
    return n;
  }

  static async create(opts: BrowserPoolOptions = {}): Promise<BrowserPool> {
    const envSize = BrowserPool.envSize();
    const size = opts.size ?? envSize ?? 4;
    if (!Number.isFinite(size) || size < 1 || !Number.isInteger(size)) {
      throw new Error(`pool size must be a positive integer, got ${size}`);
    }
    const pool = new BrowserPool(
      size,
      opts.launchOptions ?? {},
      opts.defaultTaskTimeoutMs ?? 60_000,
    );
    let slots: Slot[];
    try {
      slots = await Promise.all(Array.from({ length: size }, () => pool.spawnSlot()));
    } catch (err) {
      // Roll back any slots that did make it.
      await pool.close();
      throw err;
    }
    pool.idle.push(...slots);
    return pool;
  }

  private constructor(size: number, launchOpts: LaunchOptions, defaultTaskTimeoutMs: number) {
    this.size = size;
    this.launchOpts = launchOpts;
    this.defaultTaskTimeoutMs = defaultTaskTimeoutMs;
  }

  private async spawnSlot(): Promise<Slot> {
    const id = `slot-${process.pid}-${++this.slotSeq}`;
    const chrome = await launchChrome(this.launchOpts);
    let cdp: CdpSession;
    try {
      const targets = await fetchTargets(chrome.port);
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!page?.webSocketDebuggerUrl) throw new Error("CDP /json reported no page target");
      cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
      await cdp.send("Page.enable");
      // Network domain is needed for cookie snapshot/restore.
      await cdp.send("Network.enable");
    } catch (err) {
      await chrome.close();
      throw err;
    }
    const slot: Slot = { id, chrome, cdp, alive: true };
    chrome.process.once("exit", () => {
      slot.alive = false;
      void this.handleSlotExit(slot);
    });
    return slot;
  }

  private async handleSlotExit(slot: Slot): Promise<void> {
    if (this.closing) return;
    const idleIdx = this.idle.indexOf(slot);
    if (idleIdx < 0) {
      // Slot was in use; release() owns the replacement. Nothing to do here.
      return;
    }
    this.idle.splice(idleIdx, 1);
    this.replaced += 1;
    try {
      const fresh = await this.spawnSlot();
      if (this.closing) {
        await this.destroySlot(fresh);
        return;
      }
      this.idle.push(fresh);
      this.wakeWaiter();
    } catch {
      // Pool runs under capacity until a future release respawns successfully.
    }
  }

  private wakeWaiter(): void {
    while (this.waiters.length && this.idle.length) {
      const w = this.waiters.shift()!;
      const slot = this.idle.shift()!;
      this.inUse.add(slot);
      w.resolve(new PooledBrowserSession(slot));
    }
  }

  /** Acquire a session. Resolves immediately if a slot is idle, else queues. */
  acquire(): Promise<PooledBrowserSession> {
    if (this.closing) return Promise.reject(new Error("pool is closed"));
    const slot = this.idle.shift();
    if (slot) {
      this.inUse.add(slot);
      return Promise.resolve(new PooledBrowserSession(slot));
    }
    return new Promise<PooledBrowserSession>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Release a session. Always destroys+respawns the slot for isolation. */
  async release(session: PooledBrowserSession): Promise<void> {
    const i = internalOf.get(session);
    if (!i) return; // already released or unknown session
    // Do NOT delete the WeakMap entry here. After SIGKILLing chrome on a
    // timeout, safeCdp() needs to read internals.deadlineHit when the WS
    // close event eventually fires (on a later I/O turn) so it can convert
    // the resulting "CDP session closed" rejection into a SessionTimeoutError.
    // The WeakMap entry is held by the session object only; once the agent
    // drops its reference, GC reclaims it.
    const slot = i.slot;
    if (!this.inUse.delete(slot)) return; // not from this pool, or double-release
    this.replaced += 1;
    await this.destroySlot(slot);
    if (this.closing) return;
    try {
      const fresh = await this.spawnSlot();
      if (this.closing) {
        await this.destroySlot(fresh);
        return;
      }
      this.idle.push(fresh);
      this.wakeWaiter();
    } catch {
      // Drop to under-capacity; further acquires queue until a release succeeds.
    }
  }

  /**
   * Acquire, run fn under a wall-clock timeout, then release. fn rejects
   * with SessionTimeoutError if the deadline fires before it resolves.
   * The session is killed forcibly on timeout so any in-flight CDP work
   * unwinds promptly.
   */
  async withSession<T>(
    fn: (session: PooledBrowserSession) => Promise<T>,
    opts: AcquireOptions = {},
  ): Promise<T> {
    const session = await this.acquire();
    const timeoutMs = opts.taskTimeoutMs ?? this.defaultTaskTimeoutMs;
    const internals = internalOf.get(session);
    if (internals) internals.timeoutMs = timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (internals) internals.deadlineHit = true;
        const slot = internals?.slot;
        if (slot) {
          slot.alive = false;
          // SIGKILL is the right hammer here: a wedged Chrome may not respond
          // to SIGTERM, and we have a hard wall-clock to honour.
          try {
            slot.chrome.process.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
        reject(new SessionTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([fn(session), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      await this.release(session);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const w of this.waiters.splice(0)) {
      w.reject(new Error("pool closed"));
    }
    const slots = [...this.idle.splice(0), ...this.inUse];
    this.inUse.clear();
    await Promise.all(slots.map((s) => this.destroySlot(s)));
  }

  private async destroySlot(slot: Slot): Promise<void> {
    slot.alive = false;
    try {
      await slot.cdp.close();
    } catch {
      /* ignore */
    }
    try {
      await slot.chrome.close();
    } catch {
      /* ignore */
    }
  }

  stats(): PoolStats {
    return {
      size: this.size,
      available: this.idle.length,
      inUse: this.inUse.size,
      waiters: this.waiters.length,
      replaced: this.replaced,
    };
  }
}
