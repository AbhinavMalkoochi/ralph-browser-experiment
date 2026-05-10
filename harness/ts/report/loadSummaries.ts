// Walk runs/<agent>/<task>/<seed>/summary.json and return the parsed records.
//
// The tournament runner writes one summary.json per (agent, task, seed) cell
// (US-010); the report generator reads them back to feed the failure-cluster
// and best-trajectory sections without ever gunzipping a trajectory.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { CellSummary } from "../tournament/types.js";

export interface LoadSummariesOpts {
  /** Predicate to skip top-level entries (e.g. ".cache", "leaderboard.json"). */
  skip?: (name: string) => boolean;
}

const DEFAULT_SKIP = new Set([".cache", ".tmp", "leaderboard.json"]);

export async function loadAllSummaries(
  runsRoot: string,
  opts: LoadSummariesOpts = {},
): Promise<CellSummary[]> {
  const skip = opts.skip ?? ((name) => DEFAULT_SKIP.has(name) || name.startsWith("."));
  let agents: string[];
  try {
    agents = await readdir(runsRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const out: CellSummary[] = [];
  for (const agent of agents.sort()) {
    if (skip(agent)) continue;
    const agentDir = join(runsRoot, agent);
    if (!(await isDir(agentDir))) continue;
    const tasks = await readdir(agentDir);
    for (const task of tasks.sort()) {
      const taskDir = join(agentDir, task);
      if (!(await isDir(taskDir))) continue;
      const seeds = await readdir(taskDir);
      for (const seed of seeds.sort()) {
        const seedDir = join(taskDir, seed);
        if (!(await isDir(seedDir))) continue;
        const sumPath = join(seedDir, "summary.json");
        const raw = await readJson(sumPath);
        if (raw) out.push(raw as CellSummary);
      }
    }
  }
  return out;
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}
