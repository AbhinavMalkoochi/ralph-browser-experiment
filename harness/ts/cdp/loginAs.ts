// loginAs helper for the hard-app slice (US-027).
//
// Pre-authenticates a CdpBrowserSession against one of the self-hosted apps
// so the agent.run() loop starts already logged in. Approach is
// app-specific:
//
//   - gitea:      POST the /user/login form via in-page fetch; Chrome's
//                 cookie jar captures the session cookie.
//   - vikunja:    POST /api/v1/login, capture the JWT, set it in
//                 localStorage under the keys the Vikunja SPA expects.
//   - bookstack:  GET /login to grab a CSRF token, then POST /login with
//                 the form including the token.
//   - excalidraw: no-op (no auth).
//
// The function navigates to the app origin first so subsequent
// localStorage / cookie writes target the correct origin. Returns once
// the auth state is established. Throws on any HTTP error so the caller
// can SKIP_AUTH the cell instead of running an effectively-unauthenticated
// agent.

import type { CdpBrowserSession } from "../agent/browser_session.js";

export type HardAppId = "gitea" | "excalidraw" | "bookstack" | "vikunja";

export interface LoginCredentials {
  user: string;
  password: string;
  /** Override base URL; defaults to http://127.0.0.1:<DEFAULT_PORTS[app]>. */
  origin?: string;
}

/** Host-mapped ports the docker-compose.yml binds (mirror infra/docker/.env.example). */
export const DEFAULT_PORTS: Record<HardAppId, number> = {
  gitea: 3001,
  excalidraw: 3002,
  bookstack: 3003,
  vikunja: 3004,
};

export function defaultOrigin(app: HardAppId): string {
  const port = DEFAULT_PORTS[app];
  return `http://127.0.0.1:${port}`;
}

export function credentialsFromEnv(app: HardAppId, env: NodeJS.ProcessEnv = process.env): LoginCredentials {
  const port = Number(env[`GBA_${app.toUpperCase()}_PORT`] ?? DEFAULT_PORTS[app]);
  const origin = `http://127.0.0.1:${port}`;
  const userKey = `GBA_${app.toUpperCase()}_USER`;
  const passKey = `GBA_${app.toUpperCase()}_PASSWORD`;
  const user = env[userKey] ?? defaultUser(app);
  const password = env[passKey] ?? "agent-correct-horse-battery-staple";
  return { user, password, origin };
}

function defaultUser(app: HardAppId): string {
  if (app === "bookstack") return "agent@example.invalid";
  return "agent";
}

/**
 * Pre-authenticate `session` against the named app. The session's CDP
 * Network domain MUST be enabled by the caller before calling this (so
 * Set-Cookie headers are honoured by Chrome's cookie jar).
 */
export async function loginAs(
  session: CdpBrowserSession,
  app: HardAppId,
  creds?: LoginCredentials,
): Promise<void> {
  const c = { ...credentialsFromEnv(app), ...(creds ?? {}) };
  const origin = c.origin ?? defaultOrigin(app);
  if (app === "excalidraw") {
    // No auth, but seed an origin context so a verifier can read
    // localStorage with a non-opaque origin.
    await session.navigate(`${origin}/`);
    return;
  }
  if (app === "gitea") return loginGitea(session, origin, c);
  if (app === "vikunja") return loginVikunja(session, origin, c);
  if (app === "bookstack") return loginBookstack(session, origin, c);
  // Exhaustiveness: TS should make this unreachable.
  throw new Error(`unknown app id: ${app as string}`);
}

async function loginGitea(
  session: CdpBrowserSession,
  origin: string,
  creds: LoginCredentials,
): Promise<void> {
  // Navigate to the login page first so in-page fetch targets the right origin.
  await session.navigate(`${origin}/user/login`);
  // Gitea's /user/login form expects _csrf, user_name, password.
  // The token lives in a meta tag and in a hidden input.
  const expr = `
    (async () => {
      const m = document.querySelector('meta[name="_csrf"]');
      const inp = document.querySelector('input[name="_csrf"]');
      const csrf = (m && m.content) || (inp && inp.value) || '';
      const body = new URLSearchParams({
        _csrf: csrf,
        user_name: ${JSON.stringify(creds.user)},
        password: ${JSON.stringify(creds.password)},
        remember: 'on',
      });
      const resp = await fetch('/user/login', {
        method: 'POST',
        body,
        credentials: 'include',
        redirect: 'follow',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      });
      // Gitea redirects to '/' on success and leaves us on /user/login (with
      // a flash message) on failure. Sniff the response URL.
      const ok = !resp.url.includes('/user/login') && resp.status < 400;
      return { ok, status: resp.status, final_url: resp.url };
    })();
  `;
  const r = await session.evaluate<{ ok: boolean; status: number; final_url: string }>(expr);
  if (!r || !r.ok) {
    throw new Error(`loginAs(gitea) failed: status=${r?.status} url=${r?.final_url}`);
  }
}

async function loginVikunja(
  session: CdpBrowserSession,
  origin: string,
  creds: LoginCredentials,
): Promise<void> {
  // Navigate to the SPA origin so localStorage writes target the right URL.
  await session.navigate(`${origin}/`);
  const expr = `
    (async () => {
      const resp = await fetch('/api/v1/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: ${JSON.stringify(creds.user)}, password: ${JSON.stringify(creds.password)}}),
      });
      if (!resp.ok) return {ok:false, status: resp.status};
      const j = await resp.json();
      const token = (j && j.token) || '';
      if (!token) return {ok:false, status: resp.status, missing_token: true};
      // The Vikunja Vue SPA stores its token under 'token'. Mirror that.
      try { localStorage.setItem('token', token); } catch (_) {}
      return {ok:true, status: resp.status};
    })();
  `;
  const r = await session.evaluate<{ ok: boolean; status: number; missing_token?: boolean }>(expr);
  if (!r || !r.ok) {
    throw new Error(`loginAs(vikunja) failed: status=${r?.status}${r?.missing_token ? " missing_token" : ""}`);
  }
}

async function loginBookstack(
  session: CdpBrowserSession,
  origin: string,
  creds: LoginCredentials,
): Promise<void> {
  await session.navigate(`${origin}/login`);
  const expr = `
    (async () => {
      // BookStack's CSRF token sits in a hidden input with name="_token"
      // and a meta tag <meta name="token" content="...">.
      const inp = document.querySelector('input[name="_token"]');
      const m = document.querySelector('meta[name="token"]');
      const csrf = (inp && inp.value) || (m && m.content) || '';
      const body = new URLSearchParams({
        _token: csrf,
        email: ${JSON.stringify(creds.user)},
        password: ${JSON.stringify(creds.password)},
      });
      const resp = await fetch('/login', {
        method: 'POST',
        body,
        credentials: 'include',
        redirect: 'follow',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      });
      const ok = !resp.url.includes('/login') && resp.status < 400;
      return { ok, status: resp.status, final_url: resp.url };
    })();
  `;
  const r = await session.evaluate<{ ok: boolean; status: number; final_url: string }>(expr);
  if (!r || !r.ok) {
    throw new Error(`loginAs(bookstack) failed: status=${r?.status} url=${r?.final_url}`);
  }
}

/**
 * Probe an app's HTTP health endpoint without spawning a browser. Returns
 * true on a 2xx/3xx response within `timeoutMs`. Used by the tournament
 * preflight to decide whether to SKIP the hard-app slice.
 */
export async function appIsReachable(
  app: HardAppId,
  opts: { origin?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const origin = opts.origin ?? defaultOrigin(app);
  const timeoutMs = opts.timeoutMs ?? 1500;
  const path = healthPath(app);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${origin}${path}`, { signal: ac.signal, redirect: "manual" });
    // BookStack/Gitea redirect to /login on the root; that's still healthy.
    if (resp.status >= 200 && resp.status < 400) return true;
    // 401/403 also indicates "service responding"; we just lack creds for the probe.
    if (resp.status === 401 || resp.status === 403) return true;
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function healthPath(app: HardAppId): string {
  switch (app) {
    case "gitea":
      return "/api/healthz";
    case "vikunja":
      return "/api/v1/info";
    case "bookstack":
      return "/login";
    case "excalidraw":
      return "/";
  }
}

/**
 * Map a task's tags array to its app id, or null if the task is not an
 * app-bound task. Tags use the convention `app:<id>` (e.g. `app:gitea`).
 */
export function appFromTags(tags: readonly string[]): HardAppId | null {
  for (const t of tags) {
    if (!t.startsWith("app:")) continue;
    const id = t.slice("app:".length) as HardAppId;
    if (id === "gitea" || id === "excalidraw" || id === "bookstack" || id === "vikunja") {
      return id;
    }
  }
  return null;
}
