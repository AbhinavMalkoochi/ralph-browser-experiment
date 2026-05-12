// Browser-layer auth injection for the hard-auth slice (US-028).
//
// Tasks under tasks/suite/hard-auth/ declare `requires_env` + an optional
// `auth` spec. The runner reads the listed env vars; if any are unset the
// cell is SKIPPED. Otherwise we set cookies (Network.setCookie) and/or
// extra HTTP headers (Page.setExtraHTTPHeaders) BEFORE navigate, so the
// agent sees an already-authenticated browser and never reads the secret.
//
// Value templates use `${ENV_VAR}` placeholders; substitution happens here
// at the harness/CDP boundary. Plain values pass through unchanged.

import type { CdpBrowserSession } from "../agent/browser_session.js";
import type { AuthCookieSpec, AuthSpec, Task } from "../verifier/types.js";

/**
 * Well-known secret env vars used by hard-auth tasks. defaultClient() in
 * harness/ts/llm/client.ts redacts any of these that are set in process.env
 * from outbound error messages, so a leaked API token in a stack trace
 * doesn't end up in a committed trajectory.
 */
export const KNOWN_AUTH_ENV_VARS: readonly string[] = [
  "GITHUB_PAT",
  "GITHUB_SANDBOX_REPO",
  "HF_TOKEN",
  "HF_TEST_REPO",
  "NPM_AUTH_TOKEN",
  "NPM_SANDBOX_PACKAGE",
];

/** Env vars listed in `requires_env` that are not present (or empty) in `env`. */
export function missingEnv(task: Task, env: NodeJS.ProcessEnv = process.env): string[] {
  const required = task.requires_env ?? [];
  return required.filter((name) => {
    const v = env[name];
    return v === undefined || v === "";
  });
}

/** Substitute `${VAR}` occurrences from `env`. Missing vars yield ``. */
export function substituteEnv(template: string, env: NodeJS.ProcessEnv = process.env): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => env[name] ?? "");
}

/** Sensitive values that should be redacted from any trajectory / error text. */
export function authSecretValues(task: Task, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const name of task.requires_env ?? []) {
    const v = env[name];
    if (v && v.length >= 4) out.add(v);
  }
  return [...out];
}

/**
 * Apply the task's auth spec to the live session BEFORE navigate. Caller
 * must have enabled the CDP `Network` domain (Page is enabled by default
 * for CdpBrowserSession). Throws on any CDP error.
 */
export async function injectAuth(
  session: CdpBrowserSession,
  spec: AuthSpec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (spec.headers && Object.keys(spec.headers).length > 0) {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.headers)) resolved[k] = substituteEnv(v, env);
    await session.cdp.send("Network.setExtraHTTPHeaders", { headers: resolved });
  }
  if (spec.cookies && spec.cookies.length > 0) {
    const cookies = spec.cookies.map((c) => cdpCookie(c, env));
    await session.cdp.send("Network.setCookies", { cookies });
  }
}

function cdpCookie(c: AuthCookieSpec, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: c.name,
    value: substituteEnv(c.value, env),
    domain: c.domain,
    path: c.path ?? "/",
  };
  if (c.secure !== undefined) out.secure = c.secure;
  if (c.httpOnly !== undefined) out.httpOnly = c.httpOnly;
  if (c.sameSite !== undefined) out.sameSite = c.sameSite;
  return out;
}
