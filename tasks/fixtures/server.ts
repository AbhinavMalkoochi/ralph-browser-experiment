// Hostile-fixtures HTTP server for the US-006 hard slice.
//
// Three deliberately brutal pages backed by a tiny http server (no Express dep):
//
//   GET  /shadow-form        Open shadow-root form. Submitting POSTs JSON to
//                            /__shadow/submit, which logs the payload server-side.
//   GET  /canvas-drag        Canvas-rendered diagram editor. Mouse events on the
//                            <canvas> drive node positions; final positions are
//                            written to window.__test for verification.
//   GET  /virtual-scroll     500-row virtualised infinite-scroll feed. Only ~20
//                            rows are mounted at any time; clicking a row's
//                            button writes the id to window.__test.clickedId.
//
//   POST /__shadow/submit    Records {username,email,tier} as the latest receipt.
//   GET  /__shadow/last      Returns the latest receipt as JSON ({} if none).
//   POST /__reset            Clears server-side state (used between tasks).
//   GET  /__health           Returns "ok" for liveness probes.
//
// startFixturesServer() spins the server up on an ephemeral 127.0.0.1 port and
// returns {origin, port, close, reset}. The eval CLI uses it to host the slice;
// tests use it to assert verifier behaviour without spawning a separate process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { SHADOW_FORM_HTML } from "./pages/shadow_form.js";
import { CANVAS_DRAG_HTML } from "./pages/canvas_drag.js";
import { VIRTUAL_SCROLL_HTML } from "./pages/virtual_scroll.js";

export interface FixturesServer {
  origin: string;
  port: number;
  close(): Promise<void>;
  reset(): Promise<void>;
}

export interface ShadowReceipt {
  username?: string;
  email?: string;
  tier?: string;
  receivedAt?: string;
}

interface FixtureState {
  lastShadowReceipt: ShadowReceipt;
}

function freshState(): FixtureState {
  return { lastShadowReceipt: {} };
}

export async function startFixturesServer(opts: { port?: number; host?: string } = {}): Promise<FixturesServer> {
  const host = opts.host ?? "127.0.0.1";
  const state: FixtureState = freshState();
  const server: Server = createServer((req, res) => {
    handleRequest(req, res, state).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`internal error: ${msg}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const addr = server.address() as AddressInfo;
  const origin = `http://${host}:${addr.port}`;
  return {
    origin,
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    reset: async () => {
      Object.assign(state, freshState());
    },
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, state: FixtureState): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const path = url.split("?")[0] ?? url;

  if (method === "GET" && path === "/__health") {
    return sendText(res, 200, "ok");
  }
  if (method === "POST" && path === "/__reset") {
    Object.assign(state, freshState());
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && (path === "/shadow-form" || path === "/shadow-form/")) {
    return sendHtml(res, SHADOW_FORM_HTML);
  }
  if (method === "GET" && (path === "/canvas-drag" || path === "/canvas-drag/")) {
    return sendHtml(res, CANVAS_DRAG_HTML);
  }
  if (method === "GET" && (path === "/virtual-scroll" || path === "/virtual-scroll/")) {
    return sendHtml(res, VIRTUAL_SCROLL_HTML);
  }

  if (method === "POST" && path === "/__shadow/submit") {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid json" });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return sendJson(res, 400, { ok: false, error: "expected object" });
    }
    const obj = parsed as Record<string, unknown>;
    state.lastShadowReceipt = {
      ...(typeof obj.username === "string" ? { username: obj.username } : {}),
      ...(typeof obj.email === "string" ? { email: obj.email } : {}),
      ...(typeof obj.tier === "string" ? { tier: obj.tier } : {}),
      receivedAt: new Date().toISOString(),
    };
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/__shadow/last") {
    return sendJson(res, 200, state.lastShadowReceipt);
  }

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    return sendHtml(
      res,
      `<!doctype html><html><head><title>fixtures</title></head><body>
<h1>general-browser fixtures</h1>
<ul>
<li><a href="/shadow-form">/shadow-form</a></li>
<li><a href="/canvas-drag">/canvas-drag</a></li>
<li><a href="/virtual-scroll">/virtual-scroll</a></li>
</ul></body></html>`,
    );
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Map a `fixtures://<path>` start_url to the live origin. Tasks under
 * tasks/suite/hard/ use this scheme so the YAML is portable across runs.
 */
export function resolveFixtureUrl(startUrl: string, origin: string): string {
  if (startUrl.startsWith("fixtures://")) {
    const rest = startUrl.slice("fixtures://".length);
    return `${origin}/${rest.replace(/^\/+/, "")}`;
  }
  return startUrl;
}
