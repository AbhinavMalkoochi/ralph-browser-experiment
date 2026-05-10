// Hostile fixture #6 — Cross-iframe drag-and-drop.
//
// Three pages cooperate:
//
//   /iframe-drag           — parent. Two same-origin iframes, side by side.
//                            Maintains window.__test.{drops, lastDragSource}.
//   /iframe-drag/source    — three draggable boxes "alpha","beta","gamma".
//                            On mousedown, posts {type:"dragstart", sourceId}
//                            to window.parent.
//   /iframe-drag/target    — three drop slots "slot-1","slot-2","slot-3". On
//                            mouseup, posts {type:"drop", targetId, x, y} to
//                            window.parent. Parent records the drop along
//                            with the most-recent dragstart's sourceId.
//
// To complete the task an agent must:
//   1. Walk into the source iframe's contentDocument and dispatch a
//      mousedown on the right item.
//   2. Walk into the target iframe's contentDocument and dispatch a mouseup
//      on the right slot.
// Naive a11y agents that snapshot the top-level document tree see two
// opaque iframes and no actionable items. Real CDP mouse dispatch would also
// have to work in absolute viewport coordinates, which only line up if the
// agent reads each iframe's bounding box and offsets correctly.
//
// Verifier: window.__test.drops contains an entry with sourceId="beta",
// targetId="slot-2", and non-zero coordinates.

export const IFRAME_DRAG_PARENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Cross-iframe drag-and-drop</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  p { color: #444; }
  .frames { display: flex; gap: 16px; }
  iframe {
    width: 320px; height: 360px;
    border: 1px solid #888; border-radius: 4px; background: #fff;
  }
</style>
</head>
<body>
  <h1>Cross-iframe drag-and-drop</h1>
  <p>Drag <strong>beta</strong> from the source frame onto <strong>slot-2</strong> in the target frame.</p>
  <div class="frames">
    <iframe id="src" src="/iframe-drag/source" title="source"></iframe>
    <iframe id="dst" src="/iframe-drag/target" title="target"></iframe>
  </div>
  <script>
    (function() {
      const state = { drops: [], lastDragSource: null };
      window.__test = state;

      window.addEventListener("message", (e) => {
        const d = e.data;
        if (!d || typeof d !== "object") return;
        if (d.type === "dragstart") {
          state.lastDragSource = d.sourceId;
        } else if (d.type === "drop") {
          state.drops.push({
            sourceId: state.lastDragSource,
            targetId: d.targetId,
            x: d.x,
            y: d.y,
            droppedAt: Date.now(),
          });
          state.lastDragSource = null;
        } else if (d.type === "dragcancel") {
          state.lastDragSource = null;
        }
      });
    })();
  </script>
</body>
</html>`;

export const IFRAME_DRAG_SOURCE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>source</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 12px; }
  h2 { font-size: 1rem; margin: 0 0 8px; }
  .item {
    display: block; width: 200px; padding: 16px; margin: 0 0 12px;
    border: 1px solid #888; border-radius: 6px; background: #eaf2ff;
    cursor: grab; user-select: none; font-size: 1rem;
  }
  .item.dragging { background: #d2e3ff; cursor: grabbing; }
</style>
</head>
<body>
  <h2>Source items</h2>
  <div class="item" data-id="alpha">alpha</div>
  <div class="item" data-id="beta">beta</div>
  <div class="item" data-id="gamma">gamma</div>
  <script>
    (function() {
      const items = document.querySelectorAll(".item");
      let dragging = null;
      items.forEach((item) => {
        item.addEventListener("mousedown", (e) => {
          dragging = item.dataset.id;
          item.classList.add("dragging");
          window.parent.postMessage({ type: "dragstart", sourceId: dragging }, "*");
        });
      });
      window.addEventListener("mouseup", () => {
        if (dragging) {
          const el = document.querySelector('.item[data-id="' + dragging + '"]');
          if (el) el.classList.remove("dragging");
          dragging = null;
        }
      });
    })();
  </script>
</body>
</html>`;

export const IFRAME_DRAG_TARGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>target</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 12px; }
  h2 { font-size: 1rem; margin: 0 0 8px; }
  .slot {
    display: block; width: 200px; padding: 24px; margin: 0 0 12px;
    border: 2px dashed #888; border-radius: 6px; background: #fffbe6;
    text-align: center; user-select: none;
  }
  .slot.hit { background: #d8f6d3; border-style: solid; border-color: #2a7; }
</style>
</head>
<body>
  <h2>Drop targets</h2>
  <div class="slot" data-id="slot-1">slot-1</div>
  <div class="slot" data-id="slot-2">slot-2</div>
  <div class="slot" data-id="slot-3">slot-3</div>
  <script>
    (function() {
      const slots = document.querySelectorAll(".slot");
      slots.forEach((slot) => {
        slot.addEventListener("mouseup", (e) => {
          slot.classList.add("hit");
          window.parent.postMessage({
            type: "drop",
            targetId: slot.dataset.id,
            x: e.clientX,
            y: e.clientY,
          }, "*");
        });
      });
    })();
  </script>
</body>
</html>`;
