// Hostile fixture #8 — Multi-tab workflow.
//
// The parent page (/multi-tab) shows a "Open report" button and a text
// input where the agent must type the access code printed in a report.
// Clicking "Open report" calls window.open('/multi-tab/report?token=…')
// which opens a popup. The popup fetches /__multitab/report?token=…,
// receives a per-session access code, posts the code back to its opener
// via window.opener.postMessage(), and then closes itself with
// window.close(). The parent page's message listener stores the code in
// window.__test.report.code, the agent reads it, types it into the input,
// clicks submit, and the form POSTs to /__multitab/submit which records
// whether the typed code matches the per-session expected code.
//
// Naive agents that only look at the visible page never see the popup
// data and therefore cannot satisfy the verifier. The popup is
// intentionally delayed slightly so agents that race the input submit
// observe the empty state and must wait for postMessage delivery.
//
// State exposed on window.__test:
//   { token, report: {code, receivedAt} | null, submittedCode | null }
//
// Verifier requirements:
//   GET /__multitab/last → { ok: true, code: <session code> }

export const MULTI_TAB_PARENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Quarterly report</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 720px; }
  h1 { font-size: 1.4rem; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 16px 20px; }
  button { font: inherit; padding: 6px 14px; border-radius: 4px;
           border: 1px solid #2c6cdf; background: #2c6cdf; color: #fff;
           cursor: pointer; }
  button[disabled] { background: #888; border-color: #888; cursor: not-allowed; }
  input { font: inherit; padding: 6px 8px; border: 1px solid #888; border-radius: 4px; }
  label { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
  #status { color: #2a7; min-height: 1.4em; margin-top: 6px; }
</style>
</head>
<body>
  <h1>Quarterly report</h1>
  <p>Open the secure report and copy the access code into the field below to acknowledge it.</p>
  <div class="card">
    <button id="open-report" type="button">Open report</button>
    <label>Access code
      <input id="code-input" name="code" autocomplete="off" />
    </label>
    <button id="submit-btn" type="button">Submit code</button>
    <div id="status" aria-live="polite"></div>
  </div>
  <script>
    (function() {
      // Generate a per-page-load token so the popup fetches a token-
      // specific access code. The server keys per-token expected codes so
      // submissions can be cross-checked.
      const token = 'tok-' + Math.random().toString(36).slice(2, 10);
      const state = { token, report: null, submittedCode: null };
      window.__test = state;

      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'report-code' && typeof d.code === 'string' && d.token === token) {
          state.report = { code: d.code, receivedAt: Date.now() };
        }
      });

      document.getElementById('open-report').addEventListener('click', () => {
        // Open in a named target so the report can locate its opener.
        // Keep opener available (no 'noopener' / 'noreferrer') so the
        // popup can postMessage back.
        window.open('/multi-tab/report?token=' + encodeURIComponent(token), 'report');
      });

      document.getElementById('submit-btn').addEventListener('click', async () => {
        const code = document.getElementById('code-input').value.trim();
        state.submittedCode = code;
        const res = await fetch('/__multitab/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, code }),
        });
        const j = await res.json();
        document.getElementById('status').textContent = j.ok
          ? 'Code accepted.'
          : ('Error: ' + (j.error || 'unknown'));
        if (j.ok) document.title = 'submitted';
      });
    })();
  </script>
</body>
</html>`;

export const MULTI_TAB_REPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Report — secure code</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  h1 { font-size: 1.2rem; }
  .code { font-family: ui-monospace, Consolas, monospace; font-size: 1.4rem;
          padding: 8px 12px; background: #f4f4f4; border: 1px solid #ccc;
          border-radius: 4px; display: inline-block; }
  #note { color: #888; margin-top: 12px; }
</style>
</head>
<body>
  <h1>Quarterly report — secure access code</h1>
  <p>The access code for this session is:</p>
  <p class="code" id="code">…</p>
  <p id="note">This window will close automatically.</p>
  <script>
    (async function() {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token') || '';
      try {
        const res = await fetch('/__multitab/report?token=' + encodeURIComponent(token));
        const j = await res.json();
        const code = j && typeof j.code === 'string' ? j.code : '';
        document.getElementById('code').textContent = code || '(error)';
        if (window.opener && code) {
          // Slight delay so agents racing the input cannot accidentally
          // win before they have actually opened the report.
          setTimeout(() => {
            try {
              window.opener.postMessage({ type: 'report-code', code, token }, '*');
            } catch {}
            // Close after a tick so the postMessage flushes first.
            setTimeout(() => { try { window.close(); } catch {} }, 50);
          }, 200);
        }
      } catch (err) {
        document.getElementById('code').textContent = '(network error)';
      }
    })();
  </script>
</body>
</html>`;
