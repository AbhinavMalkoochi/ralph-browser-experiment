import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ChromeHandle {
  process: ChildProcess;
  port: number;
  userDataDir: string;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  headless?: boolean;
  extraArgs?: string[];
  startupTimeoutMs?: number;
  chromePath?: string;
}

const DEFAULT_FLAGS = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-sandbox",
  "--hide-scrollbars",
];

export async function launchChrome(opts: LaunchOptions = {}): Promise<ChromeHandle> {
  const chromePath = opts.chromePath ?? process.env.GBA_CHROME_PATH ?? "google-chrome";
  const startupTimeoutMs = opts.startupTimeoutMs ?? 15_000;
  const userDataDir = await mkdtemp(join(tmpdir(), "gba-chrome-"));

  const flags = [
    ...DEFAULT_FLAGS,
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    ...(opts.extraArgs ?? []),
    "about:blank",
  ];
  if (opts.headless === false) {
    flags.splice(flags.indexOf("--headless=new"), 1);
  }

  // detached: true puts chrome in its own process group (pgid == child.pid)
  // so we can SIGKILL the whole group on close. Chrome spawns renderer / GPU /
  // network-service subprocesses that, in the default group, would keep writing
  // into --user-data-dir after the parent exits and race with our rm cleanup.
  // Killing the group reaps every descendant in one shot.
  const child = spawn(chromePath, flags, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  // We don't want chrome to receive node's SIGINT / Ctrl-C *unless* we're done.
  // detached=true would normally let it survive a parent exit; we still ref the
  // process so node waits for it, but we never call .unref().

  let stderr = "";
  let resolved = false;
  const portPromise = new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      stderr += text;
      const match = stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (match && !resolved) {
        resolved = true;
        child.stderr?.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      if (!resolved) {
        reject(
          new Error(
            `chrome exited before DevTools port was reported (code=${code}); stderr:\n${stderr.slice(-800)}`,
          ),
        );
      }
    });
  });

  const timeout = (async (): Promise<never> => {
    await delay(startupTimeoutMs);
    throw new Error(`chrome did not report DevTools port within ${startupTimeoutMs}ms`);
  })();

  let port: number;
  try {
    port = await Promise.race([portPromise, timeout]);
  } catch (err) {
    await killChild(child);
    await rm(userDataDir, { recursive: true, force: true });
    throw err;
  }

  const close = async (): Promise<void> => {
    await killChild(child);
    // Chrome's renderer/network/GPU subprocesses can briefly outlive the
    // parent process and keep writing into the profile dir, so a single rm
    // race-loses with ENOTEMPTY/EBUSY under load (the pool test slams 8
    // chromes into ~5s). Node's rm retries linearly on those errors when
    // maxRetries>0; 5 retries × 100ms (linear backoff) is plenty.
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  return { process: child, port, userDataDir, close };
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    // Parent already dead (e.g. external SIGKILL in the crash-replace test).
    // Descendants may still be alive in the group — nuke them so cleanup
    // sees a quiescent profile dir.
    killGroup(child, "SIGKILL");
    return;
  }
  // Send SIGTERM to the whole process group (negative pid) so chrome's
  // subprocesses (renderer, GPU, network) die together with the parent.
  killGroup(child, "SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(3_000).then(() => false),
  ]);
  if (!exited) {
    killGroup(child, "SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    // Negative pid targets the process group whose pgid == pid. This works
    // because we spawned with detached:true, which set pgid=pid.
    process.kill(-pid, signal);
  } catch {
    // Group may already be gone; fall back to direct kill on the parent.
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}
