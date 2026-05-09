// Concrete BrowserSession built directly on the CDP launch + client modules.
//
// US-003 will replace this with a pooled implementation that supports
// snapshot/restore and crash-replace. For US-002 we just need a working
// session that can be handed to an Agent so the contract can be exercised
// end-to-end.

import { launchChrome, type ChromeHandle, type LaunchOptions } from "../cdp/launch.js";
import { CdpSession, fetchTargets } from "../cdp/client.js";
import type { BrowserSession } from "./types.js";

export interface CreateSessionOpts extends LaunchOptions {
  id?: string;
}

export class CdpBrowserSession implements BrowserSession {
  readonly id: string;
  readonly cdp: CdpSession;
  private readonly chrome: ChromeHandle;

  static async create(opts: CreateSessionOpts = {}): Promise<CdpBrowserSession> {
    const chrome = await launchChrome(opts);
    try {
      const targets = await fetchTargets(chrome.port);
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!page?.webSocketDebuggerUrl) {
        throw new Error("CDP /json reported no page target");
      }
      const cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
      await cdp.send("Page.enable");
      const id = opts.id ?? `session-${process.pid}-${chrome.port}`;
      return new CdpBrowserSession(id, chrome, cdp);
    } catch (err) {
      await chrome.close();
      throw err;
    }
  }

  private constructor(id: string, chrome: ChromeHandle, cdp: CdpSession) {
    this.id = id;
    this.chrome = chrome;
    this.cdp = cdp;
  }

  async navigate(url: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url });
    // Wait for the page-load event so subsequent evaluate() sees the new doc.
    // Page.navigate resolves immediately; we need a follow-up event.
    await this.waitForLoad();
  }

  private waitForLoad(timeoutMs = 5_000): Promise<void> {
    // CDP fires Page.loadEventFired; we use a short polling loop on
    // document.readyState as a portable fallback (avoids subscribing to events
    // through this minimal client).
    const start = Date.now();
    return new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`navigate: load timeout after ${timeoutMs}ms`));
          return;
        }
        this.cdp
          .send<{ result: { value: string } }>("Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true,
          })
          .then((r) => {
            if (r.result.value === "complete" || r.result.value === "interactive") resolve();
            else setTimeout(tick, 25);
          })
          .catch((err) => reject(err as Error));
      };
      tick();
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.cdp.send<{ result: { value: T; type: string }; exceptionDetails?: { text: string } }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    );
    if (r.exceptionDetails) {
      throw new Error(`evaluate threw: ${r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    return Buffer.from(r.data, "base64");
  }

  async close(): Promise<void> {
    await this.cdp.close();
    await this.chrome.close();
  }
}
