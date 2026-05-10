// Hostile-fixtures HTTP server.
//
// Backed by a tiny http server (no Express dep) and a set of deliberately
// brutal pages designed to defeat naive browser agents:
//
//   GET  /shadow-form        US-006: Open shadow-root form. Submit posts JSON
//                            to /__shadow/submit, which the server logs.
//   GET  /canvas-drag        US-006: Canvas-rendered diagram editor.
//   GET  /virtual-scroll     US-006: 500-row virtualised infinite-scroll feed.
//
//   GET  /modal-stack        US-007: Three nested modals navigated in a
//                            specific order; client-side state machine on
//                            window.__test.
//   GET  /conditional-form   US-007: Form whose validation rules change
//                            mid-stream based on prior field values. Submit
//                            posts JSON to /__conditional/submit; server
//                            cross-checks the path and stores the receipt.
//   GET  /iframe-drag        US-007: Two same-origin iframes, drag from one
//                            into the other. Source and target pages live at
//                            /iframe-drag/source and /iframe-drag/target.
//
//   GET  /late-hydration     US-008: SPA whose Confirm button has no real
//                            click handler for the first 1500ms.
//   GET  /multi-tab          US-008: Parent page that opens a popup at
//                            /multi-tab/report; popup posts a per-token
//                            access code back via opener.postMessage.
//   GET  /recoverable        US-008: Submit endpoint returns 500 once per
//                            session before succeeding on retry.
//   GET  /pdf-task           US-008: Page that points at /report.pdf and
//                            asks the agent to type the access code printed
//                            inside the PDF.
//   GET  /report.pdf         US-008: Minimal application/pdf containing
//                            "Quarterly access code is <session token>".
//
//   POST /__shadow/submit       Shadow-form receipt sink.
//   GET  /__shadow/last         Latest shadow receipt ({} if none).
//   POST /__conditional/submit  Conditional-form receipt sink with cross-check.
//   GET  /__conditional/last    Latest conditional receipt ({} if none).
//   POST /__hydration/submit    Late-hydration click receipt.
//   GET  /__hydration/last      Latest hydration receipt.
//   GET  /__multitab/report     Popup queries this for its session code.
//   POST /__multitab/submit     Parent page submits the typed code; cross-checked.
//   GET  /__multitab/last       Latest multi-tab receipt.
//   POST /__recoverable/submit  Returns 500 on first call per session, 200 after.
//   GET  /__recoverable/last    Latest recoverable receipt.
//   POST /__pdf/submit          Validates typed code against the PDF answer.
//   GET  /__pdf/last            Latest PDF receipt.
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
import { MODAL_STACK_HTML } from "./pages/modal_stack.js";
import { CONDITIONAL_FORM_HTML } from "./pages/conditional_form.js";
import {
  IFRAME_DRAG_PARENT_HTML,
  IFRAME_DRAG_SOURCE_HTML,
  IFRAME_DRAG_TARGET_HTML,
} from "./pages/iframe_drag.js";
import { LATE_HYDRATION_HTML } from "./pages/late_hydration.js";
import { MULTI_TAB_PARENT_HTML, MULTI_TAB_REPORT_HTML } from "./pages/multi_tab.js";
import { RECOVERABLE_HTML } from "./pages/recoverable.js";
import { PDF_TASK_HTML, buildAnswerPdf, randomAccessCode } from "./pages/pdf_task.js";

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

export interface ConditionalReceipt {
  account_type?: string;
  email?: string;
  country?: string;
  birth_year?: string;
  tax_id?: string;
  ssn?: string;
  sin?: string;
  rfc?: string;
  path?: number[];
  receivedAt?: string;
}

export interface HydrationReceipt {
  clickedAt?: number;
  hydratedAt?: number;
  attempts?: number;
  receivedAt?: string;
}

export interface MultiTabReceipt {
  ok?: boolean;
  token?: string;
  code?: string;
  receivedAt?: string;
}

export interface RecoverableReceipt {
  ok?: boolean;
  attempts?: number;
  receivedAt?: string;
}

export interface PdfReceipt {
  ok?: boolean;
  answer?: string;
  receivedAt?: string;
}

interface FixtureState {
  lastShadowReceipt: ShadowReceipt;
  lastConditionalReceipt: ConditionalReceipt;
  lastHydrationReceipt: HydrationReceipt;
  // Per-token expected access code for the multi-tab fixture. The popup
  // queries /__multitab/report?token=… and gets a token-scoped code; the
  // parent posts the typed code to /__multitab/submit and we cross-check.
  multitabCodes: Map<string, string>;
  lastMultitabReceipt: MultiTabReceipt;
  // Recoverable failure: the first POST per session returns 500, then we
  // succeed. recoverableAttempts counts requests so the verifier can
  // assert the agent retried at least once.
  recoverableAttempts: number;
  lastRecoverableReceipt: RecoverableReceipt;
  // PDF answer (regenerated on every reset so cached PDFs across sessions
  // don't leak). The HTML page does NOT see this directly — the answer is
  // only inside the PDF body served at /report.pdf.
  pdfAnswer: string;
  lastPdfReceipt: PdfReceipt;
}

function freshState(): FixtureState {
  return {
    lastShadowReceipt: {},
    lastConditionalReceipt: {},
    lastHydrationReceipt: {},
    multitabCodes: new Map(),
    lastMultitabReceipt: {},
    recoverableAttempts: 0,
    lastRecoverableReceipt: {},
    pdfAnswer: randomAccessCode(),
    lastPdfReceipt: {},
  };
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
  if (method === "GET" && (path === "/modal-stack" || path === "/modal-stack/")) {
    return sendHtml(res, MODAL_STACK_HTML);
  }
  if (method === "GET" && (path === "/conditional-form" || path === "/conditional-form/")) {
    return sendHtml(res, CONDITIONAL_FORM_HTML);
  }
  if (method === "GET" && (path === "/iframe-drag" || path === "/iframe-drag/")) {
    return sendHtml(res, IFRAME_DRAG_PARENT_HTML);
  }
  if (method === "GET" && path === "/iframe-drag/source") {
    return sendHtml(res, IFRAME_DRAG_SOURCE_HTML);
  }
  if (method === "GET" && path === "/iframe-drag/target") {
    return sendHtml(res, IFRAME_DRAG_TARGET_HTML);
  }
  if (method === "GET" && (path === "/late-hydration" || path === "/late-hydration/")) {
    return sendHtml(res, LATE_HYDRATION_HTML);
  }
  if (method === "GET" && (path === "/multi-tab" || path === "/multi-tab/")) {
    return sendHtml(res, MULTI_TAB_PARENT_HTML);
  }
  if (method === "GET" && path === "/multi-tab/report") {
    return sendHtml(res, MULTI_TAB_REPORT_HTML);
  }
  if (method === "GET" && (path === "/recoverable" || path === "/recoverable/")) {
    return sendHtml(res, RECOVERABLE_HTML);
  }
  if (method === "GET" && (path === "/pdf-task" || path === "/pdf-task/")) {
    return sendHtml(res, PDF_TASK_HTML);
  }
  if (method === "GET" && path === "/report.pdf") {
    return sendPdf(res, buildAnswerPdf(state.pdfAnswer));
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

  if (method === "POST" && path === "/__conditional/submit") {
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
    const result = validateConditionalSubmission(parsed as Record<string, unknown>);
    if (!result.ok) {
      return sendJson(res, 400, { ok: false, error: result.error });
    }
    state.lastConditionalReceipt = { ...result.receipt, receivedAt: new Date().toISOString() };
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/__conditional/last") {
    return sendJson(res, 200, state.lastConditionalReceipt);
  }

  if (method === "POST" && path === "/__hydration/submit") {
    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid json" });
    }
    state.lastHydrationReceipt = {
      ...(typeof parsed.clickedAt === "number" ? { clickedAt: parsed.clickedAt } : {}),
      ...(typeof parsed.hydratedAt === "number" ? { hydratedAt: parsed.hydratedAt } : {}),
      ...(typeof parsed.attempts === "number" ? { attempts: parsed.attempts } : {}),
      receivedAt: new Date().toISOString(),
    };
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/__hydration/last") {
    return sendJson(res, 200, state.lastHydrationReceipt);
  }

  if (method === "GET" && path === "/__multitab/report") {
    const u = new URL(url, "http://x");
    const token = u.searchParams.get("token") ?? "";
    if (!token) return sendJson(res, 400, { ok: false, error: "missing token" });
    let code = state.multitabCodes.get(token);
    if (!code) {
      code = randomAccessCode();
      state.multitabCodes.set(token, code);
    }
    return sendJson(res, 200, { ok: true, code });
  }
  if (method === "POST" && path === "/__multitab/submit") {
    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid json" });
    }
    const token = typeof parsed.token === "string" ? parsed.token : "";
    const code = typeof parsed.code === "string" ? parsed.code : "";
    const expected = state.multitabCodes.get(token);
    if (!expected) return sendJson(res, 400, { ok: false, error: "unknown token" });
    if (code !== expected) {
      state.lastMultitabReceipt = {
        ok: false,
        token,
        code,
        receivedAt: new Date().toISOString(),
      };
      return sendJson(res, 400, { ok: false, error: "code mismatch" });
    }
    state.lastMultitabReceipt = {
      ok: true,
      token,
      code,
      receivedAt: new Date().toISOString(),
    };
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/__multitab/last") {
    return sendJson(res, 200, state.lastMultitabReceipt);
  }

  if (method === "POST" && path === "/__recoverable/submit") {
    state.recoverableAttempts++;
    if (state.recoverableAttempts === 1) {
      // Deliberate transient failure on first attempt only.
      return sendJson(res, 500, { ok: false, error: "upstream temporarily unavailable" });
    }
    state.lastRecoverableReceipt = {
      ok: true,
      attempts: state.recoverableAttempts,
      receivedAt: new Date().toISOString(),
    };
    return sendJson(res, 200, { ok: true, attempts: state.recoverableAttempts });
  }
  if (method === "GET" && path === "/__recoverable/last") {
    return sendJson(res, 200, state.lastRecoverableReceipt);
  }

  if (method === "POST" && path === "/__pdf/submit") {
    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid json" });
    }
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    const matches = answer.length > 0 && answer === state.pdfAnswer;
    state.lastPdfReceipt = {
      ok: matches,
      answer,
      receivedAt: new Date().toISOString(),
    };
    if (!matches) return sendJson(res, 400, { ok: false, error: "wrong code" });
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/__pdf/last") {
    return sendJson(res, 200, state.lastPdfReceipt);
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
<li><a href="/modal-stack">/modal-stack</a></li>
<li><a href="/conditional-form">/conditional-form</a></li>
<li><a href="/iframe-drag">/iframe-drag</a></li>
<li><a href="/late-hydration">/late-hydration</a></li>
<li><a href="/multi-tab">/multi-tab</a></li>
<li><a href="/recoverable">/recoverable</a></li>
<li><a href="/pdf-task">/pdf-task</a> (<a href="/report.pdf">report.pdf</a>)</li>
</ul></body></html>`,
    );
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

interface ConditionalValidation {
  ok: boolean;
  error?: string;
  receipt: ConditionalReceipt;
}

const COND_RULES = {
  birth_year: (v: string): boolean =>
    /^\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= 2010,
  tax_id: (v: string): boolean => /^\d{2}-\d{7}$/.test(v),
  email: (v: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  ssn: (v: string): boolean => /^\d{3}-\d{2}-\d{4}$/.test(v),
  sin: (v: string): boolean => /^\d{9}$/.test(v),
  rfc: (v: string): boolean => /^[A-Z]{4}\d{6}[A-Z0-9]{3}$/.test(v),
};

function validateConditionalSubmission(obj: Record<string, unknown>): ConditionalValidation {
  const account_type = obj.account_type;
  if (account_type !== "personal" && account_type !== "business") {
    return { ok: false, error: "account_type must be personal|business", receipt: {} };
  }
  const email = obj.email;
  if (typeof email !== "string" || !COND_RULES.email(email)) {
    return { ok: false, error: "invalid email", receipt: {} };
  }
  const country = obj.country;
  if (country !== "usa" && country !== "canada" && country !== "mexico") {
    return { ok: false, error: "country must be usa|canada|mexico", receipt: {} };
  }
  const path = obj.path;
  if (!Array.isArray(path) || path.length !== 4 || path.some((s, i) => s !== i + 1)) {
    return { ok: false, error: "path must be [1,2,3,4]", receipt: {} };
  }
  const receipt: ConditionalReceipt = { account_type, email, country, path: path as number[] };
  if (account_type === "personal") {
    const birth_year = obj.birth_year;
    if (typeof birth_year !== "string" || !COND_RULES.birth_year(birth_year)) {
      return { ok: false, error: "invalid birth_year", receipt: {} };
    }
    if (typeof obj.tax_id === "string" && obj.tax_id.length > 0) {
      return { ok: false, error: "tax_id not allowed for personal accounts", receipt: {} };
    }
    receipt.birth_year = birth_year;
  } else {
    const tax_id = obj.tax_id;
    if (typeof tax_id !== "string" || !COND_RULES.tax_id(tax_id)) {
      return { ok: false, error: "invalid tax_id", receipt: {} };
    }
    if (typeof obj.birth_year === "string" && obj.birth_year.length > 0) {
      return { ok: false, error: "birth_year not allowed for business accounts", receipt: {} };
    }
    receipt.tax_id = tax_id;
  }
  if (country === "usa") {
    const ssn = obj.ssn;
    if (typeof ssn !== "string" || !COND_RULES.ssn(ssn)) {
      return { ok: false, error: "invalid ssn", receipt: {} };
    }
    receipt.ssn = ssn;
  } else if (country === "canada") {
    const sin = obj.sin;
    if (typeof sin !== "string" || !COND_RULES.sin(sin)) {
      return { ok: false, error: "invalid sin", receipt: {} };
    }
    receipt.sin = sin;
  } else {
    const rfc = obj.rfc;
    if (typeof rfc !== "string" || !COND_RULES.rfc(rfc)) {
      return { ok: false, error: "invalid rfc", receipt: {} };
    }
    receipt.rfc = rfc;
  }
  return { ok: true, receipt };
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

function sendPdf(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, {
    "content-type": "application/pdf",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
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
