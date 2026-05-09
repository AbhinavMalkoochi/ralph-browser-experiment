// Real Chrome smoke test. Runs in CI under `make test` and `npm test`.
//
// Boots Chrome, fetches /json/version, opens a CDP session, navigates to
// about:blank, then verifies the chrome process is reaped on close.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { launchChrome } from "../cdp/launch.js";
import { fetchVersion, fetchTargets, CdpSession } from "../cdp/client.js";

test("launches chrome, hits /json/version, navigates about:blank, exits clean", async () => {
  const chrome = await launchChrome();
  try {
    const version = await fetchVersion(chrome.port);
    assert.match(version.Browser, /Chrome|Chromium|HeadlessChrome/i);
    assert.ok(version["Protocol-Version"]);

    const targets = await fetchTargets(chrome.port);
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    assert.ok(page, "expected at least one page target");

    const session = await CdpSession.connect(page.webSocketDebuggerUrl as string);
    try {
      await session.send("Page.enable");
      await session.send("Page.navigate", { url: "about:blank" });
      const evalResult = (await session.send("Runtime.evaluate", {
        expression: "document.location.href",
        returnByValue: true,
      })) as { result: { value: string } };
      assert.equal(evalResult.result.value, "about:blank");
    } finally {
      await session.close();
    }
  } finally {
    await chrome.close();
  }

  // Verify no orphan: the spawned process should be reaped after close().
  // Give Node a tick to finalise the exit event.
  await delay(50);
  assert.notEqual(chrome.process.exitCode === null && chrome.process.signalCode === null, true);
});

test("temp user-data-dir is removed on close", async () => {
  const { stat } = await import("node:fs/promises");
  const chrome = await launchChrome();
  await chrome.close();
  await assert.rejects(() => stat(chrome.userDataDir));
});
