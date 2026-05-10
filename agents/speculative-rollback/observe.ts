// Observation script for the speculative-rollback agent.
//
// Unlike baseline's a11y snapshot (integer aids on every interactive node),
// this agent prefers CSS selectors emitted by the LLM. The observation
// surfaces visible buttons/links/inputs with enough context (text, attributes,
// neighbouring labels) that the proposer LLM can author a stable selector
// in one shot. We do NOT tag elements with our own attributes — selectors
// must be derived from what is already in the DOM.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface PageObservation {
  url: string;
  title: string;
  /** First N chars of body innerText. */
  text: string;
  /** Visible buttons / links with selector hints. */
  buttons: Array<{
    tag: string;
    text: string;
    /** A best-effort CSS selector hint the LLM can copy-paste. */
    selector_hint: string;
  }>;
  /** Visible inputs / selects / textareas. */
  inputs: Array<{
    type: string;
    label: string;
    placeholder: string | null;
    selector_hint: string;
  }>;
  counts: {
    a: number;
    button: number;
    input: number;
    select: number;
    textarea: number;
    iframe: number;
    canvas: number;
    shadow_hosts: number;
    forms: number;
    modals: number;
  };
  /** Monotonic snapshot sequence (for trajectory debug). */
  seq: number;
}

export const OBS_TEXT_LIMIT = 1400;
export const OBS_BUTTONS_LIMIT = 25;
export const OBS_INPUTS_LIMIT = 20;

export const OBSERVE_SCRIPT = `(() => {
  const TEXT_LIMIT = ${OBS_TEXT_LIMIT};
  const BUTTONS_LIMIT = ${OBS_BUTTONS_LIMIT};
  const INPUTS_LIMIT = ${OBS_INPUTS_LIMIT};
  function visible(el) {
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    const s = w ? w.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) return false;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(r) && r.width > 0 && r.height > 0;
  }
  function cleanText(t) {
    return (t || "").replace(/\\s+/g, " ").trim();
  }
  function cssEscape(s) {
    return String(s).replace(/(["'\\\\])/g, "\\\\$1");
  }
  function selectorHintFor(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute && el.getAttribute("id");
    if (id) return tag + "#" + cssEscape(id);
    const name = el.getAttribute && el.getAttribute("name");
    if (name && (tag === "input" || tag === "textarea" || tag === "select" || tag === "button")) {
      return tag + "[name=\\\"" + cssEscape(name) + "\\\"]";
    }
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return tag + "[aria-label=\\\"" + cssEscape(aria) + "\\\"]";
    const cls = el.getAttribute && el.getAttribute("class");
    if (cls) {
      const first = cls.split(/\\s+/).filter(Boolean)[0];
      if (first) return tag + "." + cssEscape(first);
    }
    const type = el.getAttribute && el.getAttribute("type");
    if (type && tag === "input") return 'input[type="' + cssEscape(type) + '"]';
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href) return 'a[href="' + cssEscape(href) + '"]';
    }
    return tag;
  }
  function buttonText(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const txt = cleanText(el.textContent);
    if (txt) return txt.length > 80 ? txt.slice(0, 79) + "…" : txt;
    const v = el.value;
    if (typeof v === "string" && v.trim()) return v.trim();
    const title = el.getAttribute && el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  }
  function inputLabel(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    if (el.id) {
      const lab = el.ownerDocument && el.ownerDocument.querySelector('label[for="' + el.id + '"]');
      const lt = lab && cleanText(lab.textContent);
      if (lt) return lt;
    }
    const closeLab = el.closest && el.closest("label");
    if (closeLab) {
      const lt = cleanText(closeLab.textContent);
      if (lt) return lt;
    }
    const nm = el.getAttribute && el.getAttribute("name");
    if (nm) return nm;
    return "";
  }
  if (typeof window.__gba_specrb_seq !== "number") window.__gba_specrb_seq = 0;
  window.__gba_specrb_seq += 1;

  let shadowHosts = 0;
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) if (all[i].shadowRoot) shadowHosts += 1;
  const counts = {
    a: document.querySelectorAll("a").length,
    button: document.querySelectorAll("button").length,
    input: document.querySelectorAll("input").length,
    select: document.querySelectorAll("select").length,
    textarea: document.querySelectorAll("textarea").length,
    iframe: document.querySelectorAll("iframe").length,
    canvas: document.querySelectorAll("canvas").length,
    shadow_hosts: shadowHosts,
    forms: document.querySelectorAll("form").length,
    modals: document.querySelectorAll('[role="dialog"], dialog, .modal').length,
  };

  const buttons = [];
  const buttonNodes = document.querySelectorAll(
    'button, [role="button"], input[type="submit"], input[type="button"], a[href]'
  );
  for (let i = 0; i < buttonNodes.length && buttons.length < BUTTONS_LIMIT; i++) {
    const el = buttonNodes[i];
    if (!visible(el)) continue;
    const text = buttonText(el);
    if (!text) continue;
    buttons.push({
      tag: el.tagName.toLowerCase(),
      text: text,
      selector_hint: selectorHintFor(el),
    });
  }

  const inputs = [];
  const inputNodes = document.querySelectorAll("input, textarea, select, [contenteditable]");
  for (let i = 0; i < inputNodes.length && inputs.length < INPUTS_LIMIT; i++) {
    const el = inputNodes[i];
    if (!visible(el)) continue;
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "hidden" || t === "submit" || t === "button" || t === "reset") continue;
    }
    const type = el.tagName === "INPUT"
      ? (el.getAttribute("type") || "text").toLowerCase()
      : el.tagName.toLowerCase();
    const label = inputLabel(el);
    const ph = el.getAttribute && el.getAttribute("placeholder");
    inputs.push({
      type: type,
      label: label,
      placeholder: ph || null,
      selector_hint: selectorHintFor(el),
    });
  }

  const text = (document.body && document.body.innerText)
    ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, TEXT_LIMIT)
    : "";
  return {
    url: document.location ? document.location.href : "",
    title: document.title || "",
    text: text,
    buttons: buttons,
    inputs: inputs,
    counts: counts,
    seq: window.__gba_specrb_seq,
  };
})()`;

export async function observePage(browser: BrowserSession): Promise<PageObservation> {
  return await browser.evaluate<PageObservation>(OBSERVE_SCRIPT);
}

/** Compact rendering for the LLM prompt. Stable so prompt cache + diffs work. */
export function formatObservation(o: PageObservation): string {
  const lines: string[] = [];
  lines.push(`URL: ${o.url}`);
  lines.push(`Title: ${o.title}`);
  const c = o.counts;
  lines.push(
    `Counts: a=${c.a} button=${c.button} input=${c.input} select=${c.select} ` +
      `textarea=${c.textarea} iframe=${c.iframe} canvas=${c.canvas} ` +
      `shadow=${c.shadow_hosts} forms=${c.forms} modals=${c.modals}`,
  );
  if (o.text) lines.push(`Page text: ${truncate(o.text, 900)}`);
  if (o.buttons.length > 0) {
    lines.push(`Visible buttons/links (${o.buttons.length}):`);
    for (const b of o.buttons) {
      lines.push(`  <${b.tag}> "${truncate(b.text, 60)}"  selector_hint=${b.selector_hint}`);
    }
  }
  if (o.inputs.length > 0) {
    lines.push(`Visible inputs (${o.inputs.length}):`);
    for (const inp of o.inputs) {
      const lab = inp.label ? `label="${truncate(inp.label, 50)}"` : "(no label)";
      const ph = inp.placeholder ? ` placeholder="${truncate(inp.placeholder, 30)}"` : "";
      lines.push(`  type=${inp.type} ${lab}${ph} selector_hint=${inp.selector_hint}`);
    }
  }
  return lines.join("\n");
}

/** Stable single-line digest for the judge prompt + trajectory step. */
export function digestObservation(o: PageObservation): string {
  return (
    `seq=${o.seq} url=${truncate(o.url, 80)} title=${truncate(o.title, 60)} ` +
    `btns=${o.buttons.length} inputs=${o.inputs.length} ` +
    `text="${truncate(o.text, 200)}"`
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
