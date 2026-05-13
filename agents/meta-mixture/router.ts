// Router policy for the meta-mixture agent (US-024).
//
// Selects ONE of the top-3 hard-slice agents from the latest tournament
// (runs/leaderboard.json snapshot 2026-05-12; see docs/champion-2026-05-12.md):
//
//   - runtime-codegen   — 5/10 hard pass, raw-JS body action substrate
//   - network-shadow    — 3/10 hard pass, HTTP-first action substrate
//   - codegen-predicate — 2/9  hard pass, codegen + predicate termination
//
// The route is decided from cheap task features only: the start_url host /
// scheme and the goal text. NO hard-slice trajectories are consulted, and
// the routing thresholds were tuned against the easy-slice summary
// data only (see agents/meta-mixture/README.md for the methodology).

export type RoutedAgentId =
  | "runtime-codegen"
  | "network-shadow"
  | "codegen-predicate";

export const ROUTABLE_AGENTS: readonly RoutedAgentId[] = [
  "runtime-codegen",
  "network-shadow",
  "codegen-predicate",
] as const;

export interface TaskFeatures {
  /** Lowercased start_url; '' if not parseable. */
  url: string;
  /** Hostname (e.g. "example.com"); '' for fixtures:// or invalid URLs. */
  host: string;
  /** URL scheme ("http", "https", "fixtures", "data", ...). */
  scheme: string;
  /** Path component of the URL. */
  path: string;
  /** Lowercased, whitespace-normalised goal text. */
  goal: string;
  /** Word count of the goal. */
  goalWords: number;
  /** Keyword hits from the API/network/server-receipt family. */
  apiHits: string[];
  /** Keyword hits from the transient/recoverable/hydration family. */
  transientHits: string[];
  /** Keyword hits from the read-only extraction family. */
  extractHits: string[];
}

export interface RouteDecision {
  agent: RoutedAgentId;
  features: TaskFeatures;
  /** Ordered, plain-English reasons why this agent was picked. */
  reasons: string[];
  /** Which rule fired (for tests + audit). */
  rule:
    | "api_first"
    | "predicate_termination"
    | "extract_default"
    | "default_codegen";
}

// Keyword families — tuned ONLY against easy-slice goal text + (separately)
// the four named hostile-fixture failure modes that drove the US-022 mining.
// We do NOT consult any hard-slice success/failure data here; the lists
// describe TASK SHAPE in plain English, not agent-specific tells.

const API_KEYWORDS: readonly string[] = [
  "pdf",
  "json",
  "endpoint",
  "/__",
  "fetch(",
  "xhr",
  "post ",
  "posts ",
  "posted",
  "api",
  "submit",
  "submits",
  "submitted",
  "submission",
  "shadow root",
  "shadow dom",
  "shadow-form",
  "shadowroot",
  "popup",
  "multi-tab",
  "new tab",
  "second tab",
  "window.opener",
  "server",
];

const TRANSIENT_KEYWORDS: readonly string[] = [
  "retry",
  "retries",
  "try again",
  "again",
  "recover",
  "recoverable",
  "hydrat", // hydrate / hydration / hydrated
  "wait until",
  "wait for",
  "verify",
  "validate",
  "condition",
  "conditional",
  "regex",
  "second attempt",
  "first attempt",
  "transient",
  "flaky",
];

const EXTRACT_KEYWORDS: readonly string[] = [
  "confirm ",
  "extract",
  "read",
  "find ",
  "open ",
  "navigate",
  "lists ",
  "abstract",
  "headline",
  "title",
  "page",
];

function hitList(haystack: string, needles: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of needles) if (haystack.includes(n)) out.push(n);
  return out;
}

export function extractFeatures(goal: string, startUrl: string): TaskFeatures {
  const normalisedGoal = (goal ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  let scheme = "";
  let host = "";
  let path = "";
  const url = (startUrl ?? "").toLowerCase();
  const schemeMatch = url.match(/^([a-z][a-z0-9+\-.]*):/);
  if (schemeMatch) {
    scheme = schemeMatch[1] as string;
    const rest = url.slice(scheme.length + 1).replace(/^\/+/, "");
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      host = rest.slice(0, slash);
      path = "/" + rest.slice(slash + 1);
    } else {
      host = rest;
      path = "/";
    }
  }
  return {
    url,
    host,
    scheme,
    path,
    goal: normalisedGoal,
    goalWords: normalisedGoal ? normalisedGoal.split(/\s+/).length : 0,
    apiHits: hitList(normalisedGoal, API_KEYWORDS),
    transientHits: hitList(normalisedGoal, TRANSIENT_KEYWORDS),
    extractHits: hitList(normalisedGoal, EXTRACT_KEYWORDS),
  };
}

export function decideRoute(goal: string, startUrl: string): RouteDecision {
  const features = extractFeatures(goal, startUrl);
  const reasons: string[] = [];

  // Rule 1 (api_first): the goal looks like a server-receipt / API task —
  // direct same-origin HTTP can bypass DOM hostility (shadow, popup, PDF
  // bytes, multi-tab). network-shadow wins these on the hard slice
  // (shadow-form, recoverable, modal-stack) and is also the CHEAPEST of
  // the top-3 on the easy slice ($0.00079 vs $0.00114 / ~$0.00285),
  // so easy-slice "extract from public host" tasks route here too when
  // no transient-failure cue is present.
  if (features.apiHits.length >= 1) {
    reasons.push(`goal mentions API/server cues: ${features.apiHits.join(", ")}`);
    return { agent: "network-shadow", features, reasons, rule: "api_first" };
  }

  // Rule 2 (predicate_termination): the goal hints at a transient / late /
  // recoverable state. predicate-driven termination prevents the agent
  // from declaring done before the page actually reaches the goal state;
  // codegen-predicate keeps the raw-JS action substrate so the body can
  // still pierce shadow roots, drive timers, etc.
  if (features.transientHits.length >= 1) {
    reasons.push(
      `goal mentions transient/late-state cues: ${features.transientHits.join(", ")}`,
    );
    return {
      agent: "codegen-predicate",
      features,
      reasons,
      rule: "predicate_termination",
    };
  }

  // Rule 3 (extract_default): pure-extraction tasks (easy-slice canaries)
  // are all tied at 8/9 across the top-3, so we pick the CHEAPEST option
  // observed on the easy slice (network-shadow @ $0.00079/cell).
  if (
    (features.scheme === "http" || features.scheme === "https") &&
    features.extractHits.length >= 1
  ) {
    reasons.push(
      `public-host extraction shape; easy-slice cheapest option (mean $0.00079)`,
    );
    return { agent: "network-shadow", features, reasons, rule: "extract_default" };
  }

  // Default (default_codegen): runtime-codegen has the highest hard-slice
  // pass rate of any single agent (5/10) and is the strongest fallback for
  // hostile fixtures (shadow-form, virtual-scroll, modal-stack,
  // late-hydration, recoverable). We default to it for any task whose
  // shape did not match a more specific rule.
  reasons.push(
    "no specific cue; default to runtime-codegen (strongest hard-slice agent)",
  );
  return { agent: "runtime-codegen", features, reasons, rule: "default_codegen" };
}
