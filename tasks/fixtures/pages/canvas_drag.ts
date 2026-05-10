// Hostile fixture #2 — Canvas-rendered diagram editor.
//
// Three labelled rectangles ("A", "B", "C") are drawn on a single <canvas>.
// Node B is the dashed-outlined target slot; A and C are draggable. The page
// listens for mousedown / mousemove / mouseup on the canvas and updates the
// node it's currently dragging. On mouseup it writes the final coordinates
// to window.__test.nodes[<key>] and a deliveredToB[<key>] boolean indicating
// whether the dropped centre is within Math.max(width, height)/2 pixels of
// node B's centre.
//
// Naive a11y / DOM-tree agents see the canvas as an opaque pixel buffer with
// no children — there is no "A" element to click. Completing the task
// requires either visual reasoning, knowledge of the data model exposed at
// window.__test.meta.layout, or low-level CDP Input.dispatchMouseEvent calls.

export const CANVAS_DRAG_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Diagram editor</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  #board { border: 1px solid #888; background: #fafafa; cursor: grab;
           user-select: none; touch-action: none; }
  #board.dragging { cursor: grabbing; }
  p { color: #444; }
</style>
</head>
<body>
  <h1>Diagram editor</h1>
  <p>Drag node <strong>A</strong> onto node <strong>B</strong>'s dashed slot.</p>
  <canvas id="board" width="600" height="400"></canvas>
  <script>
    (function() {
      const W = 60, H = 40;
      const canvas = document.getElementById('board');
      const ctx = canvas.getContext('2d');
      const nodes = {
        A: { x:  80, y: 200, label: 'A', draggable: true,  color: '#a4c8ff' },
        B: { x: 480, y: 200, label: 'B', draggable: false, color: '#ffe8a3', target: true },
        C: { x: 280, y:  80, label: 'C', draggable: true,  color: '#cdf6cc' },
      };
      const layoutSnapshot = JSON.parse(JSON.stringify(nodes));
      window.__test = {
        meta: { layout: layoutSnapshot, width: W, height: H,
                hitRadius: Math.max(W, H) / 2 },
        nodes: {},
        deliveredToB: {},
      };

      function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const k of Object.keys(nodes)) {
          const n = nodes[k];
          if (n.target) {
            ctx.strokeStyle = '#888';
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(n.x - W / 2, n.y - H / 2, W, H);
            ctx.setLineDash([]);
          }
          ctx.fillStyle = n.color;
          ctx.fillRect(n.x - W / 2, n.y - H / 2, W, H);
          ctx.strokeStyle = '#333';
          ctx.lineWidth = 1;
          ctx.strokeRect(n.x - W / 2, n.y - H / 2, W, H);
          ctx.fillStyle = '#000';
          ctx.font = '20px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.label, n.x, n.y);
        }
      }

      function pickDraggable(x, y) {
        for (const k of Object.keys(nodes)) {
          const n = nodes[k];
          if (!n.draggable) continue;
          if (Math.abs(x - n.x) <= W / 2 && Math.abs(y - n.y) <= H / 2) return k;
        }
        return null;
      }

      let dragging = null;

      canvas.addEventListener('mousedown', function(e) {
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const k = pickDraggable(x, y);
        if (k) {
          dragging = { key: k, dx: x - nodes[k].x, dy: y - nodes[k].y };
          canvas.classList.add('dragging');
        }
      });

      canvas.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        nodes[dragging.key].x = x - dragging.dx;
        nodes[dragging.key].y = y - dragging.dy;
        draw();
      });

      canvas.addEventListener('mouseup', function() {
        if (!dragging) return;
        const k = dragging.key;
        dragging = null;
        canvas.classList.remove('dragging');
        const n = nodes[k];
        const target = nodes.B;
        const dx = n.x - target.x, dy = n.y - target.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const delivered = distance < Math.max(W, H) / 2;
        window.__test.nodes[k] = { x: n.x, y: n.y, distance: distance };
        window.__test.deliveredToB[k] = delivered;
      });

      draw();
    })();
  </script>
</body>
</html>`;
