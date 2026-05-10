// Compact page observation for runtime-codegen.
//
// Unlike the baseline a11y snapshot, this does NOT mark interactive elements
// with aids. The LLM authors raw JS that resolves elements however it likes
// (querySelector, shadowRoot traversal, contentDocument across same-origin
// iframes, text matching). The observation just gives it a structural map
// to reason about: where the shadow hosts are, how many iframes exist, what
// the body text says, what input fields/buttons are around.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface PageObservation {
  url: string;
  title: string;
  /** First N chars of body innerText. */
  text: string;
  /** Same-doc iframe descriptors. */
  frames: Array<{
    src: string;
    id: string | null;
    name: string | null;
    sameOrigin: boolean;
  }>;
  /** Tag-name → count for interesting structural tags. */
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
  };
  /** Visible buttons & links: text + tag — helps the LLM pick selectors. */
  buttons: Array<{ tag: string; text: string }>;
  /** Visible input labels: from <label for=…>, aria-label, or placeholder. */
  inputs: Array<{ type: string; label: string; placeholder: string | null }>;
  /** Sequence number incremented every observe(). */
  seq: number;
}

export const OBS_TEXT_LIMIT = 1500;
export const OBS_BUTTONS_LIMIT = 30;
export const OBS_INPUTS_LIMIT = 20;
export const OBS_FRAMES_LIMIT = 8;

export const OBSERVE_SCRIPT = `(() => {
  const TEXT_LIMIT = ${OBS_TEXT_LIMIT};
  const BUTTONS_LIMIT = ${OBS_BUTTONS_LIMIT};
  const INPUTS_LIMIT = ${OBS_INPUTS_LIMIT};
  const FRAMES_LIMIT = ${OBS_FRAMES_LIMIT};
  function visible(el) {
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    const s = w ? w.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) return false;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(r) && r.width > 0 && r.height > 0;
  }
  function buttonText(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text) return text.length > 80 ? text.slice(0, 79) + "…" : text;
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
      if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim();
    }
    const closeLab = el.closest && el.closest("label");
    if (closeLab && closeLab.textContent && closeLab.textContent.trim()) {
      return closeLab.textContent.trim();
    }
    const nm = el.getAttribute && el.getAttribute("name");
    if (nm) return nm;
    return "";
  }
  if (typeof window.__gba_codegen_seq !== "number") window.__gba_codegen_seq = 0;
  window.__gba_codegen_seq += 1;
  const all = document.querySelectorAll("*");
  let shadowHosts = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i].shadowRoot) shadowHosts += 1;
  }
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
  };
  const buttons = [];
  const buttonNodes = document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[href]');
  for (let i = 0; i < buttonNodes.length && buttons.length < BUTTONS_LIMIT; i++) {
    const el = buttonNodes[i];
    if (!visible(el)) continue;
    const text = buttonText(el);
    if (!text) continue;
    buttons.push({ tag: el.tagName.toLowerCase(), text: text });
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
    inputs.push({ type: type, label: label, placeholder: ph || null });
  }
  const frameNodes = document.querySelectorAll("iframe");
  const frames = [];
  for (let i = 0; i < frameNodes.length && frames.length < FRAMES_LIMIT; i++) {
    const el = frameNodes[i];
    let sameOrigin = false;
    try {
      const cd = el.contentDocument;
      sameOrigin = Boolean(cd);
    } catch (_e) {
      sameOrigin = false;
    }
    frames.push({
      src: el.getAttribute("src") || "",
      id: el.getAttribute("id") || null,
      name: el.getAttribute("name") || null,
      sameOrigin: sameOrigin,
    });
  }
  const text = (document.body && document.body.innerText)
    ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, TEXT_LIMIT)
    : "";
  return {
    url: document.location ? document.location.href : "",
    title: document.title || "",
    text: text,
    frames: frames,
    counts: counts,
    buttons: buttons,
    inputs: inputs,
    seq: window.__gba_codegen_seq,
  };
})()`;

export async function observePage(browser: BrowserSession): Promise<PageObservation> {
  return await browser.evaluate<PageObservation>(OBSERVE_SCRIPT);
}

/** Compact text rendering of the observation for the LLM prompt. */
export function formatObservation(o: PageObservation): string {
  const lines: string[] = [];
  lines.push(`URL: ${o.url}`);
  lines.push(`Title: ${o.title}`);
  const c = o.counts;
  lines.push(
    `Counts: a=${c.a} button=${c.button} input=${c.input} select=${c.select} ` +
      `textarea=${c.textarea} iframe=${c.iframe} canvas=${c.canvas} ` +
      `shadow_hosts=${c.shadow_hosts} forms=${c.forms}`,
  );
  if (o.text) lines.push(`Page text: ${truncate(o.text, 1000)}`);
  if (o.frames.length > 0) {
    lines.push(`Iframes (${o.frames.length}):`);
    for (const f of o.frames) {
      const same = f.sameOrigin ? "same-origin" : "cross-origin";
      lines.push(
        `  src=${truncate(f.src || "(blank)", 80)} id=${f.id ?? "-"} name=${f.name ?? "-"} ${same}`,
      );
    }
  }
  if (o.buttons.length > 0) {
    lines.push(`Visible buttons/links (${o.buttons.length}):`);
    for (const b of o.buttons) {
      lines.push(`  <${b.tag}> "${truncate(b.text, 70)}"`);
    }
  }
  if (o.inputs.length > 0) {
    lines.push(`Visible inputs (${o.inputs.length}):`);
    for (const inp of o.inputs) {
      const lab = inp.label ? `label="${truncate(inp.label, 60)}"` : "(no label)";
      const ph = inp.placeholder ? ` placeholder="${truncate(inp.placeholder, 40)}"` : "";
      lines.push(`  type=${inp.type} ${lab}${ph}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
