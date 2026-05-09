// JSONL trajectory writer.
//
// Layout (one JSON object per line):
//   {"kind":"meta", ...TrajectoryMetadata}
//   {"kind":"step", ...TrajectoryStep}
//   {"kind":"llm_call", model, prompt_hash, prompt_tokens, completion_tokens, latency_ms, cost_usd, cached}
//   {"kind":"verification", pass, score, reason, verifier_kind, verified_at}
//   ...steps, llm_calls, and (optionally) interim verifications interleaved...
//   {"kind":"end", end_time, terminal_state, verifier_verdict, decline_reason}
//
// On finish() we close the writer, gzip the .jsonl into .jsonl.gz, and remove
// the raw file. The presence of trajectory.jsonl.gz is the signal to the
// resumable tournament runner (US-010) that this (agent, task, seed) cell is
// done. If a verification line was recorded and finish() is called without an
// explicit verifier_verdict, the most-recent verification is used.

import { mkdir, rm } from "node:fs/promises";
import { createWriteStream, createReadStream, type WriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

import type {
  TerminalState,
  TrajectoryMetadata,
  TrajectoryStep,
  VerifierVerdict,
} from "./types.js";

export interface TrajectoryPaths {
  runsRoot: string;
  agent: string;
  task: string;
  seed: number;
}

export function trajectoryDir(p: TrajectoryPaths): string {
  return join(p.runsRoot, p.agent, p.task, String(p.seed));
}

export type TrajectoryInit = Pick<TrajectoryMetadata, "agent_id" | "task_id" | "seed">;

export interface FinishOpts {
  terminal_state: TerminalState;
  verifier_verdict?: VerifierVerdict | null;
  decline_reason?: string | null;
}

export interface LlmCallRecord {
  model: string;
  prompt_hash: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd: number;
  cached: boolean;
}

export interface VerificationRecord {
  pass: boolean;
  score: number;
  reason: string;
  verifier_kind: string;
  verified_at: string;
}

export class Trajectory {
  readonly metadata: TrajectoryMetadata;
  readonly dir: string;
  readonly jsonlPath: string;
  readonly gzPath: string;
  private writer: WriteStream;
  private readonly steps: TrajectoryStep[] = [];
  private readonly llmCalls: LlmCallRecord[] = [];
  private readonly verifications: VerificationRecord[] = [];
  private finished = false;

  static async open(paths: TrajectoryPaths, init: TrajectoryInit): Promise<Trajectory> {
    const dir = trajectoryDir(paths);
    await mkdir(dir, { recursive: true });
    const jsonlPath = join(dir, "trajectory.jsonl");
    const gzPath = jsonlPath + ".gz";
    const metadata: TrajectoryMetadata = {
      ...init,
      start_time: new Date().toISOString(),
      end_time: null,
      terminal_state: null,
      verifier_verdict: null,
      decline_reason: null,
    };
    const writer = createWriteStream(jsonlPath, { flags: "w" });
    const t = new Trajectory(metadata, dir, jsonlPath, gzPath, writer);
    await t.writeLine({ kind: "meta", ...metadata });
    return t;
  }

  private constructor(
    metadata: TrajectoryMetadata,
    dir: string,
    jsonlPath: string,
    gzPath: string,
    writer: WriteStream,
  ) {
    this.metadata = metadata;
    this.dir = dir;
    this.jsonlPath = jsonlPath;
    this.gzPath = gzPath;
    this.writer = writer;
  }

  private writeLine(obj: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.writer.write(JSON.stringify(obj) + "\n", (err) => (err ? reject(err) : resolve()));
    });
  }

  async addStep(step: TrajectoryStep): Promise<void> {
    if (this.finished) throw new Error("Trajectory already finished");
    this.steps.push(step);
    await this.writeLine({ kind: "step", ...step });
  }

  async recordLlmCall(record: LlmCallRecord): Promise<void> {
    if (this.finished) throw new Error("Trajectory already finished");
    this.llmCalls.push(record);
    await this.writeLine({ kind: "llm_call", ...record });
  }

  async recordVerification(record: VerificationRecord): Promise<void> {
    if (this.finished) throw new Error("Trajectory already finished");
    this.verifications.push(record);
    await this.writeLine({ kind: "verification", ...record });
  }

  /** End the trajectory, gzip the JSONL, and delete the raw file. Idempotent. */
  async finish(opts: FinishOpts): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.metadata.end_time = new Date().toISOString();
    this.metadata.terminal_state = opts.terminal_state;
    const explicitVerdict = opts.verifier_verdict;
    if (explicitVerdict !== undefined) {
      this.metadata.verifier_verdict = explicitVerdict;
    } else if (this.verifications.length > 0) {
      const last = this.verifications[this.verifications.length - 1] as VerificationRecord;
      this.metadata.verifier_verdict = {
        pass: last.pass,
        score: last.score,
        reason: last.reason,
      };
    } else {
      this.metadata.verifier_verdict = null;
    }
    this.metadata.decline_reason = opts.decline_reason ?? null;
    await this.writeLine({
      kind: "end",
      end_time: this.metadata.end_time,
      terminal_state: this.metadata.terminal_state,
      verifier_verdict: this.metadata.verifier_verdict,
      decline_reason: this.metadata.decline_reason,
    });
    await new Promise<void>((resolve, reject) => {
      this.writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    await pipeline(createReadStream(this.jsonlPath), createGzip(), createWriteStream(this.gzPath));
    await rm(this.jsonlPath, { force: true });
  }

  get stepCount(): number {
    return this.steps.length;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Snapshot of recorded steps; mutating the array does not affect the writer. */
  snapshotSteps(): TrajectoryStep[] {
    return [...this.steps];
  }

  snapshotLlmCalls(): LlmCallRecord[] {
    return [...this.llmCalls];
  }

  snapshotVerifications(): VerificationRecord[] {
    return [...this.verifications];
  }
}
