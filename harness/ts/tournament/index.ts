// Public surface of the tournament module (US-010 + US-012).

export { discoverAgents, validateManifest } from "./discovery.js";
export {
  DISTINCTNESS_THRESHOLD,
  formatDistinctnessWarning,
  jaccardOverlap,
  validateDistinctness,
} from "./distinctness.js";
export type { DistinctnessIssue, ValidateDistinctnessOpts } from "./distinctness.js";
export { runContractTest } from "./contract.js";
export type { ContractResult, ContractTestOpts } from "./contract.js";
export { aggregate, buildLeaderboardFile, formatLeaderboard, percentile, writeLeaderboard } from "./leaderboard.js";
export { buildBracket } from "./bracket.js";
export { hasSummary, readSummary, summaryPath, writeSummary } from "./summary.js";
export { LEADERBOARD_FILENAME, loadSliceTasks, runTournament } from "./runner.js";
export type {
  AgentLanguage,
  AgentManifest,
  BracketMatch,
  BracketResult,
  BracketRound,
  CellSummary,
  DiscoveredAgent,
  LeaderboardFile,
  LeaderboardRow,
} from "./types.js";
