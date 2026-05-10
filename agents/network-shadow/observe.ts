// Page observation for the network-shadow agent.
//
// The agent's primary signal is the network log; the page observation is
// kept minimal — URL, title, a short body-text snippet, and visible
// buttons/forms — only enough to (a) let the LLM compose a `click`
// fallback when no API path is visible, and (b) name the page in the
// system prompt.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface PageObservation {
  url: string;
  title: string;
  text: string;
  buttons: Array<{ tag: string; text: string; selector_hint: string }>;
  forms: Array<{ action: string; method: string; fields: string[] }>;
  counts: {
    a: number;
    button: number;
    form: number;
    input: number;
    iframe: number;
  };
  seq: number;
}

const TEXT_LIMIT = 1200;
const BUTTONS_LIMIT = 16;
const FORMS_LIMIT = 6;

const OBSERVE_SCRIPT = `(() => {
  const TEXT_LIMIT = ${TEXT_LIMIT};
  const BUTTONS_LIMIT = ${BUTTONS_LIMIT};
  const FORMS_LIMIT = ${FORMS_LIMIT};
  function visible(el) {
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    const s = w ? w.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) return false;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(r) && r.width > 0 && r.height > 0;
  }
  function clean(t) { return (t || "").replace(/\\s+/g, " ").trim(); }
  function cssEscape(s) { return String(s).replace(/(["'\\\\])/g, "\\\\$1"); }
  function hint(el) {
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
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href) return 'a[href="' + cssEscape(href) + '"]';
    }
    return tag;
  }
  function buttonText(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const txt = clean(el.textContent);
    if (txt) return txt.length > 60 ? txt.slice(0, 59) + "…" : txt;
    const v = el.value;
    if (typeof v === "string" && v.trim()) return v.trim();
    return "";
  }
  if (typeof window.__gba_net_seq !== "number") window.__gba_net_seq = 0;
  window.__gba_net_seq += 1;

  const counts = {
    a: document.querySelectorAll("a").length,
    button: document.querySelectorAll("button").length,
    form: document.querySelectorAll("form").length,
    input: document.querySelectorAll("input").length,
    iframe: document.querySelectorAll("iframe").length,
  };
  const buttons = [];
  const buttonNodes = document.querySelectorAll(
    'button, [role="button"], input[type="submit"], input[type="button"], a[href]'
  );
  for (let i = 0; i < buttonNodes.length && buttons.length < BUTTONS_LIMIT; i++) {
    const el = buttonNodes[i];
    if (!visible(el)) continue;
    const t = buttonText(el);
    if (!t) continue;
    buttons.push({ tag: el.tagName.toLowerCase(), text: t, selector_hint: hint(el) });
  }
  const forms = [];
  const formNodes = document.querySelectorAll("form");
  for (let i = 0; i < formNodes.length && forms.length < FORMS_LIMIT; i++) {
    const f = formNodes[i];
    const action = f.getAttribute("action") || "";
    const method = (f.getAttribute("method") || "GET").toUpperCase();
    const fields = [];
    const inputs = f.querySelectorAll("input[name], textarea[name], select[name]");
    for (let j = 0; j < inputs.length && fields.length < 20; j++) {
      const inp = inputs[j];
      const nm = inp.getAttribute("name");
      if (nm) fields.push(nm);
    }
    forms.push({ action: action, method: method, fields: fields });
  }
  const text = (document.body && document.body.innerText)
    ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, TEXT_LIMIT)
    : "";
  return {
    url: document.location ? document.location.href : "",
    title: document.title || "",
    text: text,
    buttons: buttons,
    forms: forms,
    counts: counts,
    seq: window.__gba_net_seq,
  };
})()`;

export async function observePage(browser: BrowserSession): Promise<PageObservation> {
  return await browser.evaluate<PageObservation>(OBSERVE_SCRIPT);
}

export function formatObservation(o: PageObservation): string {
  const lines: string[] = [];
  lines.push(`URL: ${o.url}`);
  lines.push(`Title: ${o.title}`);
  lines.push(
    `Counts: a=${o.counts.a} button=${o.counts.button} form=${o.counts.form} input=${o.counts.input} iframe=${o.counts.iframe}`,
  );
  if (o.text) lines.push(`Page text: ${truncate(o.text, 700)}`);
  if (o.forms.length > 0) {
    lines.push(`Forms (${o.forms.length}):`);
    for (const f of o.forms) {
      lines.push(`  action="${f.action}" method=${f.method} fields=[${f.fields.join(", ")}]`);
    }
  }
  if (o.buttons.length > 0) {
    lines.push(`Visible buttons/links (${o.buttons.length}):`);
    for (const b of o.buttons) {
      lines.push(`  <${b.tag}> "${truncate(b.text, 50)}"  selector_hint=${b.selector_hint}`);
    }
  }
  return lines.join("\n");
}

export function digestObservation(o: PageObservation): string {
  return (
    `seq=${o.seq} url=${truncate(o.url, 80)} title=${truncate(o.title, 60)} ` +
    `forms=${o.forms.length} btns=${o.buttons.length}`
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
