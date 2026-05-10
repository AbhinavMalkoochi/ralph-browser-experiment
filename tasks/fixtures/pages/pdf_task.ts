// Hostile fixture #10 — Download a PDF and answer a question about it.
//
// The HTML page (/pdf-task) tells the agent to "download the report" and
// enter the access code printed inside the PDF into a text field. The PDF
// is served at /report.pdf as application/pdf and contains a single text
// run of the form "Quarterly access code is XXXXXXXX" where XXXXXXXX is
// a random 8-char alphanumeric token regenerated on every /__reset.
//
// The page itself does NOT reveal the answer — the answer is encoded
// only in the PDF body. An agent has to either render the PDF (browsers
// can preview PDFs but the text is not in the DOM), open it in a viewer,
// or fetch and parse the bytes directly. Naive agents that only read the
// page DOM cannot recover the answer.
//
// State exposed on window.__test:
//   { submittedAnswer | null }
//
// Verifier requirements:
//   GET /__pdf/last → { ok: true, answer: <session code> }

export const PDF_TASK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Quarterly access</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 640px; }
  h1 { font-size: 1.4rem; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 16px 20px; }
  a.btn { display: inline-block; padding: 6px 14px; border-radius: 4px;
          border: 1px solid #2c6cdf; background: #fff; color: #2c6cdf;
          text-decoration: none; }
  button { font: inherit; padding: 6px 14px; border-radius: 4px;
           border: 1px solid #2c6cdf; background: #2c6cdf; color: #fff;
           cursor: pointer; }
  input { font: inherit; padding: 6px 8px; border: 1px solid #888; border-radius: 4px;
          font-family: ui-monospace, Consolas, monospace; }
  label { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
  #status { color: #2a7; min-height: 1.2em; margin-top: 6px; }
</style>
</head>
<body>
  <h1>Quarterly access</h1>
  <p>Open the report PDF and enter the access code printed inside it.</p>
  <div class="card">
    <p><a id="report-link" class="btn" href="/report.pdf" target="_blank" rel="noopener">Open report.pdf</a></p>
    <label>Access code from report
      <input id="answer-input" name="answer" autocomplete="off" />
    </label>
    <button id="submit-btn" type="button">Submit access code</button>
    <div id="status" aria-live="polite"></div>
  </div>
  <script>
    (function() {
      const state = { submittedAnswer: null };
      window.__test = state;
      document.getElementById('submit-btn').addEventListener('click', async () => {
        const answer = document.getElementById('answer-input').value.trim();
        state.submittedAnswer = answer;
        const res = await fetch('/__pdf/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer }),
        });
        const j = await res.json();
        document.getElementById('status').textContent = j.ok
          ? 'Code accepted.'
          : ('Wrong code: ' + (j.error || 'try again'));
        if (j.ok) document.title = 'submitted';
      });
    })();
  </script>
</body>
</html>`;

/**
 * Build a minimal valid PDF whose first page contains a single text run
 * "Quarterly access code is <answer>". The answer must be ASCII and free
 * of `(`, `)`, `\` (we generate alphanumeric tokens, so this holds).
 *
 * The PDF is ~400 bytes, opens in real PDF viewers, and is small enough
 * for the cheat agent to fetch and regex-extract the answer.
 */
export function buildAnswerPdf(answer: string): Buffer {
  const text = `Quarterly access code is ${answer}`;
  // Stream contents must compute its own /Length, so build it first.
  const stream = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  // Header includes a binary marker (4 bytes >= 0x80) per PDF spec recommendation.
  const headerChunks: Buffer[] = [
    Buffer.from("%PDF-1.4\n", "utf8"),
    Buffer.from("%\xFF\xFE\xFD\xFC\n", "binary"),
  ];
  const chunks: Buffer[] = [...headerChunks];
  let pos = chunks.reduce((sum, b) => sum + b.length, 0);
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pos);
    const objBytes = Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`, "utf8");
    chunks.push(objBytes);
    pos += objBytes.length;
  }
  const xrefOffset = pos;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += "0000000000 65535 f \n";
  for (const o of offsets) {
    xref += String(o).padStart(10, "0") + " 00000 n \n";
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "utf8"));
  return Buffer.concat(chunks);
}

/** 8-char A–Z + 0–9 access code. */
export function randomAccessCode(): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ambiguity-free subset
  let s = "";
  for (let i = 0; i < 8; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
}
