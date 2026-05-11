// DOM mutation observer + lightweight interactive-element snapshot.
//
// The observer is installed via BOTH
//   (1) Page.addScriptToEvaluateOnNewDocument — covers every document the
//       renderer creates after install (navigations, popups), running
//       before any in-document script.
//   (2) Runtime.evaluate — covers the currently-loaded document, since the
//       harness has already navigated to start_url before agent.run().
//
// The install is idempotent: a window-level __gba_dom_installed flag
// short-circuits double-installs. The mutation buffer is capped FIFO
// at LOG_LIMIT entries; each entry carries a strictly-monotonic `seq`
// so the agent can ask "what's new since seq=X".
//
// Element snapshotting reuses baseline's aid-tagging idea (stable
// data-* integer ids), but uses a distinct attribute name
// (data-gba-stream-aid) so multiple agents in the same harness run
// don't collide. The snapshot is intentionally tiny — the LLM's main
// observation source is the mutation stream, not the snapshot.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface MutationEntry {
  /** Monotonic id assigned by the in-page observer. */
  seq: number;
  /** Wall-clock millis when the mutation fired (page side). */
  t: number;
  /** Kind of mutation. */
  kind: "added" | "removed" | "attr" | "text";
  /** Human-readable rendering of the target (tag#id{text}, or @aid=N). */
  target: string;
  /** For added/removed: rendering of the added/removed node itself. */
  node?: string;
  /** Lowercase tag name of the added/removed node (or "#text" / "#N"). */
  tag?: string;
  /** Attribute name (kind=attr only). */
  attr?: string;
  /** Old value (attr/text). */
  oldv?: string | null;
  /** New value (attr/text). */
  newv?: string | null;
}

export interface MutationSlice {
  entries: MutationEntry[];
  currentSeq: number;
}

export interface InteractiveElement {
  aid: number;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  visible: boolean;
  disabled: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** First N chars of body innerText. */
  text: string;
  elements: InteractiveElement[];
  /** Count of interactive nodes considered. */
  scanned: number;
  /** Monotonic snapshot sequence. */
  seq: number;
}

export const LOG_LIMIT = 200;
export const VALUE_LIMIT = 40;
export const TEXT_LIMIT = 1200;
export const ELEMENT_LIMIT = 50;
export const DEFAULT_AWAIT_MS = 600;
export const SETTLE_MS = 400;

/**
 * JavaScript source of the mutation observer install. Wrapped in an IIFE;
 * safe to eval twice (the second call no-ops). Pushes one entry per
 * mutation record into window.__gba_dom_log with a monotonic seq.
 */
export const INSTALL_SCRIPT = `(() => {
  if (typeof window === "undefined") return;
  if (window.__gba_dom_installed) return;
  window.__gba_dom_installed = true;
  if (!Array.isArray(window.__gba_dom_log)) window.__gba_dom_log = [];
  if (typeof window.__gba_dom_seq !== "number") window.__gba_dom_seq = 0;
  const LOG_LIMIT = ${LOG_LIMIT};
  const VALUE_LIMIT = ${VALUE_LIMIT};

  const trunc = (s, n) => {
    if (s == null) return null;
    let str;
    try { str = typeof s === "string" ? s : String(s); } catch { return null; }
    if (str.length <= n) return str;
    return str.slice(0, n - 1) + "…";
  };
  const tagOf = (n) => {
    if (!n) return "?";
    if (n.nodeType === 1 && n.tagName) return n.tagName.toLowerCase();
    if (n.nodeType === 3) return "#text";
    return "#" + (n.nodeType || "?");
  };
  const nameOf = (n) => {
    if (!n) return "?";
    if (n.nodeType !== 1) return tagOf(n);
    const t = (n.tagName || "?").toLowerCase();
    const aid = n.getAttribute && n.getAttribute("data-gba-stream-aid");
    if (aid) return "@aid=" + aid;
    const id = n.id ? "#" + n.id : "";
    const aria = n.getAttribute && n.getAttribute("aria-label");
    if (aria) return t + id + "[" + trunc(aria, 30) + "]";
    const text = ((n.textContent || "") + "").replace(/\\s+/g, " ").trim();
    if (text) return t + id + "{" + trunc(text, 50) + "}";
    return t + id;
  };
  const push = (entry) => {
    window.__gba_dom_seq += 1;
    entry.seq = window.__gba_dom_seq;
    entry.t = Date.now();
    const log = window.__gba_dom_log;
    log.push(entry);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  };

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "childList") {
        const parent = nameOf(r.target);
        if (r.addedNodes && r.addedNodes.length) {
          for (let i = 0; i < r.addedNodes.length; i++) {
            const n = r.addedNodes[i];
            push({ kind: "added", target: parent, node: nameOf(n), tag: tagOf(n) });
          }
        }
        if (r.removedNodes && r.removedNodes.length) {
          for (let i = 0; i < r.removedNodes.length; i++) {
            const n = r.removedNodes[i];
            push({ kind: "removed", target: parent, node: nameOf(n), tag: tagOf(n) });
          }
        }
      } else if (r.type === "attributes") {
        let cur = null;
        try { cur = r.target && r.target.getAttribute ? r.target.getAttribute(r.attributeName) : null; }
        catch { cur = null; }
        if (r.oldValue === cur) continue;
        push({
          kind: "attr",
          target: nameOf(r.target),
          attr: r.attributeName,
          oldv: trunc(r.oldValue, VALUE_LIMIT),
          newv: trunc(cur, VALUE_LIMIT),
        });
      } else if (r.type === "characterData") {
        push({
          kind: "text",
          target: nameOf(r.target && r.target.parentNode),
          oldv: trunc(r.oldValue, VALUE_LIMIT),
          newv: trunc(r.target && r.target.data, VALUE_LIMIT),
        });
      }
    }
  });

  const start = () => {
    if (!document.documentElement) return false;
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true,
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  if (!start()) {
    if (document.addEventListener) {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    }
  }
  window.__gba_dom_observer = observer;
})()`;

const READ_SLICE_SCRIPT = (since: number) =>
  `(() => {
  const log = Array.isArray(window.__gba_dom_log) ? window.__gba_dom_log : [];
  const SINCE = ${JSON.stringify(since)};
  const entries = [];
  for (let i = 0; i < log.length; i++) {
    if (log[i] && typeof log[i].seq === "number" && log[i].seq > SINCE) entries.push(log[i]);
  }
  return { entries: entries, currentSeq: window.__gba_dom_seq || 0 };
})()`;

const READ_CURRENT_SEQ_SCRIPT = `(() => window.__gba_dom_seq || 0)()`;

const CLEAR_SCRIPT = `(() => {
  if (Array.isArray(window.__gba_dom_log)) window.__gba_dom_log.length = 0;
  return true;
})()`;

const AWAIT_CHANGE_SCRIPT = (since: number, timeoutMs: number) =>
  `(() => new Promise((resolve) => {
  const SINCE = ${JSON.stringify(since)};
  const TIMEOUT = ${JSON.stringify(timeoutMs)};
  const start = Date.now();
  const check = () => {
    const cur = window.__gba_dom_seq || 0;
    if (cur > SINCE) {
      resolve({ changed: true, newSeq: cur, elapsed: Date.now() - start });
      return;
    }
    if (Date.now() - start >= TIMEOUT) {
      resolve({ changed: false, newSeq: cur, elapsed: Date.now() - start });
      return;
    }
    setTimeout(check, 25);
  };
  check();
}))()`;

/**
 * Settle script: like awaitChange, but additionally waits for the
 * mutation stream to QUIESCE (no new mutations for `quietMs`) up to
 * `timeoutMs` total. Used to let the page finish reacting before the
 * agent re-observes.
 */
const SETTLE_SCRIPT = (since: number, timeoutMs: number, quietMs: number) =>
  `(() => new Promise((resolve) => {
  const SINCE = ${JSON.stringify(since)};
  const TIMEOUT = ${JSON.stringify(timeoutMs)};
  const QUIET = ${JSON.stringify(quietMs)};
  const start = Date.now();
  let lastSeq = SINCE;
  let lastChangeAt = start;
  const tick = () => {
    const now = Date.now();
    const cur = window.__gba_dom_seq || 0;
    if (cur > lastSeq) {
      lastSeq = cur;
      lastChangeAt = now;
    }
    const elapsed = now - start;
    const quietFor = now - lastChangeAt;
    if (cur > SINCE && quietFor >= QUIET) {
      resolve({ changed: true, newSeq: cur, elapsed: elapsed });
      return;
    }
    if (elapsed >= TIMEOUT) {
      resolve({ changed: cur > SINCE, newSeq: cur, elapsed: elapsed });
      return;
    }
    setTimeout(tick, 25);
  };
  tick();
}))()`;

const SNAPSHOT_SCRIPT = `(() => {
  const TEXT_LIMIT = ${TEXT_LIMIT};
  const ELEMENT_LIMIT = ${ELEMENT_LIMIT};
  const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "menuitem", "tab", "switch",
    "combobox", "textbox", "searchbox", "option", "treeitem",
  ]);
  function visible(el) {
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    const s = w ? w.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) return false;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(r) && r.width > 0 && r.height > 0;
  }
  function getRole(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.getAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "summary") return "button";
    return tag;
  }
  function getName(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const id = el.id;
      if (id && el.ownerDocument) {
        const lab = el.ownerDocument.querySelector('label[for="' + id + '"]');
        if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim();
      }
      const ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return ph.trim();
      const nm = el.getAttribute("name");
      if (nm && nm.trim()) return nm.trim();
    }
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text) return text.length > 60 ? text.slice(0, 59) + "…" : text;
    const title = el.getAttribute && el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    const value = el.value;
    if (typeof value === "string" && value.trim()) return value.trim();
    return "";
  }
  function isInteractive(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute && el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
    if (el.hasAttribute && el.hasAttribute("contenteditable")) return true;
    if (typeof el.onclick === "function") return true;
    if (el.hasAttribute && el.hasAttribute("tabindex")) {
      const t = el.getAttribute("tabindex");
      if (t !== null && t !== "-1") return true;
    }
    return false;
  }
  if (typeof window.__gba_stream_next_aid !== "number") window.__gba_stream_next_aid = 1;
  if (typeof window.__gba_stream_seq !== "number") window.__gba_stream_seq = 0;
  window.__gba_stream_seq += 1;

  const elements = [];
  let scanned = 0;
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length && elements.length < ELEMENT_LIMIT; i++) {
    const el = all[i];
    if (!isInteractive(el)) continue;
    scanned += 1;
    let aid = el.getAttribute("data-gba-stream-aid");
    if (!aid) {
      aid = String(window.__gba_stream_next_aid++);
      el.setAttribute("data-gba-stream-aid", aid);
    }
    const tag = el.tagName.toLowerCase();
    const item = {
      aid: Number(aid),
      role: getRole(el),
      name: getName(el),
      tag: tag,
      visible: visible(el),
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
    };
    if (tag === "input" || tag === "textarea") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      item.type = t;
      const v = el.value;
      if (typeof v === "string") item.value = v.length > 60 ? v.slice(0, 59) + "…" : v;
      const ph = el.getAttribute("placeholder");
      if (ph) item.placeholder = ph;
    }
    if (tag === "select") {
      const v = el.value;
      if (typeof v === "string") item.value = v;
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href) item.href = href;
    }
    elements.push(item);
  }
  const text = (document.body && document.body.innerText)
    ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, TEXT_LIMIT)
    : "";
  return {
    url: document.location ? document.location.href : "",
    title: document.title || "",
    text: text,
    elements: elements,
    scanned: scanned,
    seq: window.__gba_stream_seq,
  };
})()`;

/** Install the mutation observer via BOTH addScriptToEvaluateOnNewDocument and current-doc eval. */
export async function installObserver(browser: BrowserSession): Promise<void> {
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: INSTALL_SCRIPT,
    });
  } catch {
    // Page domain may not be enabled; the eval below still covers the
    // current document.
  }
  try {
    await browser.evaluate(INSTALL_SCRIPT);
  } catch {
    // Opaque origins (data:) may throw on observer.observe; the install
    // script catches this internally, so a re-throw here is unexpected.
    // Either way the observer reinstalls on the next navigate.
  }
}

export async function readMutations(
  browser: BrowserSession,
  since: number,
): Promise<MutationSlice> {
  try {
    const raw = await browser.evaluate<MutationSlice>(READ_SLICE_SCRIPT(since));
    if (raw && Array.isArray(raw.entries) && typeof raw.currentSeq === "number") {
      return raw;
    }
    return { entries: [], currentSeq: 0 };
  } catch {
    return { entries: [], currentSeq: 0 };
  }
}

export async function readCurrentSeq(browser: BrowserSession): Promise<number> {
  try {
    const seq = await browser.evaluate<number>(READ_CURRENT_SEQ_SCRIPT);
    return typeof seq === "number" ? seq : 0;
  } catch {
    return 0;
  }
}

export async function clearMutations(browser: BrowserSession): Promise<void> {
  try {
    await browser.evaluate(CLEAR_SCRIPT);
  } catch {
    // ignore
  }
}

export interface AwaitResult {
  changed: boolean;
  newSeq: number;
  elapsed: number;
}

/** Block in-page until a new mutation arrives or `timeoutMs` elapses. */
export async function awaitChange(
  browser: BrowserSession,
  since: number,
  timeoutMs: number,
): Promise<AwaitResult> {
  const clampedTimeout = Math.max(0, Math.min(10_000, timeoutMs));
  try {
    const r = await browser.evaluate<AwaitResult>(AWAIT_CHANGE_SCRIPT(since, clampedTimeout));
    if (r && typeof r.changed === "boolean") return r;
    return { changed: false, newSeq: since, elapsed: clampedTimeout };
  } catch {
    return { changed: false, newSeq: since, elapsed: clampedTimeout };
  }
}

/**
 * Wait until at least one mutation has occurred AND the stream has
 * been quiet for `quietMs`, or until `timeoutMs` elapses. Used after
 * state-changing actions so the LLM observes a SETTLED post-action
 * state, not a transient mid-reaction view.
 */
export async function settleAfter(
  browser: BrowserSession,
  since: number,
  timeoutMs: number = SETTLE_MS,
  quietMs: number = 75,
): Promise<AwaitResult> {
  const clampedTimeout = Math.max(0, Math.min(5_000, timeoutMs));
  const clampedQuiet = Math.max(0, Math.min(1_000, quietMs));
  try {
    const r = await browser.evaluate<AwaitResult>(
      SETTLE_SCRIPT(since, clampedTimeout, clampedQuiet),
    );
    if (r && typeof r.changed === "boolean") return r;
    return { changed: false, newSeq: since, elapsed: clampedTimeout };
  } catch {
    return { changed: false, newSeq: since, elapsed: clampedTimeout };
  }
}

export async function snapshotPage(browser: BrowserSession): Promise<PageSnapshot> {
  return await browser.evaluate<PageSnapshot>(SNAPSHOT_SCRIPT);
}

/** Compact textual rendering of the page snapshot for the LLM prompt. */
export function formatSnapshot(s: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`URL: ${s.url}`);
  lines.push(`Title: ${s.title}`);
  if (s.text) lines.push(`Page text: ${truncate(s.text, 600)}`);
  if (s.elements.length === 0) {
    lines.push("Interactive elements: (none)");
  } else {
    lines.push(`Interactive elements (${s.elements.length} of ${s.scanned} scanned):`);
    for (const e of s.elements) {
      lines.push("  " + formatElement(e));
    }
  }
  return lines.join("\n");
}

export function formatElement(e: InteractiveElement): string {
  const parts: string[] = [`[${e.aid}]`, e.role];
  const name = e.name ? `"${truncate(e.name, 60)}"` : "(unnamed)";
  parts.push(name);
  const meta: string[] = [];
  if (e.tag !== e.role) meta.push(e.tag);
  if (e.type) meta.push(`type=${e.type}`);
  if (e.value) meta.push(`value=${JSON.stringify(truncate(e.value, 40))}`);
  if (e.placeholder) meta.push(`placeholder=${JSON.stringify(truncate(e.placeholder, 40))}`);
  if (e.href) meta.push(`href=${truncate(e.href, 80)}`);
  if (e.disabled) meta.push("disabled");
  if (!e.visible) meta.push("hidden");
  if (meta.length) parts.push(`(${meta.join(", ")})`);
  return parts.join(" ");
}

/** Digest the snapshot for trajectory step's observation_summary. */
export function digestSnapshot(s: PageSnapshot, mutationCount: number): string {
  return (
    `url=${truncate(s.url, 80)} title=${JSON.stringify(truncate(s.title, 40))} ` +
    `elements=${s.elements.length} mutations_since_last=${mutationCount}`
  );
}

/** Compact textual rendering of a mutation slice for the LLM prompt. */
export function formatMutations(entries: MutationEntry[], limit = 30): string {
  if (entries.length === 0) return "(no DOM changes since last action)";
  const tail = entries.slice(-limit);
  const lines: string[] = [];
  for (const e of tail) {
    lines.push("  " + renderMutation(e));
  }
  const head =
    entries.length > tail.length
      ? `(${entries.length - tail.length} earlier omitted)\n`
      : "";
  return head + lines.join("\n");
}

export function renderMutation(e: MutationEntry): string {
  switch (e.kind) {
    case "added":
      return `+ ${e.tag ?? "?"} ${truncate(e.node ?? "?", 60)} into ${truncate(e.target, 50)}`;
    case "removed":
      return `- ${e.tag ?? "?"} ${truncate(e.node ?? "?", 60)} from ${truncate(e.target, 50)}`;
    case "attr":
      return `~ ${truncate(e.target, 50)} ${e.attr ?? "?"}: ${jsonish(e.oldv)} → ${jsonish(e.newv)}`;
    case "text":
      return `t ${truncate(e.target, 50)}: ${jsonish(e.oldv)} → ${jsonish(e.newv)}`;
  }
}

function jsonish(v: string | null | undefined): string {
  if (v == null) return "∅";
  return JSON.stringify(truncate(v, 40));
}

function truncate(s: string, n: number): string {
  if (typeof s !== "string") s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
