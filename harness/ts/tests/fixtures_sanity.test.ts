// Chrome-driven sanity tests for the US-006 hard fixtures.
//
// For each of the three fixtures we assert:
//   - the trivial click-first-link agent leaves the page in a state the
//     verifier reports as pass=false (no anchors to click + no side-effect)
//   - a hand-written cheat agent that knows the page's API leaves the page
//     in a state the verifier reports as pass=true
//
// The cheat agents are not full agents under agents/ — they're inline
// closures here that bypass the hostile UI directly via JS (shadow root
// traversal, synthetic mouse events on the canvas, programmatic scrollTop).
// Their job is to demonstrate that the verifier accepts a correctly-
// completed task; the AC-required failure half is covered by trivial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpBrowserSession } from "../agent/browser_session.js";
import { Trajectory } from "../agent/trajectory.js";
import { Budget, type BrowserSession } from "../agent/types.js";
import { Agent, type AgentContext } from "../agent/agent.js";
import { startFixturesServer, resolveFixtureUrl } from "../../../tasks/fixtures/server.js";
import { loadTaskFile } from "../verifier/loader.js";
import { verify } from "../verifier/runner.js";
import ClickFirstLinkAgent from "../../../agents/click-first-link/agent.js";

const generousBudget = (): Budget =>
  new Budget({ tokens: 100_000, usd: 1, wallSeconds: 120, steps: 50 });

interface FixtureCase {
  taskFile: string;
  taskKey: string;
  cheat: (browser: BrowserSession) => Promise<void>;
}

const FIXTURES: FixtureCase[] = [
  {
    taskFile: "tasks/suite/hard/shadow-form.yaml",
    taskKey: "shadow-form",
    cheat: async (browser) => {
      // Traverse the open shadow root, fill the three fields, click submit,
      // wait for the fetch to land server-side.
      await browser.evaluate(`(async () => {
        const host = document.querySelector('shadow-form');
        const root = host.shadowRoot;
        root.getElementById('username').value = 'alice';
        root.getElementById('email').value = 'alice@example.com';
        root.getElementById('tier').value = 'gold';
        const submitted = new Promise(r => {
          const o = new MutationObserver(() => {
            if (document.title === 'submitted') { o.disconnect(); r(); }
          });
          o.observe(document.querySelector('title') || document.head, {
            characterData: true, childList: true, subtree: true,
          });
          // Fallback in case title mutation observer misses.
          setTimeout(() => r(), 1500);
        });
        root.getElementById('submit').click();
        await submitted;
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/canvas-drag.yaml",
    taskKey: "canvas-drag",
    cheat: async (browser) => {
      // Read the layout snapshot, dispatch synthetic mouse events on the
      // canvas to drag node A onto node B's centre.
      await browser.evaluate(`(async () => {
        const layout = window.__test.meta.layout;
        const canvas = document.getElementById('board');
        const r = canvas.getBoundingClientRect();
        const fire = (type, x, y) => canvas.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true,
          clientX: r.left + x, clientY: r.top + y,
          button: 0, buttons: type === 'mouseup' ? 0 : 1,
        }));
        fire('mousedown', layout.A.x, layout.A.y);
        // Move in a few steps so the dragging branch is exercised.
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = layout.A.x + (layout.B.x - layout.A.x) * t;
          const y = layout.A.y + (layout.B.y - layout.A.y) * t;
          fire('mousemove', x, y);
        }
        fire('mouseup', layout.B.x, layout.B.y);
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/virtual-scroll.yaml",
    taskKey: "virtual-scroll",
    cheat: async (browser) => {
      // Programmatically scroll until target-247 mounts, then click its button.
      await browser.evaluate(`(async () => {
        const feed = document.getElementById('feed');
        const targetIdx = 247;
        feed.scrollTop = targetIdx * window.__test.rowHeight - 100;
        // Two RAFs to let the scroll handler render.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const btn = document.querySelector('button[data-id="target-247"]');
        if (!btn) throw new Error('target-247 not mounted after scroll');
        btn.click();
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/modal-stack.yaml",
    taskKey: "modal-stack",
    cheat: async (browser) => {
      // Click the primary action on each modal in order: idle -> step1_done
      // -> step2_done -> done. Each click is synchronous and the next modal
      // is mounted immediately, so no RAF wait is needed.
      await browser.evaluate(`(async () => {
        document.getElementById('m1-begin').click();
        if (window.__test.current !== 'step1_done') throw new Error('m1 did not advance: ' + window.__test.current);
        document.getElementById('m2-accept').click();
        if (window.__test.current !== 'step2_done') throw new Error('m2 did not advance: ' + window.__test.current);
        document.getElementById('m3-finish').click();
        if (window.__test.current !== 'done') throw new Error('m3 did not advance: ' + window.__test.current);
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/conditional-form.yaml",
    taskKey: "conditional-form",
    cheat: async (browser) => {
      // Walk through the four conditional steps in order, filling the right
      // field set for each branch and waiting for the title to flip on a
      // successful server-side submission.
      await browser.evaluate(`(async () => {
        // Step 1: pick "personal".
        document.querySelector('input[name="account_type"][value="personal"]').click();
        document.getElementById('next-1').click();
        // Step 2: birth_year + email (the personal branch).
        document.getElementById('birth_year').value = '1995';
        document.getElementById('email').value = 'alice@example.com';
        document.getElementById('next-2').click();
        // Step 3: country.
        document.getElementById('country').value = 'usa';
        document.getElementById('next-3').click();
        // Step 4: ssn (the usa branch) + submit.
        document.getElementById('ssn').value = '123-45-6789';
        document.getElementById('submit-btn').click();
        // Wait for the title mutation that signals server ack.
        await new Promise((resolve) => {
          if (document.title === 'submitted') return resolve();
          const o = new MutationObserver(() => {
            if (document.title === 'submitted') { o.disconnect(); resolve(); }
          });
          o.observe(document.querySelector('title') || document.head, {
            characterData: true, childList: true, subtree: true,
          });
          setTimeout(() => { o.disconnect(); resolve(); }, 2000);
        });
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/late-hydration.yaml",
    taskKey: "late-hydration",
    cheat: async (browser) => {
      // Wait for window.__test.hydrated to flip true (after the SPA's
      // 1500ms hydration delay), then click Confirm so the click lands
      // strictly after hydration. The post-hydration handler fires the
      // server POST and flips document.title='confirmed' once the
      // /__hydration/submit fetch resolves.
      await browser.evaluate(`(async () => {
        await new Promise((resolve) => {
          const start = Date.now();
          const tick = () => {
            if (window.__test && window.__test.hydrated) return resolve();
            if (Date.now() - start > 5000) return resolve();
            setTimeout(tick, 30);
          };
          tick();
        });
        document.getElementById('confirm').click();
        await new Promise((resolve) => {
          if (document.title === 'confirmed') return resolve();
          const o = new MutationObserver(() => {
            if (document.title === 'confirmed') { o.disconnect(); resolve(); }
          });
          o.observe(document.querySelector('title') || document.head, {
            characterData: true, childList: true, subtree: true,
          });
          setTimeout(() => { o.disconnect(); resolve(); }, 2500);
        });
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/multi-tab.yaml",
    taskKey: "multi-tab",
    cheat: async (browser) => {
      // The popup workflow is the canonical solution; for the cheat we
      // bypass the popup and fetch the per-token code directly using the
      // session's token stored on window.__test.token. This exercises the
      // submit/verify path without needing CDP target attach for popups.
      await browser.evaluate(`(async () => {
        const token = window.__test.token;
        const r = await fetch('/__multitab/report?token=' + encodeURIComponent(token));
        const j = await r.json();
        if (!j || !j.code) throw new Error('no code returned for token: ' + token);
        document.getElementById('code-input').value = j.code;
        document.getElementById('submit-btn').click();
        await new Promise((resolve) => {
          if (document.title === 'submitted') return resolve();
          const o = new MutationObserver(() => {
            if (document.title === 'submitted') { o.disconnect(); resolve(); }
          });
          o.observe(document.querySelector('title') || document.head, {
            characterData: true, childList: true, subtree: true,
          });
          setTimeout(() => { o.disconnect(); resolve(); }, 2000);
        });
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/recoverable.yaml",
    taskKey: "recoverable",
    cheat: async (browser) => {
      // First click hits /__recoverable/submit which returns 500; the
      // page surfaces an error banner and re-enables the submit button.
      // Wait for the button to become re-enabled (signal that the first
      // attempt finished) and then click it again — second attempt
      // succeeds with 200.
      await browser.evaluate(`(async () => {
        const btn = document.getElementById('submit-btn');
        const waitFor = (cond, timeout) => new Promise((resolve) => {
          const start = Date.now();
          const tick = () => {
            if (cond()) return resolve(true);
            if (Date.now() - start > timeout) return resolve(false);
            setTimeout(tick, 30);
          };
          tick();
        });
        btn.click();
        // Wait for the first attempt to be recorded (attempts === 1)
        // AND for the button to be re-enabled.
        const failed = await waitFor(
          () => window.__test.attempts === 1 && !btn.disabled,
          3000,
        );
        if (!failed) throw new Error('first attempt did not surface as a failure');
        btn.click();
        await new Promise((resolve) => {
          if (document.title === 'submitted') return resolve();
          const o = new MutationObserver(() => {
            if (document.title === 'submitted') { o.disconnect(); resolve(); }
          });
          o.observe(document.querySelector('title') || document.head, {
            characterData: true, childList: true, subtree: true,
          });
          setTimeout(() => { o.disconnect(); resolve(); }, 2000);
        });
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/pdf-task.yaml",
    taskKey: "pdf-task",
    cheat: async (browser) => {
      // Fetch the PDF as bytes, decode as latin1 (the PDF is ASCII text
      // operators with no encoded streams), regex-extract the access
      // code, then type it into the input and submit.
      await browser.evaluate(`(async () => {
        const r = await fetch('/report.pdf');
        const buf = await r.arrayBuffer();
        const text = new TextDecoder('latin1').decode(buf);
        const m = text.match(/Quarterly access code is ([A-Z2-9]{8})/);
        if (!m) throw new Error('no access code marker in PDF body');
        document.getElementById('answer-input').value = m[1];
        document.getElementById('submit-btn').click();
        await new Promise((resolve) => {
          if (document.title === 'submitted') return resolve();
          const o = new MutationObserver(() => {
            if (document.title === 'submitted') { o.disconnect(); resolve(); }
          });
          o.observe(document.querySelector('title') || document.head, {
            characterData: true, childList: true, subtree: true,
          });
          setTimeout(() => { o.disconnect(); resolve(); }, 2000);
        });
      })()`);
    },
  },
  {
    taskFile: "tasks/suite/hard/iframe-drag.yaml",
    taskKey: "iframe-drag",
    cheat: async (browser) => {
      // Walk into both iframes, dispatch synthetic mousedown on the source's
      // beta box and mouseup on the target's slot-2, wait for the parent
      // window's postMessage listener to record the drop.
      await browser.evaluate(`(async () => {
        const srcIframe = document.getElementById('src');
        const dstIframe = document.getElementById('dst');
        const waitLoad = (frame) => new Promise((r) => {
          if (frame.contentDocument && frame.contentDocument.readyState === 'complete') return r();
          frame.addEventListener('load', () => r(), { once: true });
        });
        await waitLoad(srcIframe);
        await waitLoad(dstIframe);
        // Items may not be in the DOM the very first frame after load; retry briefly.
        let item = null, slot = null, tries = 0;
        while ((!item || !slot) && tries < 30) {
          item = srcIframe.contentDocument.querySelector('[data-id="beta"]');
          slot = dstIframe.contentDocument.querySelector('[data-id="slot-2"]');
          if (item && slot) break;
          await new Promise((r) => setTimeout(r, 30));
          tries++;
        }
        if (!item || !slot) throw new Error('iframe items not mounted');
        const r1 = item.getBoundingClientRect();
        const r2 = slot.getBoundingClientRect();
        const fire = (el, type, x, y, view) => el.dispatchEvent(new view.MouseEvent(type, {
          bubbles: true, cancelable: true,
          clientX: x, clientY: y,
          button: 0, buttons: type === 'mouseup' ? 0 : 1,
        }));
        fire(item, 'mousedown', r1.left + r1.width / 2, r1.top + r1.height / 2, srcIframe.contentWindow);
        fire(slot, 'mouseup',   r2.left + r2.width / 2, r2.top + r2.height / 2, dstIframe.contentWindow);
        // Wait for the parent's postMessage listener to record the drop.
        for (let i = 0; i < 30; i++) {
          if (window.__test.drops.some((d) => d.sourceId === 'beta' && d.targetId === 'slot-2')) return;
          await new Promise((r) => setTimeout(r, 30));
        }
        throw new Error('drop was not recorded after dispatch');
      })()`);
    },
  },
];

class CheatAgent extends Agent {
  readonly id: string;
  constructor(private readonly fn: (b: BrowserSession) => Promise<void>, id: string) {
    super();
    this.id = id;
  }
  async run(
    _goal: string,
    browser: BrowserSession,
    budget: Budget,
    ctx: AgentContext,
  ): Promise<Trajectory> {
    const trajectory = await Trajectory.open(
      { runsRoot: ctx.runs_root, agent: this.id, task: ctx.task_id, seed: ctx.seed },
      { agent_id: this.id, task_id: ctx.task_id, seed: ctx.seed },
    );
    const t0 = Date.now();
    await this.fn(browser);
    budget.recordStep();
    budget.check();
    await trajectory.addStep({
      step: 1,
      observation_summary: `cheat:${this.id}`,
      action: { type: "cheat" },
      latency_ms: Date.now() - t0,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      screenshot_path: null,
      verifier_state: null,
    });
    await trajectory.finish({ terminal_state: "DONE" });
    return trajectory;
  }
}

for (const fx of FIXTURES) {
  test(`fixture ${fx.taskKey}: trivial agent FAILS`, async () => {
    const server = await startFixturesServer();
    const session = await CdpBrowserSession.create();
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
    try {
      const task = await loadTaskFile(join(process.cwd(), fx.taskFile));
      const startUrl = resolveFixtureUrl(task.start_url, server.origin);
      await session.navigate(startUrl);
      const traj = await new ClickFirstLinkAgent().run(task.goal, session, generousBudget(), {
        task_id: task.id,
        seed: 0,
        runs_root: runsRoot,
      });
      const verdict = await verify(
        task,
        { browser: session, trajectory: null, trajectoryDir: traj.dir },
        { recordIntoTrajectory: false },
      );
      assert.equal(verdict.pass, false, `expected trivial agent to fail ${fx.taskKey}; got ${verdict.reason}`);
    } finally {
      await session.close();
      await server.close();
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  test(`fixture ${fx.taskKey}: cheat agent PASSES`, async () => {
    const server = await startFixturesServer();
    const session = await CdpBrowserSession.create();
    const runsRoot = await mkdtemp(join(tmpdir(), "gba-runs-"));
    try {
      const task = await loadTaskFile(join(process.cwd(), fx.taskFile));
      const startUrl = resolveFixtureUrl(task.start_url, server.origin);
      await session.navigate(startUrl);
      const cheat = new CheatAgent(fx.cheat, `cheat-${fx.taskKey}`);
      const traj = await cheat.run(task.goal, session, generousBudget(), {
        task_id: task.id,
        seed: 0,
        runs_root: runsRoot,
      });
      const verdict = await verify(
        task,
        { browser: session, trajectory: null, trajectoryDir: traj.dir },
        { recordIntoTrajectory: false },
      );
      assert.equal(verdict.pass, true, `expected cheat agent to pass ${fx.taskKey}; got ${verdict.reason}`);
      assert.ok(verdict.score > 0);
    } finally {
      await session.close();
      await server.close();
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
}
