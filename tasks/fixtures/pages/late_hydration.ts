// Hostile fixture #7 — Late-hydration SPA.
//
// The page renders a "Submit" button immediately on page load, but the
// click handler is NOT installed until 1500ms later (the "hydration"
// delay). Until then the button looks identical but pressing it does
// nothing — the click is recorded as a "pre-hydration" attempt that the
// state machine refuses, and the page surfaces a soft "still loading…"
// message that disappears on the next paint.
//
// Once hydration completes the button's click handler is wired and the
// next click flips window.__test.completed to true and POSTs to
// /__hydration/submit so the verifier can read the (clickedAt, hydratedAt)
// pair from the server. An agent that fires the click too eagerly during
// the hydration window therefore registers as a no-op even though the
// element appears interactive — a classic SPA failure mode that defeats
// agents which assume DOM presence implies handler attachment.
//
// State exposed on window.__test:
//   { hydrated, hydratedAt, completed, clickedAt, attempts }
//
// Verifier requirements:
//   - window.__test.completed === true
//   - window.__test.clickedAt - window.__test.hydratedAt >= 0
//
// Tagged: hard, fixtures, hydration, timing.

export const LATE_HYDRATION_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Order summary</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 640px; }
  h1 { font-size: 1.4rem; margin: 0 0 8px; }
  p { color: #444; }
  .card {
    border: 1px solid #ccc; border-radius: 8px; padding: 16px 20px;
    background: #fafafa;
  }
  button#confirm {
    font: inherit; padding: 8px 18px; border-radius: 4px; border: 1px solid #2c6cdf;
    background: #2c6cdf; color: #fff; cursor: pointer; margin-top: 12px;
  }
  button#confirm:active { background: #1e58c0; }
  #notice { color: #888; font-size: 0.9rem; min-height: 1.4em; margin-top: 6px; }
  #status { color: #2a7; font-size: 0.95rem; min-height: 1.4em; margin-top: 6px; }
</style>
</head>
<body>
  <h1>Order summary</h1>
  <p>Review your order and confirm to complete checkout.</p>
  <div class="card">
    <p><strong>Item:</strong> Mechanical keyboard</p>
    <p><strong>Total:</strong> $129.00</p>
    <button id="confirm" type="button">Confirm order</button>
    <div id="notice" aria-live="polite"></div>
    <div id="status" aria-live="polite"></div>
  </div>
  <script>
    (function() {
      const HYDRATION_DELAY_MS = 1500;
      const state = {
        hydrated: false,
        hydratedAt: null,
        completed: false,
        clickedAt: null,
        attempts: 0,
      };
      window.__test = state;

      const btn = document.getElementById('confirm');
      const notice = document.getElementById('notice');
      const status = document.getElementById('status');

      // Pre-hydration click handler: records attempts, surfaces a "still
      // loading" hint, but does NOT advance the workflow. The handler is
      // intentionally idempotent so an agent spamming clicks before
      // hydration just bumps the counter.
      function preHydrationClick() {
        state.attempts++;
        notice.textContent = 'Still loading… please wait.';
        // Clear the notice on the next animation frame so quick agents
        // see it but it does not stick around as a permanent banner.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (notice.textContent === 'Still loading… please wait.') {
            notice.textContent = '';
          }
        }));
      }
      btn.addEventListener('click', preHydrationClick);

      // After HYDRATION_DELAY_MS replace the placeholder handler with the
      // real one. The button visual does not change, so an a11y agent
      // sees identical state before and after hydration.
      setTimeout(async () => {
        btn.removeEventListener('click', preHydrationClick);
        state.hydrated = true;
        state.hydratedAt = Date.now();
        btn.addEventListener('click', async () => {
          if (state.completed) return;
          state.completed = true;
          state.clickedAt = Date.now();
          try {
            await fetch('/__hydration/submit', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                clickedAt: state.clickedAt,
                hydratedAt: state.hydratedAt,
                attempts: state.attempts,
              }),
            });
            status.textContent = 'Order confirmed.';
            document.title = 'confirmed';
          } catch {
            status.textContent = 'Network error confirming order.';
          }
        });
      }, HYDRATION_DELAY_MS);
    })();
  </script>
</body>
</html>`;
