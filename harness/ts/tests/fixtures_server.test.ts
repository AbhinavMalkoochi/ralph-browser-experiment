// Pure-HTTP tests for tasks/fixtures/server.ts. No Chrome involved — these
// are the cheap/fast tests; the Chrome-driven verifier behaviour lives in
// fixtures_sanity.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveFixtureUrl, startFixturesServer } from "../../../tasks/fixtures/server.js";
import { loadTaskFile } from "../verifier/loader.js";

test("fixtures server: each page returns 200 and the expected marker text", async () => {
  const server = await startFixturesServer();
  try {
    const shadow = await fetch(`${server.origin}/shadow-form`);
    assert.equal(shadow.status, 200);
    const shadowHtml = await shadow.text();
    assert.match(shadowHtml, /<shadow-form>/);
    assert.match(shadowHtml, /attachShadow\({ mode: 'open' }\)/);

    const canvas = await fetch(`${server.origin}/canvas-drag`);
    assert.equal(canvas.status, 200);
    const canvasHtml = await canvas.text();
    assert.match(canvasHtml, /<canvas id="board"/);
    assert.match(canvasHtml, /window\.__test/);

    const feed = await fetch(`${server.origin}/virtual-scroll`);
    assert.equal(feed.status, 200);
    const feedHtml = await feed.text();
    assert.match(feedHtml, /<div id="feed"/);
    assert.match(feedHtml, /target-247/);

    const modal = await fetch(`${server.origin}/modal-stack`);
    assert.equal(modal.status, 200);
    const modalHtml = await modal.text();
    assert.match(modalHtml, /id="m1"/);
    assert.match(modalHtml, /id="m2"/);
    assert.match(modalHtml, /id="m3"/);
    assert.match(modalHtml, /step1_done/);

    const cond = await fetch(`${server.origin}/conditional-form`);
    assert.equal(cond.status, 200);
    const condHtml = await cond.text();
    assert.match(condHtml, /id="step-1"/);
    assert.match(condHtml, /id="step-4"/);
    assert.match(condHtml, /__conditional\/submit/);

    const iframeParent = await fetch(`${server.origin}/iframe-drag`);
    assert.equal(iframeParent.status, 200);
    const iframeParentHtml = await iframeParent.text();
    assert.match(iframeParentHtml, /<iframe id="src"/);
    assert.match(iframeParentHtml, /<iframe id="dst"/);

    const iframeSource = await fetch(`${server.origin}/iframe-drag/source`);
    assert.equal(iframeSource.status, 200);
    assert.match(await iframeSource.text(), /data-id="beta"/);

    const iframeTarget = await fetch(`${server.origin}/iframe-drag/target`);
    assert.equal(iframeTarget.status, 200);
    assert.match(await iframeTarget.text(), /data-id="slot-2"/);
  } finally {
    await server.close();
  }
});

test("fixtures server: /__shadow round-trip stores and serves the latest receipt", async () => {
  const server = await startFixturesServer();
  try {
    const before = await (await fetch(`${server.origin}/__shadow/last`)).json();
    assert.deepEqual(before, {});

    const submitRes = await fetch(`${server.origin}/__shadow/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "alice@example.com", tier: "gold" }),
    });
    assert.equal(submitRes.status, 200);
    assert.deepEqual(await submitRes.json(), { ok: true });

    const after = await (await fetch(`${server.origin}/__shadow/last`)).json();
    assert.equal(after.username, "alice");
    assert.equal(after.email, "alice@example.com");
    assert.equal(after.tier, "gold");
    assert.match(String(after.receivedAt), /T.*Z$/);

    const reset = await fetch(`${server.origin}/__reset`, { method: "POST" });
    assert.equal(reset.status, 200);
    const cleared = await (await fetch(`${server.origin}/__shadow/last`)).json();
    assert.deepEqual(cleared, {});
  } finally {
    await server.close();
  }
});

test("fixtures server: rejects invalid shadow submissions with 400", async () => {
  const server = await startFixturesServer();
  try {
    const bad = await fetch(`${server.origin}/__shadow/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(bad.status, 400);
    const arr = await fetch(`${server.origin}/__shadow/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(arr.status, 400);
  } finally {
    await server.close();
  }
});

test("fixtures server: 404 for unknown path", async () => {
  const server = await startFixturesServer();
  try {
    const r = await fetch(`${server.origin}/no-such-page`);
    assert.equal(r.status, 404);
  } finally {
    await server.close();
  }
});

test("resolveFixtureUrl rewrites fixtures:// scheme; passes through everything else", () => {
  const origin = "http://127.0.0.1:8123";
  assert.equal(resolveFixtureUrl("fixtures://shadow-form", origin), `${origin}/shadow-form`);
  assert.equal(resolveFixtureUrl("fixtures:///canvas-drag", origin), `${origin}/canvas-drag`);
  assert.equal(resolveFixtureUrl("https://example.com/x", origin), "https://example.com/x");
  assert.equal(resolveFixtureUrl("about:blank", origin), "about:blank");
});

test("hard-slice yaml specs all load with valid programmatic verifiers", async () => {
  const root = process.cwd();
  const hardSpecs = [
    "shadow-form.yaml",
    "canvas-drag.yaml",
    "virtual-scroll.yaml",
    "modal-stack.yaml",
    "conditional-form.yaml",
    "iframe-drag.yaml",
  ];
  for (const file of hardSpecs) {
    const task = await loadTaskFile(join(root, "tasks/suite/hard", file));
    assert.equal(task.difficulty, "hard");
    assert.ok(task.tags.includes("hard"));
    assert.ok(task.tags.includes("fixtures"));
    assert.equal(task.verifier.kind, "js");
    assert.ok(task.start_url.startsWith("fixtures://"));
    if (task.verifier.kind === "js") {
      assert.ok(task.verifier.expression.length > 0);
    }
  }
});

test("fixtures server: /__conditional round-trip stores and serves the latest receipt; rejects bad path", async () => {
  const server = await startFixturesServer();
  try {
    const before = await (await fetch(`${server.origin}/__conditional/last`)).json();
    assert.deepEqual(before, {});

    const ok = await fetch(`${server.origin}/__conditional/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account_type: "personal",
        birth_year: "1995",
        email: "alice@example.com",
        country: "usa",
        ssn: "123-45-6789",
        path: [1, 2, 3, 4],
      }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });

    const after = await (await fetch(`${server.origin}/__conditional/last`)).json();
    assert.equal(after.account_type, "personal");
    assert.equal(after.birth_year, "1995");
    assert.equal(after.email, "alice@example.com");
    assert.equal(after.country, "usa");
    assert.equal(after.ssn, "123-45-6789");
    assert.deepEqual(after.path, [1, 2, 3, 4]);

    // Wrong country / id pairing must be rejected even though both fields
    // individually validate; the server cross-checks the path.
    const wrongPair = await fetch(`${server.origin}/__conditional/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account_type: "personal",
        birth_year: "1995",
        email: "alice@example.com",
        country: "canada",
        ssn: "123-45-6789",
        path: [1, 2, 3, 4],
      }),
    });
    assert.equal(wrongPair.status, 400);

    // Mismatched path is rejected even with otherwise-valid fields.
    const wrongPath = await fetch(`${server.origin}/__conditional/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account_type: "personal",
        birth_year: "1995",
        email: "alice@example.com",
        country: "usa",
        ssn: "123-45-6789",
        path: [1, 3, 2, 4],
      }),
    });
    assert.equal(wrongPath.status, 400);

    const reset = await fetch(`${server.origin}/__reset`, { method: "POST" });
    assert.equal(reset.status, 200);
    const cleared = await (await fetch(`${server.origin}/__conditional/last`)).json();
    assert.deepEqual(cleared, {});
  } finally {
    await server.close();
  }
});
