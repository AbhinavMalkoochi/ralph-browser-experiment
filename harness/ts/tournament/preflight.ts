// Per-slice preflight checks (US-027).
//
// The hard-app slice needs the four self-hosted apps running (Gitea,
// Excalidraw, BookStack, Vikunja). The tournament runner calls
// `slicePreflight(slice)` before iterating cells; if the slice has a
// precondition that fails, the runner SKIPS the slice cleanly (no
// summary.json writes, no crash) and logs a clear line.
//
// The check is intentionally a small HTTP probe (no Chrome spawn) so the
// preflight runs in <2 s even on a cold path.

import { appIsReachable, type HardAppId } from "../cdp/loginAs.js";

export type PreflightVerdict =
  | { ok: true }
  | { ok: false; reason: string; skipped_apps: HardAppId[] };

export interface PreflightOptions {
  /** Override the set of apps to probe; defaults to all four. */
  apps?: HardAppId[];
  /** Per-app probe timeout. */
  timeoutMs?: number;
  /** Env vars to read SKIP_SELF_HOSTED from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export const HARD_APP_SLICE_ID = "hard-app";

const ALL_APPS: HardAppId[] = ["gitea", "excalidraw", "bookstack", "vikunja"];

/**
 * Probe the apps the slice depends on. Returns a verdict the runner can use
 * to decide whether to SKIP the slice or proceed.
 *
 * Slices other than `hard-app` always return {ok:true}.
 */
export async function slicePreflight(
  slice: string,
  opts: PreflightOptions = {},
): Promise<PreflightVerdict> {
  if (slice !== HARD_APP_SLICE_ID) return { ok: true };
  const env = opts.env ?? process.env;
  if (env.SKIP_SELF_HOSTED === "1") {
    return {
      ok: false,
      reason: "SKIP_SELF_HOSTED=1; slice intentionally skipped",
      skipped_apps: opts.apps ?? ALL_APPS,
    };
  }
  const apps = opts.apps ?? ALL_APPS;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const probes = await Promise.all(
    apps.map(async (app) => ({ app, up: await appIsReachable(app, { timeoutMs }) })),
  );
  const down = probes.filter((p) => !p.up).map((p) => p.app);
  if (down.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `apps not reachable: ${down.join(", ")} (see infra/docker/README.md or run \`make apps-up\`)`,
    skipped_apps: down,
  };
}
