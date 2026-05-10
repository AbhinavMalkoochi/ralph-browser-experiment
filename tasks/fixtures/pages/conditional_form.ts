// Hostile fixture #5 — Form whose validation rules CHANGE mid-stream based on
// prior field values.
//
// The form has four steps. Earlier answers determine which fields appear next
// and the regex used to validate them. The flow:
//
//   Step 1: account_type radio  (personal | business)
//   Step 2 (conditional on step 1):
//      personal → birth_year (1900..2010), email
//      business → tax_id (NN-NNNNNNN),     email
//   Step 3: country select  (usa | canada | mexico)
//   Step 4 (conditional on step 3):
//      usa     → ssn  (NNN-NN-NNNN)
//      canada  → sin  (9 digits)
//      mexico  → rfc  (4 letters + 6 digits + 3 alnum)
//
// Each "Next" button validates the current step's visible fields against the
// rules in force for the prior selection; mismatches keep the user on that
// step. Submit POSTs the full payload (including a "path" array describing
// which conditional branches were taken) to /__conditional/submit. The
// server validates the path against the values one more time and stores the
// receipt at /__conditional/last; an agent must therefore satisfy BOTH the
// client-side conditional gating AND the server-side cross-check.
//
// Verifier: GET /__conditional/last and assert each field in the goal matches.

export const CONDITIONAL_FORM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Application form</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 640px; }
  h1 { font-size: 1.4rem; }
  fieldset { border: 1px solid #ccc; padding: 12px 16px; margin: 0 0 12px;
             border-radius: 6px; }
  fieldset[disabled] { opacity: 0.5; }
  legend { font-weight: 600; padding: 0 4px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 0.9rem;
          margin-bottom: 8px; }
  input, select, button { font: inherit; padding: 6px 8px; border: 1px solid #888;
                          border-radius: 4px; }
  button { background: #2c6cdf; color: white; border: none; cursor: pointer; }
  button[disabled] { background: #888; cursor: not-allowed; }
  .err { color: #b00; font-size: 0.85rem; min-height: 1em; }
  .ok  { color: #2a7; font-size: 0.85rem; min-height: 1em; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <h1>Account application</h1>

  <form id="form" autocomplete="off">
    <fieldset id="step-1">
      <legend>Step 1 — Account type</legend>
      <label><input type="radio" name="account_type" value="personal" /> Personal</label>
      <label><input type="radio" name="account_type" value="business" /> Business</label>
      <button id="next-1" type="button">Next</button>
      <div id="err-1" class="err"></div>
    </fieldset>

    <fieldset id="step-2" hidden disabled>
      <legend>Step 2 — Identity</legend>
      <label id="lbl-birth-year" hidden>Birth year (1900–2010)
        <input id="birth_year" name="birth_year" type="text" inputmode="numeric" />
      </label>
      <label id="lbl-tax-id" hidden>Tax ID (NN-NNNNNNN)
        <input id="tax_id" name="tax_id" type="text" />
      </label>
      <label>Email
        <input id="email" name="email" type="email" />
      </label>
      <button id="next-2" type="button">Next</button>
      <div id="err-2" class="err"></div>
    </fieldset>

    <fieldset id="step-3" hidden disabled>
      <legend>Step 3 — Country</legend>
      <label>Country
        <select id="country" name="country">
          <option value="">--</option>
          <option value="usa">United States</option>
          <option value="canada">Canada</option>
          <option value="mexico">Mexico</option>
        </select>
      </label>
      <button id="next-3" type="button">Next</button>
      <div id="err-3" class="err"></div>
    </fieldset>

    <fieldset id="step-4" hidden disabled>
      <legend>Step 4 — National ID</legend>
      <label id="lbl-ssn" hidden>SSN (NNN-NN-NNNN)
        <input id="ssn" name="ssn" type="text" />
      </label>
      <label id="lbl-sin" hidden>SIN (9 digits)
        <input id="sin" name="sin" type="text" />
      </label>
      <label id="lbl-rfc" hidden>RFC (AAAA999999AAA)
        <input id="rfc" name="rfc" type="text" />
      </label>
      <button id="submit-btn" type="button">Submit</button>
      <div id="err-4" class="err"></div>
      <div id="ok"   class="ok"></div>
    </fieldset>
  </form>

  <script>
    (function() {
      const path = [];
      window.__test = { path, lastSubmitStatus: null };

      const RULES = {
        birth_year: (v) => /^\\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= 2010,
        tax_id:     (v) => /^\\d{2}-\\d{7}$/.test(v),
        email:      (v) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v),
        ssn:        (v) => /^\\d{3}-\\d{2}-\\d{4}$/.test(v),
        sin:        (v) => /^\\d{9}$/.test(v),
        rfc:        (v) => /^[A-Z]{4}\\d{6}[A-Z0-9]{3}$/.test(v),
      };

      function val(id) { return document.getElementById(id).value.trim(); }
      function show(sel) { document.querySelector(sel).hidden = false; }
      function hide(sel) { document.querySelector(sel).hidden = true; }
      function enable(id) { document.getElementById(id).disabled = false; }
      function setErr(id, msg) { document.getElementById(id).textContent = msg || ""; }

      // Step 1.
      document.getElementById("next-1").addEventListener("click", () => {
        const radios = Array.from(document.querySelectorAll('input[name="account_type"]'));
        const picked = radios.find((r) => r.checked);
        if (!picked) { setErr("err-1", "Select an account type."); return; }
        setErr("err-1", "");
        path.push({ step: 1, account_type: picked.value });
        // Reveal step 2 with the right fields.
        if (picked.value === "personal") {
          show("#lbl-birth-year"); hide("#lbl-tax-id");
        } else {
          show("#lbl-tax-id"); hide("#lbl-birth-year");
        }
        show("#step-2"); enable("step-2");
      });

      // Step 2.
      document.getElementById("next-2").addEventListener("click", () => {
        const accountType = path[0].account_type;
        if (accountType === "personal") {
          if (!RULES.birth_year(val("birth_year"))) {
            setErr("err-2", "Birth year must be 4 digits between 1900 and 2010.");
            return;
          }
        } else {
          if (!RULES.tax_id(val("tax_id"))) {
            setErr("err-2", "Tax ID must match NN-NNNNNNN.");
            return;
          }
        }
        if (!RULES.email(val("email"))) {
          setErr("err-2", "Email must be a valid address.");
          return;
        }
        setErr("err-2", "");
        const entry = { step: 2 };
        if (accountType === "personal") entry.birth_year = val("birth_year");
        else entry.tax_id = val("tax_id");
        entry.email = val("email");
        path.push(entry);
        show("#step-3"); enable("step-3");
      });

      // Step 3.
      document.getElementById("next-3").addEventListener("click", () => {
        const country = val("country");
        if (!country) { setErr("err-3", "Choose a country."); return; }
        setErr("err-3", "");
        path.push({ step: 3, country });
        // Reveal the country-specific id field.
        hide("#lbl-ssn"); hide("#lbl-sin"); hide("#lbl-rfc");
        if (country === "usa") show("#lbl-ssn");
        else if (country === "canada") show("#lbl-sin");
        else if (country === "mexico") show("#lbl-rfc");
        show("#step-4"); enable("step-4");
      });

      // Step 4 (submit).
      document.getElementById("submit-btn").addEventListener("click", async () => {
        const country = path[2].country;
        const idField = country === "usa" ? "ssn" : country === "canada" ? "sin" : "rfc";
        if (!RULES[idField](val(idField))) {
          setErr("err-4", "National ID does not match the required format.");
          return;
        }
        setErr("err-4", "");
        const entry = { step: 4 };
        entry[idField] = val(idField);
        path.push(entry);

        // Build the full payload and submit to the server.
        const payload = {
          account_type: path[0].account_type,
          email: path[1].email,
          country,
          path: path.map((p) => p.step),
        };
        if (payload.account_type === "personal") payload.birth_year = path[1].birth_year;
        else payload.tax_id = path[1].tax_id;
        payload[idField] = path[3][idField];

        try {
          const res = await fetch("/__conditional/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const j = await res.json();
          window.__test.lastSubmitStatus = res.status;
          if (j.ok) {
            document.getElementById("ok").textContent = "submitted";
            document.title = "submitted";
          } else {
            setErr("err-4", "Server rejected: " + (j.error || "unknown"));
          }
        } catch (err) {
          setErr("err-4", "Network error.");
        }
      });
    })();
  </script>
</body>
</html>`;
