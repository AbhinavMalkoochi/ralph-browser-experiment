// `make smoke` entry point.
//
// Boots Chrome with --remote-debugging-port, fetches /json/version, opens a
// CDP session against the page target, navigates to about:blank, then exits 0.
// On exit it kills Chrome and removes the temp --user-data-dir.

import { launchChrome } from "./cdp/launch.js";
import { fetchVersion, fetchTargets, CdpSession } from "./cdp/client.js";

async function main(): Promise<void> {
  const start = Date.now();
  const chrome = await launchChrome();
  let exitCode = 0;
  try {
    const version = await fetchVersion(chrome.port);
    console.log(
      `[smoke] chrome up: ${version.Browser} (CDP ${version["Protocol-Version"]}) on port ${chrome.port}`,
    );

    const targets = await fetchTargets(chrome.port);
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) {
      throw new Error("no page target reported by /json");
    }
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      await session.send("Page.enable");
      await session.send("Page.navigate", { url: "about:blank" });
      const result = (await session.send("Runtime.evaluate", {
        expression: "document.location.href",
        returnByValue: true,
      })) as { result: { value: string } };
      const href = result.result.value;
      if (href !== "about:blank") {
        throw new Error(`expected about:blank, got ${href}`);
      }
      console.log(`[smoke] navigated to ${href}`);
    } finally {
      await session.close();
    }
  } catch (err) {
    exitCode = 1;
    console.error(`[smoke] FAILED: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
  } finally {
    await chrome.close();
  }
  const dur = Date.now() - start;
  if (exitCode === 0) {
    console.log(`[smoke] OK in ${dur}ms`);
  }
  process.exit(exitCode);
}

void main();
