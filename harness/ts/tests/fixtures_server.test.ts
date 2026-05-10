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

    const hydration = await fetch(`${server.origin}/late-hydration`);
    assert.equal(hydration.status, 200);
    const hydrationHtml = await hydration.text();
    assert.match(hydrationHtml, /id="confirm"/);
    assert.match(hydrationHtml, /HYDRATION_DELAY_MS/);

    const multitab = await fetch(`${server.origin}/multi-tab`);
    assert.equal(multitab.status, 200);
    const multitabHtml = await multitab.text();
    assert.match(multitabHtml, /id="open-report"/);
    assert.match(multitabHtml, /id="code-input"/);
    const reportTab = await fetch(`${server.origin}/multi-tab/report?token=tok-x`);
    assert.equal(reportTab.status, 200);
    assert.match(await reportTab.text(), /report-code/);

    const recov = await fetch(`${server.origin}/recoverable`);
    assert.equal(recov.status, 200);
    const recovHtml = await recov.text();
    assert.match(recovHtml, /id="submit-btn"/);
    assert.match(recovHtml, /__recoverable\/submit/);

    const pdfTask = await fetch(`${server.origin}/pdf-task`);
    assert.equal(pdfTask.status, 200);
    const pdfTaskHtml = await pdfTask.text();
    assert.match(pdfTaskHtml, /id="report-link"/);
    assert.match(pdfTaskHtml, /id="answer-input"/);

    const pdf = await fetch(`${server.origin}/report.pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBytes.subarray(0, 5).toString("utf8"), "%PDF-");
    // Check the trailer exists (basic structural sanity).
    assert.match(pdfBytes.toString("utf8"), /%%EOF/);
    // The PDF body should contain the access code marker.
    assert.match(pdfBytes.toString("utf8"), /Quarterly access code is [A-Z2-9]{8}/);
  } finally {
    await server.close();
  }
});

test("fixtures server: /__hydration round-trip", async () => {
  const server = await startFixturesServer();
  try {
    const before = await (await fetch(`${server.origin}/__hydration/last`)).json();
    assert.deepEqual(before, {});
    const submit = await fetch(`${server.origin}/__hydration/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clickedAt: 2000, hydratedAt: 1500, attempts: 0 }),
    });
    assert.equal(submit.status, 200);
    const after = await (await fetch(`${server.origin}/__hydration/last`)).json();
    assert.equal(after.clickedAt, 2000);
    assert.equal(after.hydratedAt, 1500);
    assert.equal(after.attempts, 0);
    assert.match(String(after.receivedAt), /T.*Z$/);
  } finally {
    await server.close();
  }
});

test("fixtures server: /__multitab round-trip; rejects mismatched code and unknown token", async () => {
  const server = await startFixturesServer();
  try {
    // Token-scoped code generation: same token returns the same code.
    const r1 = await (await fetch(`${server.origin}/__multitab/report?token=t1`)).json();
    const r2 = await (await fetch(`${server.origin}/__multitab/report?token=t1`)).json();
    assert.equal(r1.ok, true);
    assert.equal(r1.code, r2.code);
    const r3 = await (await fetch(`${server.origin}/__multitab/report?token=t2`)).json();
    assert.notEqual(r1.code, r3.code);

    // Wrong code stores a failed receipt + 400.
    const wrong = await fetch(`${server.origin}/__multitab/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t1", code: "NOPE" }),
    });
    assert.equal(wrong.status, 400);
    const wrongLast = await (await fetch(`${server.origin}/__multitab/last`)).json();
    assert.equal(wrongLast.ok, false);

    // Right code records ok:true.
    const ok = await fetch(`${server.origin}/__multitab/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t1", code: r1.code }),
    });
    assert.equal(ok.status, 200);
    const after = await (await fetch(`${server.origin}/__multitab/last`)).json();
    assert.equal(after.ok, true);
    assert.equal(after.code, r1.code);

    // Unknown token rejected.
    const unknown = await fetch(`${server.origin}/__multitab/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "ghost", code: "x" }),
    });
    assert.equal(unknown.status, 400);
  } finally {
    await server.close();
  }
});

test("fixtures server: /__recoverable returns 500 once then succeeds; reset clears the counter", async () => {
  const server = await startFixturesServer();
  try {
    const first = await fetch(`${server.origin}/__recoverable/submit`, { method: "POST" });
    assert.equal(first.status, 500);
    const second = await fetch(`${server.origin}/__recoverable/submit`, { method: "POST" });
    assert.equal(second.status, 200);
    const last = await (await fetch(`${server.origin}/__recoverable/last`)).json();
    assert.equal(last.ok, true);
    assert.equal(last.attempts, 2);

    // Reset rewinds the failure counter so the next session sees the same
    // first-call-fails contract.
    await fetch(`${server.origin}/__reset`, { method: "POST" });
    const cleared = await (await fetch(`${server.origin}/__recoverable/last`)).json();
    assert.deepEqual(cleared, {});
    const afterReset = await fetch(`${server.origin}/__recoverable/submit`, { method: "POST" });
    assert.equal(afterReset.status, 500);
  } finally {
    await server.close();
  }
});

test("fixtures server: /report.pdf body matches /__pdf/submit expected answer; reset rotates the answer", async () => {
  const server = await startFixturesServer();
  try {
    const pdf1 = Buffer.from(
      await (await fetch(`${server.origin}/report.pdf`)).arrayBuffer(),
    ).toString("utf8");
    const m1 = pdf1.match(/Quarterly access code is ([A-Z2-9]{8})/);
    assert.ok(m1, "PDF should contain the access code marker");
    const code1 = m1![1] as string;

    // Wrong answer rejected.
    const wrong = await fetch(`${server.origin}/__pdf/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "WRONGCODE" }),
    });
    assert.equal(wrong.status, 400);
    const wrongLast = await (await fetch(`${server.origin}/__pdf/last`)).json();
    assert.equal(wrongLast.ok, false);

    // Right answer accepted.
    const ok = await fetch(`${server.origin}/__pdf/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: code1 }),
    });
    assert.equal(ok.status, 200);
    const last = await (await fetch(`${server.origin}/__pdf/last`)).json();
    assert.equal(last.ok, true);
    assert.equal(last.answer, code1);

    // Reset rotates the answer so the previous code stops working.
    await fetch(`${server.origin}/__reset`, { method: "POST" });
    const pdf2 = Buffer.from(
      await (await fetch(`${server.origin}/report.pdf`)).arrayBuffer(),
    ).toString("utf8");
    const m2 = pdf2.match(/Quarterly access code is ([A-Z2-9]{8})/);
    assert.ok(m2);
    // Tiny chance of collision (1 in 32^8 ≈ 1.1e12) — fine for a unit test.
    assert.notEqual(m2![1], code1);
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
    "late-hydration.yaml",
    "multi-tab.yaml",
    "recoverable.yaml",
    "pdf-task.yaml",
  ];
  // AC #5 of US-008: the hard slice must be exactly 10 fixtures.
  assert.equal(hardSpecs.length, 10);
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
