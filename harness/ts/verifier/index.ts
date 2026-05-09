// Verifier module barrel. Agents and tests should import from here.

export { parseYaml, InvalidYamlError } from "./yaml.js";
export type { YamlValue } from "./yaml.js";
export { loadTaskFile, validateTaskSpec, validateVerifierSpec } from "./loader.js";
export {
  PROGRAMMATIC_KINDS,
  InvalidTaskSpecError,
  VerifierMisuseError,
} from "./types.js";
export type {
  Difficulty,
  JsVerifierSpec,
  LlmJudgeSpec,
  RunVerifierOptions,
  Task,
  TrajectoryPredicateSpec,
  Verdict,
  Verifier,
  VerifierKind,
  VerifierSpec,
  VerifyContext,
} from "./types.js";
export { JsVerifier, TrajectoryPredicateVerifier } from "./programmatic.js";
export type { TrajectorySnapshot } from "./programmatic.js";
export { LlmJudgeVerifier } from "./llm_judge.js";
export { verify, makeVerifier, writeVerdictAudit } from "./runner.js";
