// Observation for the vision-som agent.
//
// Per step we walk the DOM in the page, find every visible *interactive*
// element whose bounding box intersects the viewport, assign each a fresh
// integer mark id (1..N), stamp the element with `data-gba-som-id="<N>"`,
// and inject an absolutely-positioned overlay div that draws a numbered
// red rectangle over each element. We then capture a JPEG of the viewport,
// remove the overlay, and return both the image and the mark table.
//
// Mark ids are FRESH every step (they are NOT reused across steps the way
// baseline-a11y-react's `data-gba-aid` is). The LLM only ever sees the
// marks visible in the current screenshot, so reusing prior ids would
// confuse it. The executor uses the same-step `data-gba-som-id`
// attribute to translate "click mark 7" back to a stable element handle.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface Mark {
  /** 1-based mark id matching the visible label in the screenshot. */
  id: number;
  /** ARIA role (computed) or fallback to lowercase tag. */
  role: string;
  /** Best-effort accessible name. */
  name: string;
  /** Lowercase tag name. */
  tag: string;
  /** Input type when applicable (text/email/checkbox/...). */
  type?: string;
  /** Current input/select value. */
  value?: string;
  /** Anchor href. */
  href?: string;
  /** Viewport-relative bounding box. */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface SomObservation {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** Sequence number for trajectory debug. */
  seq: number;
  /** JPEG bytes of the annotated viewport. */
  screenshot_jpeg: Buffer;
  /** Mark table; element behind mark[i] has data-gba-som-id="<id>". */
  marks: Mark[];
  /** Snippet of body text (helps the LLM disambiguate when marks are dense). */
  text: string;
}

let nextSeq = 0;

export const MARK_LIMIT = 50;
export const TEXT_LIMIT = 600;

/** Compact one-line digest for trajectory step records. */
export function digestObservation(obs: SomObservation): string {
  const u = obs.url.length > 80 ? obs.url.slice(0, 79) + "…" : obs.url;
  const kb = (obs.screenshot_jpeg.length / 1024).toFixed(1);
  return `[#${obs.seq}] ${obs.viewport.width}x${obs.viewport.height} url=${u} marks=${obs.marks.length} jpeg=${kb}KB`;
}

export function toDataUrl(obs: SomObservation): string {
  return `data:image/jpeg;base64,${obs.screenshot_jpeg.toString("base64")}`;
}

/** Compact text rendering of the mark table for the LLM prompt. */
export function formatMarks(marks: Mark[]): string {
  if (marks.length === 0) return "(no marks)";
  return marks
    .map((m) => {
      const meta: string[] = [m.role];
      if (m.tag !== m.role) meta.push(m.tag);
      if (m.type) meta.push(`type=${m.type}`);
      if (m.value) meta.push(`value=${JSON.stringify(truncate(m.value, 30))}`);
      if (m.href) meta.push(`href=${truncate(m.href, 60)}`);
      const name = m.name ? `"${truncate(m.name, 50)}"` : "(unnamed)";
      const bb = `bbox=${m.bbox.x},${m.bbox.y},${m.bbox.w}x${m.bbox.h}`;
      return `[${m.id}] ${meta.join(",")} ${name} ${bb}`;
    })
    .join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Browser-side script that:
 *   1. Removes any prior `__gba_som_overlay` container and clears prior
 *      `data-gba-som-id` attributes.
 *   2. Walks every element in the document, keeps the visible interactive
 *      ones whose bbox intersects the viewport.
 *   3. Stamps `data-gba-som-id="<N>"` on each (1-based, capped at MARK_LIMIT).
 *   4. Builds an overlay div (`<div id="__gba_som_overlay">`) appended to
 *      `<body>` containing one absolutely-positioned outline rect + one
 *      numbered label per mark.
 *   5. Returns `{url, title, viewport, marks, text}` for the harness to
 *      pair with the screenshot.
 */
export const COLLECT_SCRIPT = `(() => {
  const MARK_LIMIT = ${MARK_LIMIT};
  const TEXT_LIMIT = ${TEXT_LIMIT};
  const INTERACTIVE_TAGS = new Set([
    "a", "button", "input", "select", "textarea", "summary",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "menuitem", "tab", "switch",
    "combobox", "textbox", "searchbox", "option", "treeitem",
  ]);

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
  function intersectsViewport(r, vw, vh) {
    return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
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
    }
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text) return text.length > 80 ? text.slice(0, 79) + "…" : text;
    const title = el.getAttribute && el.getAttribute("title");
    if (title) return title.trim();
    const value = el.value;
    if (typeof value === "string" && value.trim()) return value.trim();
    return "";
  }

  // 1. Tear down anything left over from a prior step.
  const prior = document.getElementById("__gba_som_overlay");
  if (prior && prior.parentNode) prior.parentNode.removeChild(prior);
  const stamped = document.querySelectorAll("[data-gba-som-id]");
  for (let i = 0; i < stamped.length; i++) stamped[i].removeAttribute("data-gba-som-id");

  // 2. Pick the marks.
  const vw = Math.max(1, window.innerWidth || 800);
  const vh = Math.max(1, window.innerHeight || 600);
  const marks = [];
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length && marks.length < MARK_LIMIT; i++) {
    const el = all[i];
    if (!isInteractive(el)) continue;
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!intersectsViewport(r, vw, vh)) continue;
    const id = marks.length + 1;
    el.setAttribute("data-gba-som-id", String(id));
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getName(el);
    const item = {
      id: id,
      role: role,
      name: name,
      tag: tag,
      bbox: {
        x: Math.max(0, Math.round(r.left)),
        y: Math.max(0, Math.round(r.top)),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
    if (tag === "input" || tag === "textarea") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      item.type = t;
      const v = el.value;
      if (typeof v === "string") item.value = v.length > 80 ? v.slice(0, 79) + "…" : v;
    }
    if (tag === "select") {
      const v = el.value;
      if (typeof v === "string") item.value = v;
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href) item.href = href;
    }
    marks.push(item);
  }

  // 3. Inject overlay. position:fixed so the rectangles align with viewport
  // coords regardless of scroll. pointer-events:none so the overlay does not
  // capture clicks (we never click via the overlay anyway, but defence in
  // depth).
  const overlay = document.createElement("div");
  overlay.id = "__gba_som_overlay";
  overlay.setAttribute("style",
    "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483646");
  // Distinct colours per id improve readability when marks cluster.
  const palette = ["#e6194B","#3cb44b","#4363d8","#f58231","#911eb4","#42d4f4","#f032e6","#9A6324","#800000","#808000"];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const colour = palette[i % palette.length];
    const box = document.createElement("div");
    box.setAttribute("style",
      "position:absolute;left:" + m.bbox.x + "px;top:" + m.bbox.y + "px;" +
      "width:" + Math.max(1, m.bbox.w) + "px;height:" + Math.max(1, m.bbox.h) + "px;" +
      "outline:2px solid " + colour + ";outline-offset:-2px;background:transparent;");
    overlay.appendChild(box);
    const label = document.createElement("div");
    // Label sits at the top-left corner of the box, slightly above when there
    // is room, otherwise inside.
    const ly = m.bbox.y >= 16 ? m.bbox.y - 16 : m.bbox.y + 1;
    label.setAttribute("style",
      "position:absolute;left:" + m.bbox.x + "px;top:" + ly + "px;" +
      "background:" + colour + ";color:#fff;font:bold 12px/16px monospace;" +
      "padding:0 4px;border-radius:2px;white-space:nowrap;");
    label.textContent = String(m.id);
    overlay.appendChild(label);
  }
  document.body.appendChild(overlay);

  const text = (document.body && document.body.innerText
    ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, TEXT_LIMIT)
    : "");

  return {
    url: document.location ? document.location.href : "",
    title: document.title || "",
    viewport: { width: vw, height: vh },
    marks: marks,
    text: text,
  };
})()`;

export const REMOVE_SCRIPT = `(() => {
  const o = document.getElementById("__gba_som_overlay");
  if (o && o.parentNode) o.parentNode.removeChild(o);
  return true;
})()`;

interface CollectResult {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  marks: Mark[];
  text: string;
}

export interface ObservePageOpts {
  jpegQuality?: number;
}

export async function observePage(
  browser: BrowserSession,
  opts: ObservePageOpts = {},
): Promise<SomObservation> {
  const collected = await browser.evaluate<CollectResult>(COLLECT_SCRIPT);
  let screenshot: Buffer;
  try {
    const r = await browser.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "jpeg",
      quality: opts.jpegQuality ?? 70,
    });
    screenshot = Buffer.from(r.data, "base64");
  } finally {
    // Always tear the overlay down so the user-visible page is clean for the
    // next CDP action, even if the screenshot fails.
    await browser.evaluate(REMOVE_SCRIPT).catch(() => undefined);
  }

  nextSeq += 1;
  return {
    url: collected.url ?? "",
    title: collected.title ?? "",
    viewport: collected.viewport,
    seq: nextSeq,
    screenshot_jpeg: screenshot,
    marks: collected.marks ?? [],
    text: collected.text ?? "",
  };
}
