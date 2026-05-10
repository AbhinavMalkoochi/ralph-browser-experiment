// Hostile fixture #4 — Three nested modals navigated in a specific order.
//
// The page loads with modal "step-1" already open. The state machine is:
//
//   idle → step1_done → step2_done → done
//
// Each modal exposes one correct button (advances the state) and one decoy
// (transitions to a terminal "aborted" state and closes every modal). Once
// the state machine is in "aborted" or "done" it is FROZEN; reopening modals
// or clicking buttons has no effect. The progression is therefore irreversible:
// an agent that picks the wrong button on any step can never recover.
//
// Three layers of nesting: opening modal step-N puts modal step-(N+1) on top
// of it, with all prior modals still in the DOM behind a stacked backdrop.
// This is intentional — naive a11y agents that pick the first focusable
// element across the whole document tend to grab a button from the WRONG
// modal (the first-stacked one), which is no longer accepting input.
//
// Verifier: window.__test.state === "done".

export const MODAL_STACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Onboarding</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 720px; }
  h1 { font-size: 1.4rem; }
  p { color: #444; }
  .backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.35);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: white; border: 1px solid #888; border-radius: 8px;
    padding: 20px 24px; min-width: 320px; max-width: 480px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.18); font-family: inherit;
  }
  .modal h2 { font-size: 1.1rem; margin: 0 0 8px; }
  .modal p { font-size: 0.95rem; color: #333; margin: 0 0 16px; }
  .modal .row { display: flex; gap: 8px; justify-content: flex-end; }
  .modal button {
    font: inherit; padding: 6px 14px; border-radius: 4px; cursor: pointer;
    border: 1px solid #888; background: #fff;
  }
  .modal button.primary { background: #2c6cdf; color: #fff; border-color: #2c6cdf; }
  .modal[hidden] { display: none; }
  .stack-1 { z-index: 100; }
  .stack-2 { z-index: 200; }
  .stack-3 { z-index: 300; }
  #ended {
    background: #fff5f5; border: 1px solid #d33; padding: 12px 16px;
    border-radius: 6px; color: #b00; max-width: 480px;
  }
</style>
</head>
<body>
  <h1>Welcome to Acme Onboarding</h1>
  <p>Please complete the three onboarding steps to finish setting up your account.</p>

  <div id="ended" hidden>Setup ended.</div>

  <div id="m1" class="backdrop stack-1">
    <div class="modal" role="dialog" aria-labelledby="m1-title">
      <h2 id="m1-title">Step 1 of 3 — Welcome</h2>
      <p>Choose how to proceed with onboarding.</p>
      <div class="row">
        <button id="m1-skip" type="button">Skip onboarding</button>
        <button id="m1-begin" class="primary" type="button">Begin onboarding</button>
      </div>
    </div>
  </div>

  <div id="m2" class="backdrop stack-2" hidden>
    <div class="modal" role="dialog" aria-labelledby="m2-title">
      <h2 id="m2-title">Step 2 of 3 — Terms</h2>
      <p>Acknowledge the terms of service to continue.</p>
      <div class="row">
        <button id="m2-decline" type="button">Decline terms</button>
        <button id="m2-accept" class="primary" type="button">Acknowledge terms</button>
      </div>
    </div>
  </div>

  <div id="m3" class="backdrop stack-3" hidden>
    <div class="modal" role="dialog" aria-labelledby="m3-title">
      <h2 id="m3-title">Step 3 of 3 — Confirm</h2>
      <p>Confirm to finalise your setup.</p>
      <div class="row">
        <button id="m3-defer" type="button">Try later</button>
        <button id="m3-finish" class="primary" type="button">Finish setup</button>
      </div>
    </div>
  </div>

  <script>
    (function() {
      const TERMINAL = new Set(["done", "aborted"]);
      const state = { current: "idle", history: ["idle"] };
      window.__test = state;

      function transition(next) {
        if (TERMINAL.has(state.current)) return false;
        state.current = next;
        state.history.push(next);
        return true;
      }

      function show(id) { document.getElementById(id).hidden = false; }
      function hide(id) { document.getElementById(id).hidden = true; }
      function abort() {
        if (TERMINAL.has(state.current)) return;
        transition("aborted");
        hide("m1"); hide("m2"); hide("m3");
        document.getElementById("ended").hidden = false;
      }

      document.getElementById("m1-begin").addEventListener("click", () => {
        if (state.current !== "idle") return;
        transition("step1_done");
        show("m2");
      });
      document.getElementById("m1-skip").addEventListener("click", () => {
        if (state.current !== "idle") return;
        abort();
      });

      document.getElementById("m2-accept").addEventListener("click", () => {
        if (state.current !== "step1_done") return;
        transition("step2_done");
        show("m3");
      });
      document.getElementById("m2-decline").addEventListener("click", () => {
        if (state.current !== "step1_done") return;
        abort();
      });

      document.getElementById("m3-finish").addEventListener("click", () => {
        if (state.current !== "step2_done") return;
        transition("done");
        hide("m1"); hide("m2"); hide("m3");
        document.title = "done";
      });
      document.getElementById("m3-defer").addEventListener("click", () => {
        if (state.current !== "step2_done") return;
        abort();
      });
    })();
  </script>
</body>
</html>`;
