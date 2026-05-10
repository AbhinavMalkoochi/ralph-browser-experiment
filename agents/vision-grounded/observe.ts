// Observation for the vision-grounded agent.
//
// Deliberately MINIMAL: just URL, page title, viewport size, and the JPEG
// screenshot bytes. No DOM walk, no a11y tree, no element list, no Set-of-
// Marks overlays. The LLM has to localise targets in PIXELS using the image
// alone — that constraint is the whole point of the mechanism.
//
// We use JPEG (not PNG) at quality=70 so a single ~800x600 viewport is
// roughly 30-60 KB, keeping the OpenAI vision token bill reasonable.

import type { BrowserSession } from "../../harness/ts/agent/types.js";

export interface VisionObservation {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** Sequence number for trajectory debug. */
  seq: number;
  /** JPEG bytes — pass straight into a base64 data URL. */
  screenshot_jpeg: Buffer;
}

let nextSeq = 0;

export interface ObservePageOpts {
  /** Override viewport size. Defaults to the live page's window dimensions. */
  viewport?: { width: number; height: number };
  jpegQuality?: number;
}

export async function observePage(
  browser: BrowserSession,
  opts: ObservePageOpts = {},
): Promise<VisionObservation> {
  const meta = await browser.evaluate<{
    url: string;
    title: string;
    width: number;
    height: number;
  }>(`(() => ({
    url: location.href,
    title: document.title || "",
    width: Math.round(window.innerWidth) || 800,
    height: Math.round(window.innerHeight) || 600,
  }))()`);

  const viewport = opts.viewport ?? { width: meta.width, height: meta.height };
  const quality = opts.jpegQuality ?? 70;
  const r = await browser.cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "jpeg",
    quality,
  });
  const screenshot = Buffer.from(r.data, "base64");

  nextSeq += 1;
  return {
    url: meta.url ?? "",
    title: meta.title ?? "",
    viewport,
    seq: nextSeq,
    screenshot_jpeg: screenshot,
  };
}

/** Compact one-line digest for trajectory step records. */
export function digestObservation(obs: VisionObservation): string {
  const u = obs.url.length > 100 ? obs.url.slice(0, 99) + "…" : obs.url;
  const kb = (obs.screenshot_jpeg.length / 1024).toFixed(1);
  return `[#${obs.seq}] ${obs.viewport.width}x${obs.viewport.height} url=${u} jpeg=${kb}KB`;
}

/** Build a base64 data URL the OpenAI vision endpoint accepts. */
export function toDataUrl(obs: VisionObservation): string {
  return `data:image/jpeg;base64,${obs.screenshot_jpeg.toString("base64")}`;
}
