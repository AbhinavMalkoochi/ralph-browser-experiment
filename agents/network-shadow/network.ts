// Network monkey-patch: replaces window.fetch and XMLHttpRequest with
// wrappers that record every call into window.__gba_net_log. The agent
// reads this log between steps to build its observation.
//
// Two install paths are used together:
//   (1) Page.addScriptToEvaluateOnNewDocument — covers every document
//       that the renderer creates after install (page navigations,
//       popups). The browser executes this BEFORE any in-document
//       script runs, so we see every fetch/XHR from the start.
//   (2) Runtime.evaluate — covers the currently-loaded document. The
//       harness navigates to start_url BEFORE agent.run() begins, so
//       without this path we would miss anything the page does after
//       initial paint but before the agent's first action.
//
// The patch is idempotent: a window.__gba_net_installed guard makes
// double-installs a no-op. log is capped to LOG_LIMIT entries with a
// FIFO drop policy so prompts stay bounded even on chatty pages.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface NetEntry {
  kind: "fetch" | "xhr";
  method: string;
  url: string;
  request_body: string | null;
  response_body: string | null;
  status: number | null;
  content_type: string | null;
  elapsed_ms: number | null;
  error: string | null;
  started_at: number;
}

export const LOG_LIMIT = 60;
export const BODY_LIMIT = 600;

/** JavaScript source of the monkey-patch. Wrapped in an IIFE; safe to eval twice. */
export const PATCH_SCRIPT = `(() => {
  if (typeof window === "undefined") return;
  if (window.__gba_net_installed) return;
  window.__gba_net_installed = true;
  if (!Array.isArray(window.__gba_net_log)) window.__gba_net_log = [];
  const LOG_LIMIT = ${LOG_LIMIT};
  const BODY_LIMIT = ${BODY_LIMIT};

  const push = (entry) => {
    const log = window.__gba_net_log;
    log.push(entry);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  };
  const trunc = (s) => {
    if (s == null) return null;
    if (typeof s !== "string") {
      try { s = JSON.stringify(s); } catch { s = String(s); }
    }
    return s.length > BODY_LIMIT ? s.slice(0, BODY_LIMIT) + "…" : s;
  };
  const resolveUrl = (u) => {
    try { return new URL(u, document.baseURI).pathname + (new URL(u, document.baseURI).search || ""); }
    catch { return String(u); }
  };

  if (typeof window.fetch === "function") {
    const origFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      const t0 = Date.now();
      let url, method, body;
      if (typeof input === "string") {
        url = input;
        method = (init && init.method) || "GET";
        body = (init && init.body) || null;
      } else if (input && typeof input === "object") {
        url = input.url || String(input);
        method = (init && init.method) || input.method || "GET";
        body = (init && init.body) || null;
      } else {
        url = String(input);
        method = "GET";
        body = null;
      }
      const entry = {
        kind: "fetch",
        method: String(method).toUpperCase(),
        url: resolveUrl(url),
        request_body: trunc(body),
        response_body: null,
        status: null,
        content_type: null,
        elapsed_ms: null,
        error: null,
        started_at: t0,
      };
      push(entry);
      try {
        const res = await origFetch(input, init);
        let bodyText = "";
        try {
          const c = res.clone();
          bodyText = await c.text();
        } catch (e) {
          bodyText = "(unreadable body)";
        }
        entry.status = res.status;
        entry.response_body = trunc(bodyText);
        entry.content_type = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
        entry.elapsed_ms = Date.now() - t0;
        return res;
      } catch (err) {
        entry.error = String(err && err.message ? err.message : err);
        entry.elapsed_ms = Date.now() - t0;
        throw err;
      }
    };
  }

  if (typeof window.XMLHttpRequest === "function") {
    const OrigXhr = window.XMLHttpRequest;
    function PatchedXhr() {
      const x = new OrigXhr();
      let method = "GET";
      let url = "";
      const origOpen = x.open.bind(x);
      x.open = function(m, u) {
        method = (m || "GET").toUpperCase();
        url = u;
        return origOpen.apply(x, arguments);
      };
      const origSend = x.send.bind(x);
      x.send = function(body) {
        const t0 = Date.now();
        const entry = {
          kind: "xhr",
          method: method,
          url: resolveUrl(url),
          request_body: trunc(body),
          response_body: null,
          status: null,
          content_type: null,
          elapsed_ms: null,
          error: null,
          started_at: t0,
        };
        push(entry);
        x.addEventListener("loadend", () => {
          entry.status = x.status;
          let bodyText;
          try { bodyText = typeof x.responseText === "string" ? x.responseText : "(non-text)"; }
          catch (e) { bodyText = "(unreadable)"; }
          entry.response_body = trunc(bodyText);
          entry.content_type = (x.getResponseHeader && x.getResponseHeader("content-type")) || "";
          entry.elapsed_ms = Date.now() - t0;
        });
        x.addEventListener("error", () => {
          entry.error = "xhr_error";
        });
        return origSend.apply(x, arguments);
      };
      return x;
    }
    PatchedXhr.prototype = OrigXhr.prototype;
    Object.setPrototypeOf(PatchedXhr, OrigXhr);
    window.XMLHttpRequest = PatchedXhr;
  }
})()`;

const READ_LOG_SCRIPT = `(() => {
  if (!Array.isArray(window.__gba_net_log)) return [];
  return window.__gba_net_log.slice();
})()`;

const CLEAR_LOG_SCRIPT = `(() => {
  if (Array.isArray(window.__gba_net_log)) window.__gba_net_log.length = 0;
  return true;
})()`;

/** Install the patch via BOTH addScriptToEvaluateOnNewDocument and current-document eval. */
export async function installPatch(browser: BrowserSession): Promise<void> {
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: PATCH_SCRIPT,
    });
  } catch {
    // Page domain may not be enabled on every session; the eval below still
    // covers the current document.
  }
  try {
    await browser.evaluate(PATCH_SCRIPT);
  } catch {
    // Page may be at about:blank or opaque origin; ignore — the patch
    // will be reinstalled on the next agent action.
  }
}

/** Read (and copy) the current network log from the page. */
export async function readNetLog(browser: BrowserSession): Promise<NetEntry[]> {
  try {
    const raw = await browser.evaluate<NetEntry[]>(READ_LOG_SCRIPT);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Clear the log (used between agent steps to give the LLM a focused tail). */
export async function clearNetLog(browser: BrowserSession): Promise<void> {
  try {
    await browser.evaluate(CLEAR_LOG_SCRIPT);
  } catch {
    // ignore
  }
}

/** Compact textual rendering of recent traffic for the LLM prompt. */
export function formatNetLog(entries: NetEntry[], limit = 12): string {
  if (entries.length === 0) return "(no traffic since last step)";
  const tail = entries.slice(-limit);
  const lines: string[] = [];
  for (const e of tail) {
    const status = e.status == null ? (e.error ? `err:${truncate(e.error, 40)}` : "pending") : String(e.status);
    const reqBody = e.request_body ? ` req=${truncate(e.request_body, 120)}` : "";
    const resBody = e.response_body ? ` res=${truncate(e.response_body, 200)}` : "";
    lines.push(`  ${e.method} ${truncate(e.url, 80)} → ${status}${reqBody}${resBody}`);
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (typeof s !== "string") s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
