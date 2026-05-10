// Cell summary read/write.
//
// Each completed (agent, task, seed) cell drops a summary.json next to
// trajectory.jsonl.gz; the resumable runner skips any cell whose summary.json
// already exists, and the leaderboard aggregator reads them back without ever
// gunzipping the trajectory.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { trajectoryDir, type TrajectoryPaths } from "../agent/trajectory.js";
import type { CellSummary } from "./types.js";

export function summaryPath(paths: TrajectoryPaths): string {
  return join(trajectoryDir(paths), "summary.json");
}

export async function readSummary(path: string): Promise<CellSummary | null> {
  try {
    const raw = await readFile(path, "utf8");
    const obj = JSON.parse(raw) as CellSummary;
    return obj;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function writeSummary(path: string, summary: CellSummary): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(summary, null, 2) + "\n");
}

export async function hasSummary(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
