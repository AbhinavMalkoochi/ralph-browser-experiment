// Hostile fixture #9 — Recoverable failure on submit.
//
// The page has a single "Submit" button that POSTs to /__recoverable/submit.
// The first time the endpoint is called PER SESSION it returns HTTP 500
// with a JSON body explaining that an upstream service was unavailable.
// Subsequent attempts succeed (200 + receipt). The page surfaces the
// failure as a visible error banner and re-enables the submit button so
// the agent can retry.
//
// Naive agents that abort on the first 500 fail; agents that retry once
// succeed. The trick is that the failure mode looks legitimate (proper
// HTTP error, descriptive message) so the agent is encouraged to retry
// rather than declare task failure.
//
// State exposed on window.__test:
//   { attempts, lastStatus, lastError, completed }
//
// Verifier requirements:
//   GET /__recoverable/last → { ok: true, attempts: >= 2 }

export const RECOVERABLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Place order</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 640px; }
  h1 { font-size: 1.4rem; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 16px 20px; }
  button { font: inherit; padding: 6px 14px; border-radius: 4px;
           border: 1px solid #2c6cdf; background: #2c6cdf; color: #fff;
           cursor: pointer; }
  button[disabled] { background: #888; border-color: #888; cursor: not-allowed; }
  #err {
    color: #b00; background: #fff5f5; border: 1px solid #d33;
    padding: 8px 12px; border-radius: 4px; margin-top: 12px;
    min-height: 1.2em; display: none;
  }
  #err.show { display: block; }
  #ok { color: #2a7; min-height: 1.2em; margin-top: 6px; }
</style>
</head>
<body>
  <h1>Place order</h1>
  <p>Confirm your order. The upstream payment service has been flaky lately —
     if the request fails, please try again.</p>
  <div class="card">
    <button id="submit-btn" type="button">Submit order</button>
    <div id="err" role="alert"></div>
    <div id="ok" aria-live="polite"></div>
  </div>
  <script>
    (function() {
      const state = {
        attempts: 0,
        lastStatus: null,
        lastError: null,
        completed: false,
      };
      window.__test = state;
      const btn = document.getElementById('submit-btn');
      const err = document.getElementById('err');
      const ok = document.getElementById('ok');

      btn.addEventListener('click', async () => {
        if (state.completed) return;
        btn.disabled = true;
        err.classList.remove('show');
        err.textContent = '';
        ok.textContent = '';
        try {
          const res = await fetch('/__recoverable/submit', { method: 'POST' });
          state.attempts++;
          state.lastStatus = res.status;
          if (res.ok) {
            state.completed = true;
            ok.textContent = 'Order submitted.';
            document.title = 'submitted';
          } else {
            const j = await res.json().catch(() => ({}));
            state.lastError = j && j.error ? j.error : ('http ' + res.status);
            err.textContent = 'Submission failed: ' + state.lastError + '. Please retry.';
            err.classList.add('show');
            btn.disabled = false;
          }
        } catch (e) {
          state.lastError = String(e);
          err.textContent = 'Network error. Please retry.';
          err.classList.add('show');
          btn.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`;
