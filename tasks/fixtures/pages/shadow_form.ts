// Hostile fixture #1 — Shadow-DOM-only form.
//
// The signup form lives entirely inside an open shadow root attached to a
// custom element. Naive agents that call `document.querySelector('input')`
// see no inputs at all because shadow-root children are not enumerated by
// document-rooted queries. To complete the task an agent must traverse
// `customElement.shadowRoot`, fill three fields, and click submit.
//
// On submit the form posts JSON to /__shadow/submit, which the server logs.
// The verifier reads /__shadow/last and asserts the right payload landed.

export const SHADOW_FORM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Account setup</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 720px; }
  h1 { font-size: 1.4rem; }
  p { color: #444; }
</style>
</head>
<body>
  <h1>Account setup</h1>
  <p>Please complete the signup form below to continue.</p>
  <shadow-form></shadow-form>
  <noscript>This page requires JavaScript.</noscript>
  <script>
    class ShadowForm extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <style>
            :host { display: block; }
            form { display: flex; flex-direction: column; gap: 10px; max-width: 320px;
                   font-family: system-ui, sans-serif; }
            label { display: flex; flex-direction: column; font-size: 0.9rem; gap: 4px; }
            input, select, button {
              font: inherit; padding: 6px 8px; border: 1px solid #888; border-radius: 4px;
            }
            button { background: #2c6cdf; color: white; border: none; cursor: pointer; }
            output { font-size: 0.9rem; color: #2a7; min-height: 1.2em; }
          </style>
          <form id="signup">
            <label>Username
              <input id="username" name="username" autocomplete="off" required />
            </label>
            <label>Email
              <input id="email" name="email" type="email" autocomplete="off" required />
            </label>
            <label>Tier
              <select id="tier" name="tier" required>
                <option value="">--</option>
                <option value="bronze">bronze</option>
                <option value="silver">silver</option>
                <option value="gold">gold</option>
              </select>
            </label>
            <button id="submit" type="submit">Submit</button>
            <output id="status" aria-live="polite"></output>
          </form>
        \`;
        const form = root.getElementById('signup');
        const status = root.getElementById('status');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const payload = {
            username: root.getElementById('username').value.trim(),
            email: root.getElementById('email').value.trim(),
            tier: root.getElementById('tier').value,
          };
          try {
            const res = await fetch('/__shadow/submit', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const j = await res.json();
            status.textContent = j.ok ? 'submitted' : ('error: ' + (j.error || 'unknown'));
            if (j.ok) document.title = 'submitted';
          } catch (err) {
            status.textContent = 'network error';
          }
        });
      }
    }
    customElements.define('shadow-form', ShadowForm);
  </script>
</body>
</html>`;
