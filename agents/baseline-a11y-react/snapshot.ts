// Accessibility-style page snapshot.
//
// Walks the DOM via a single Runtime.evaluate, marks every interactive
// element with a stable `data-gba-aid` attribute, and returns a structured
// payload the ReAct loop can render to the LLM. Each interactive element
// surfaces its role, accessible name, type/value/placeholder, and a hint
// of nearby text — enough for the LLM to issue click/type/scroll/finish
// actions without having to author selectors.
//
// The snapshot script is tagged with a module-level constant so unit tests
// can match against it without re-deriving the source. The script is
// idempotent: re-running it preserves any aids already assigned, so action
// targets remain stable across consecutive snapshots within a step loop.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface InteractiveElement {
  /** Stable id assigned via data-gba-aid; same across snapshots. */
  aid: number;
  /** ARIA role (computed) or fallback to lowercase tag. */
  role: string;
  /** Best-effort accessible name (aria-label, label, text, alt, placeholder, value). */
  name: string;
  /** Lowercase tag name for disambiguation. */
  tag: string;
  /** Input type when applicable (text/email/checkbox/...). */
  type?: string;
  /** Current value for inputs/selects/textareas. */
  value?: string;
  /** Placeholder text for inputs/textareas. */
  placeholder?: string;
  /** Anchor href when applicable. */
  href?: string;
  /** Whether the element is currently visible (in-flow + non-zero size). */
  visible: boolean;
  /** Whether the element is disabled. */
  disabled: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** First N characters of body innerText, useful for extract tasks. */
  text: string;
  elements: InteractiveElement[];
  /** Approximate count of interactive nodes the snapshot considered. */
  scanned: number;
  /** Sequence number of this snapshot within the run. */
  seq: number;
}

/** Maximum chars of page text to include in the observation. */
export const SNAPSHOT_TEXT_LIMIT = 1200;
/** Maximum interactive elements to include in the observation. */
export const SNAPSHOT_ELEMENT_LIMIT = 60;

/**
 * Browser-side snapshot script. Pure JS expression that evaluates to a
 * JSON-serialisable PageSnapshot. Runs inside the page via
 * Runtime.evaluate (returnByValue=true). Assigns a monotonic integer to
 * `data-gba-aid` on each interactive element and remembers the next id
 * via `window.__gba_next_aid` so successive calls keep prior ids stable.
 *
 * Note: this is invoked as `(async () => { ... })()` by snapshotPage so
 * `awaitPromise=true` flows whatever the inner block returns. Keep the
 * inner block side-effect-deterministic: any randomness here would
 * destabilise diff-based debugging.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const TEXT_LIMIT = ${SNAPSHOT_TEXT_LIMIT};
  const ELEM_LIMIT = ${SNAPSHOT_ELEMENT_LIMIT};
  const INTERACTIVE_TAGS = new Set([
    "a", "button", "input", "select", "textarea", "summary",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "menuitem", "tab", "switch",
    "combobox", "textbox", "searchbox", "option", "treeitem",
  ]);
  function isVisible(el) {
    const style = el.ownerDocument && el.ownerDocument.defaultView
      ? el.ownerDocument.defaultView.getComputedStyle(el)
      : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
      return false;
    }
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
    if (tag === "label") return "label";
    return tag;
  }
  function getName(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\\s+/).filter(Boolean);
      const parts = [];
      for (const id of ids) {
        const ref = el.ownerDocument && el.ownerDocument.getElementById(id);
        if (ref && ref.textContent) parts.push(ref.textContent.trim());
      }
      if (parts.length) return parts.join(" ").trim();
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const id = el.id;
      if (id && el.ownerDocument) {
        const lab = el.ownerDocument.querySelector('label[for="' + id + '"]');
        if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim();
      }
      const ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return ph.trim();
    }
    if (el.tagName === "IMG") {
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim();
    }
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text) return text.length > 80 ? text.slice(0, 79) + "…" : text;
    const title = el.getAttribute && el.getAttribute("title");
    if (title) return title.trim();
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
      const tab = el.getAttribute("tabindex");
      if (tab !== null && tab !== "-1") return true;
    }
    return false;
  }
  if (typeof window.__gba_next_aid !== "number") window.__gba_next_aid = 1;
  if (typeof window.__gba_seq !== "number") window.__gba_seq = 0;
  window.__gba_seq += 1;
  const elements = [];
  let scanned = 0;
  const allEls = document.querySelectorAll("*");
  for (let i = 0; i < allEls.length && elements.length < ELEM_LIMIT; i++) {
    const el = allEls[i];
    if (!isInteractive(el)) continue;
    scanned += 1;
    let aid = el.getAttribute("data-gba-aid");
    if (!aid) {
      aid = String(window.__gba_next_aid++);
      el.setAttribute("data-gba-aid", aid);
    }
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getName(el);
    const visible = isVisible(el);
    const disabled = Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
    const item = {
      aid: Number(aid),
      role: role,
      name: name,
      tag: tag,
      visible: visible,
      disabled: disabled,
    };
    if (tag === "input" || tag === "textarea") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      item.type = t;
      const v = el.value;
      if (typeof v === "string") item.value = v.length > 80 ? v.slice(0, 79) + "…" : v;
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
  const text = (document.body && document.body.innerText
    ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, TEXT_LIMIT)
    : "");
  return {
    url: document.location ? document.location.href : "",
    title: document.title || "",
    text: text,
    elements: elements,
    scanned: scanned,
    seq: window.__gba_seq,
  };
})()`;

export async function snapshotPage(browser: BrowserSession): Promise<PageSnapshot> {
  return await browser.evaluate<PageSnapshot>(SNAPSHOT_SCRIPT);
}

/**
 * Render a snapshot as a compact text observation for the LLM. Format is
 * stable so the LLM's prompt cache + agent debug output can be diffed.
 */
export function formatSnapshot(s: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`URL: ${s.url}`);
  lines.push(`Title: ${s.title}`);
  if (s.text) lines.push(`Page text: ${truncate(s.text, 800)}`);
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
