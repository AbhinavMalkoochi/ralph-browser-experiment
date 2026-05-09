// Task spec loader. Reads a YAML file (or already-parsed object) and returns
// a fully validated `Task` value. Validation enforces every assumption the
// verifier framework relies on at run time, so a malformed task fails at load
// time rather than mid-tournament.

import { readFile } from "node:fs/promises";

import { parseYaml, type YamlValue } from "./yaml.js";
import {
  InvalidTaskSpecError,
  type Difficulty,
  type Task,
  type VerifierSpec,
} from "./types.js";

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];
const VERIFIER_KINDS = new Set(["js", "trajectory_predicate", "llm_judge"]);

export async function loadTaskFile(path: string): Promise<Task> {
  const raw = await readFile(path, "utf8");
  let parsed: YamlValue;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidTaskSpecError(`${path}: ${msg}`);
  }
  return validateTaskSpec(parsed, path);
}

export function validateTaskSpec(value: unknown, source = "<task>"): Task {
  if (!isPlainObject(value)) {
    throw new InvalidTaskSpecError(`${source}: top-level must be a mapping`);
  }
  const id = requireString(value, "id", source);
  const goal = requireString(value, "goal", source);
  const start_url = requireString(value, "start_url", source);
  const difficultyRaw = requireString(value, "difficulty", source);
  if (!DIFFICULTIES.includes(difficultyRaw as Difficulty)) {
    throw new InvalidTaskSpecError(
      `${source}: difficulty must be one of ${DIFFICULTIES.join(", ")}; got ${JSON.stringify(difficultyRaw)}`,
    );
  }
  const difficulty = difficultyRaw as Difficulty;
  const tags = requireStringArray(value, "tags", source);
  const verifierVal = value.verifier;
  if (!isPlainObject(verifierVal)) {
    throw new InvalidTaskSpecError(`${source}: missing or invalid "verifier" mapping`);
  }
  const verifier = validateVerifierSpec(verifierVal, tags, source);
  return { id, goal, start_url, difficulty, tags, verifier };
}

export function validateVerifierSpec(
  value: Record<string, unknown>,
  tags: string[],
  source: string,
): VerifierSpec {
  const kindRaw = value.kind;
  if (typeof kindRaw !== "string" || !VERIFIER_KINDS.has(kindRaw)) {
    throw new InvalidTaskSpecError(
      `${source}: verifier.kind must be one of js, trajectory_predicate, llm_judge; got ${JSON.stringify(kindRaw)}`,
    );
  }
  if (kindRaw === "js") {
    const expression = value.expression;
    if (typeof expression !== "string" || expression.trim().length === 0) {
      throw new InvalidTaskSpecError(`${source}: verifier.expression is required for kind=js`);
    }
    return { kind: "js", expression };
  }
  if (kindRaw === "trajectory_predicate") {
    const expression = value.expression;
    if (typeof expression !== "string" || expression.trim().length === 0) {
      throw new InvalidTaskSpecError(
        `${source}: verifier.expression is required for kind=trajectory_predicate`,
      );
    }
    // Compile-once gate: catch syntax errors at load time.
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function("traj", `"use strict"; return (${expression});`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new InvalidTaskSpecError(
        `${source}: verifier.expression failed to compile (${msg})`,
      );
    }
    return { kind: "trajectory_predicate", expression };
  }
  // llm_judge
  if (!tags.includes("judge_required")) {
    throw new InvalidTaskSpecError(
      `${source}: verifier.kind=llm_judge requires the task to be tagged "judge_required"`,
    );
  }
  const question = value.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new InvalidTaskSpecError(`${source}: verifier.question is required for kind=llm_judge`);
  }
  const model = value.model;
  if (model !== undefined && typeof model !== "string") {
    throw new InvalidTaskSpecError(`${source}: verifier.model must be a string when set`);
  }
  const expected = value.expected;
  if (expected !== undefined && typeof expected !== "string") {
    throw new InvalidTaskSpecError(`${source}: verifier.expected must be a string when set`);
  }
  return {
    kind: "llm_judge",
    question,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof expected === "string" ? { expected } : {}),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, source: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new InvalidTaskSpecError(`${source}: missing or empty "${key}" (must be a non-empty string)`);
  }
  return v;
}

function requireStringArray(obj: Record<string, unknown>, key: string, source: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new InvalidTaskSpecError(`${source}: "${key}" must be a list of strings`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new InvalidTaskSpecError(`${source}: every "${key}" entry must be a string`);
    }
  }
  return v as string[];
}
