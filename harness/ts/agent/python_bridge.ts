// Cross-language Agent transport. Spawns a Python child running
// gba_agent.runner and exchanges line-delimited JSON-RPC 2.0 over stdio.
//
// Methods:
//   TS -> Python  agent.run({goal, task_id, seed, agent_id, budget_limits})
//   Python -> TS  browser.navigate({url}) -> null
//                 browser.evaluate({expression}) -> any
//                 browser.screenshot({}) -> {base64}
//                 budget.record_step({}) -> null
//                 budget.record_tokens({tokens_in, tokens_out, usd}) -> null
//                 budget.check({}) -> {ok, error?}
//                 trajectory.add_step({...TrajectoryStep}) -> null
//                 trajectory.finish({terminal_state, verifier_verdict?, decline_reason?}) -> null

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { resolve as resolvePath } from "node:path";

import type { AgentContext } from "./agent.js";
import type { Trajectory } from "./trajectory.js";
import type {
  Action,
  BrowserSession,
  Budget,
  TerminalState,
  TrajectoryStep,
  VerifierVerdict,
} from "./types.js";
import type { LLMClient } from "../llm/client.js";
import type { LLMMessage, LLMOpts } from "../llm/types.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type RpcMessage = RpcRequest | RpcResponse;

export interface PythonBridgeOptions {
  agentPath: string;
  pythonPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export class PythonAgentBridge {
  private readonly child: ChildProcess;
  private readonly rl: Interface;
  private readonly cwd: string;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly handlers = new Map<string, RpcHandler>();
  private closed = false;

  static spawn(opts: PythonBridgeOptions): PythonAgentBridge {
    const cwd = opts.cwd ?? process.cwd();
    const python = opts.pythonPath ?? process.env.GBA_PYTHON_PATH ?? ".venv/bin/python";
    const env = {
      ...process.env,
      ...opts.env,
      PYTHONPATH: resolvePath(cwd, "harness/python"),
    };
    const child = spawn(python, ["-m", "gba_agent.runner", "--agent", opts.agentPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    return new PythonAgentBridge(child, cwd);
  }

  private constructor(child: ChildProcess, cwd: string) {
    if (!child.stdout || !child.stdin) {
      throw new Error("PythonAgentBridge requires piped stdio");
    }
    this.child = child;
    this.cwd = cwd;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.onLine(line));
    child.stderr?.on("data", (chunk: Buffer) => {
      // Forward python stderr to ours so test output is debuggable.
      process.stderr.write(`[python:${child.pid}] ${chunk.toString("utf8")}`);
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      const err = new Error(
        `python bridge exited (code=${code} signal=${signal ?? "none"}) before responding`,
      );
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  get cwdPath(): string {
    return this.cwd;
  }

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("python bridge closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.child.stdin?.end();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
    });
  }

  private send(payload: RpcMessage): void {
    if (this.closed || !this.child.stdin) {
      throw new Error("python bridge closed");
    }
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      process.stderr.write(`[python:${this.child.pid}] non-JSON line: ${line}\n`);
      return;
    }
    if ("method" in msg) void this.onRequest(msg);
    else this.onResponse(msg);
  }

  private async onRequest(req: RpcRequest): Promise<void> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `unknown method ${req.method}` },
      });
      return;
    }
    try {
      const result = await handler(req.params);
      this.send({ jsonrpc: "2.0", id: req.id, result: result ?? null });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: (err as Error).message },
      });
    }
  }

  private onResponse(resp: RpcResponse): void {
    const p = this.pending.get(resp.id);
    if (!p) return;
    this.pending.delete(resp.id);
    if (resp.error) p.reject(new Error(`RPC ${resp.error.code}: ${resp.error.message}`));
    else p.resolve(resp.result);
  }
}

export interface RunPythonAgentOpts {
  bridge: PythonAgentBridge;
  agentId: string;
  goal: string;
  browser: BrowserSession;
  budget: Budget;
  trajectory: Trajectory;
  ctx: AgentContext;
  /**
   * Optional LLMClient. When provided, the bridge registers an `llm.call`
   * handler so the Python agent can issue model calls via the same
   * cache/budget/trajectory plumbing as TS agents (US-004).
   */
  llm?: LLMClient;
}

/**
 * Wire harness primitives (browser/budget/trajectory) into the bridge as RPC
 * handlers, then invoke `agent.run` on the Python side. Returns the same
 * trajectory once Python signals completion.
 */
export async function runPythonAgent(opts: RunPythonAgentOpts): Promise<Trajectory> {
  const { bridge, agentId, goal, browser, budget, trajectory, ctx, llm } = opts;

  bridge.register("browser.navigate", async (p) => {
    await browser.navigate(p.url as string);
    return null;
  });
  bridge.register("browser.evaluate", async (p) => {
    return await browser.evaluate(p.expression as string);
  });
  bridge.register("browser.screenshot", async () => {
    const buf = await browser.screenshot();
    return { base64: buf.toString("base64") };
  });

  bridge.register("budget.record_step", () => {
    budget.recordStep();
    return null;
  });
  bridge.register("budget.record_tokens", (p) => {
    budget.recordTokens(p.tokens_in as number, p.tokens_out as number, p.usd as number);
    return null;
  });
  bridge.register("budget.check", () => {
    try {
      budget.check();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  bridge.register("trajectory.add_step", async (p) => {
    const step: TrajectoryStep = {
      step: p.step as number,
      observation_summary: p.observation_summary as string,
      action: p.action as Action,
      latency_ms: p.latency_ms as number,
      tokens_in: (p.tokens_in as number | undefined) ?? 0,
      tokens_out: (p.tokens_out as number | undefined) ?? 0,
      cost_usd: (p.cost_usd as number | undefined) ?? 0,
      screenshot_path: (p.screenshot_path as string | null | undefined) ?? null,
      verifier_state: (p.verifier_state as Record<string, unknown> | null | undefined) ?? null,
    };
    await trajectory.addStep(step);
    return null;
  });
  bridge.register("trajectory.finish", async (p) => {
    await trajectory.finish({
      terminal_state: p.terminal_state as TerminalState,
      verifier_verdict: (p.verifier_verdict as VerifierVerdict | null | undefined) ?? null,
      decline_reason: (p.decline_reason as string | null | undefined) ?? null,
    });
    return null;
  });

  if (llm) {
    bridge.register("llm.call", async (p) => {
      const result = await llm.call(
        p.model as string,
        p.messages as LLMMessage[],
        (p.opts as LLMOpts | undefined) ?? {},
      );
      return {
        text: result.text,
        model: result.model,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        cost_usd: result.cost_usd,
        latency_ms: result.latency_ms,
        prompt_hash: result.prompt_hash,
        cached: result.cached,
      };
    });
  }

  await bridge.call("agent.run", {
    goal,
    task_id: ctx.task_id,
    seed: ctx.seed,
    agent_id: agentId,
    budget_limits: budget.limits,
  });

  return trajectory;
}
