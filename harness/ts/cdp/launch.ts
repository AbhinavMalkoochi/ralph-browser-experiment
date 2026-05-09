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

  const child = spawn(chromePath, flags, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

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
    await rm(userDataDir, { recursive: true, force: true });
  };

  return { process: child, port, userDataDir, close };
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(3_000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}
