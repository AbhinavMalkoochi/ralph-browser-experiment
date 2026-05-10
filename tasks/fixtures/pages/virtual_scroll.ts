// Hostile fixture #3 — Virtualised infinite-scroll feed.
//
// 500 logical rows, but only the ~20 inside the visible viewport (plus a 2-row
// over-render margin) are mounted in the DOM at any moment. Scrolling the
// feed unmounts off-screen rows and mounts new ones; row ids run from
// "target-0" through "target-499". Clicking a row's "action" button writes
// its id to window.__test.clickedId.
//
// Naive a11y / DOM-tree agents that snapshot the page once and rely on
// querySelector('[data-id="target-247"]') will see only a tiny mounted
// window and fail. Completing the task requires either programmatic scroll
// (scrollTop / scrollIntoView) or repeated viewport advance + retry.

export const VIRTUAL_SCROLL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Items feed</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  p { color: #444; }
  #feed {
    height: 480px;
    overflow-y: auto;
    border: 1px solid #888;
    background: #fff;
    position: relative;
  }
  #spacer { position: relative; width: 100%; }
  .row {
    position: absolute;
    left: 0; right: 0;
    height: 48px;
    padding: 8px 12px;
    box-sizing: border-box;
    border-bottom: 1px solid #eee;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .row.hit { background: #d9f7d9; }
  .row button {
    margin-left: auto;
    padding: 4px 12px;
    border: 1px solid #2c6cdf;
    background: #fff;
    color: #2c6cdf;
    border-radius: 4px;
    cursor: pointer;
  }
</style>
</head>
<body>
  <h1>Items feed</h1>
  <p>Find the row whose id is <code>target-247</code> and click its <em>action</em> button.</p>
  <div id="feed" tabindex="0">
    <div id="spacer"></div>
  </div>
  <script>
    (function() {
      const TOTAL = 500;
      const ROW_H = 48;
      const VIEW_H = 480;
      const OVER = 2;
      const feed = document.getElementById('feed');
      const spacer = document.getElementById('spacer');
      spacer.style.height = (TOTAL * ROW_H) + 'px';

      window.__test = { clickedId: null, total: TOTAL, rowHeight: ROW_H };
      const mounted = new Map();

      function render() {
        const top = feed.scrollTop;
        const startIdx = Math.max(0, Math.floor(top / ROW_H) - OVER);
        const endIdx = Math.min(TOTAL, Math.ceil((top + VIEW_H) / ROW_H) + OVER);
        const visible = new Set();
        for (let i = startIdx; i < endIdx; i++) {
          const id = 'target-' + i;
          visible.add(id);
          if (mounted.has(id)) continue;
          const el = document.createElement('div');
          el.className = 'row';
          el.setAttribute('data-id', id);
          el.setAttribute('data-index', String(i));
          el.style.top = (i * ROW_H) + 'px';
          const label = document.createElement('span');
          label.textContent = 'Item #' + i + ' (id=' + id + ')';
          const btn = document.createElement('button');
          btn.textContent = 'action';
          btn.setAttribute('data-id', id);
          btn.addEventListener('click', function() {
            window.__test.clickedId = id;
            el.classList.add('hit');
          });
          el.appendChild(label);
          el.appendChild(btn);
          spacer.appendChild(el);
          mounted.set(id, el);
        }
        for (const [id, el] of mounted) {
          if (!visible.has(id)) {
            el.remove();
            mounted.delete(id);
          }
        }
      }

      feed.addEventListener('scroll', render);
      render();
    })();
  </script>
</body>
</html>`;
