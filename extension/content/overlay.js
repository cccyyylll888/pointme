// overlay.js — agent 的"画笔"：在页面上画高亮、箭头、标注气泡
// 所有元素挂在一个 shadow root 里，避开页面 CSS 干扰

(() => {
  if (window.__pointme_overlay__) return;

  const host = document.createElement('div');
  host.id = '__pointme_overlay_host__';
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .layer { position: fixed; inset: 0; pointer-events: none; }
      .ring {
        position: fixed; box-sizing: border-box;
        border: 3px solid #ff6b35; border-radius: 6px;
        box-shadow: 0 0 0 9999px rgba(0,0,0,0.35), 0 0 24px 4px rgba(255,107,53,0.6);
        animation: pmpulse 1.4s ease-in-out infinite;
        transition: all 200ms ease;
      }
      @keyframes pmpulse {
        0%,100% { box-shadow: 0 0 0 9999px rgba(0,0,0,0.30), 0 0 24px 4px rgba(255,107,53,0.6); }
        50%     { box-shadow: 0 0 0 9999px rgba(0,0,0,0.42), 0 0 36px 8px rgba(255,107,53,0.9); }
      }
      .annot {
        position: fixed; max-width: 280px;
        background: #1f2937; color: #f9fafb;
        padding: 10px 14px; border-radius: 10px;
        font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 32px rgba(0,0,0,0.35);
        border: 1px solid rgba(255,107,53,0.5);
      }
      .annot::before {
        content: ""; position: absolute; left: -8px; top: 14px;
        border: 8px solid transparent; border-right-color: #1f2937;
      }
      svg { position: fixed; inset: 0; width: 100vw; height: 100vh; }
      svg path { fill: none; stroke: #ff6b35; stroke-width: 3; stroke-linecap: round; stroke-dasharray: 8 4; }
      svg .arrowhead { fill: #ff6b35; }
    </style>
    <div class="layer" id="layer">
      <svg id="svg" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path class="arrowhead" d="M0,0 L10,5 L0,10 z"/>
          </marker>
        </defs>
      </svg>
    </div>
  `;
  const layer = root.getElementById('layer');
  const svg = root.getElementById('svg');

  const items = new Map(); // id -> {el}
  let counter = 0;

  const rectOf = (refId) => {
    const el = window.__pointme_snapshot__?.resolveRef(refId);
    if (!el) return null;
    return el.getBoundingClientRect();
  };

  const cmd = {
    highlight(refId) {
      const r = rectOf(refId);
      if (!r) return { ok: false, error: 'ref not found: ' + refId };
      const el = window.__pointme_snapshot__.resolveRef(refId);
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      const ring = document.createElement('div');
      ring.className = 'ring';
      const id = 'h' + (++counter);
      ring.dataset.id = id;
      ring.dataset.ref = refId;
      Object.assign(ring.style, {
        left: r.left - 4 + 'px', top: r.top - 4 + 'px',
        width: r.width + 8 + 'px', height: r.height + 8 + 'px'
      });
      layer.appendChild(ring);
      items.set(id, { el: ring, ref: refId, kind: 'ring' });
      return { ok: true, id };
    },

    annotate(refId, text) {
      const r = rectOf(refId);
      if (!r) return { ok: false, error: 'ref not found' };
      const note = document.createElement('div');
      note.className = 'annot';
      note.textContent = text;
      const id = 'a' + (++counter);
      note.dataset.id = id;
      Object.assign(note.style, {
        left: Math.min(r.right + 16, window.innerWidth - 300) + 'px',
        top: Math.max(8, r.top) + 'px'
      });
      layer.appendChild(note);
      items.set(id, { el: note, ref: refId, kind: 'annot' });
      return { ok: true, id };
    },

    draw_arrow(fromRef, toRef) {
      const a = rectOf(fromRef), b = rectOf(toRef);
      if (!a || !b) return { ok: false, error: 'ref not found' };
      const x1 = a.left + a.width / 2, y1 = a.top + a.height / 2;
      const x2 = b.left + b.width / 2, y2 = b.top + b.height / 2;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2 - 60;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`);
      path.setAttribute('marker-end', 'url(#ah)');
      const id = 'arr' + (++counter);
      path.dataset.id = id;
      svg.appendChild(path);
      items.set(id, { el: path, kind: 'arrow' });
      return { ok: true, id };
    },

    scroll_to(refId) {
      const el = window.__pointme_snapshot__?.resolveRef(refId);
      if (!el) return { ok: false, error: 'ref not found' };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { ok: true };
    },

    clear() {
      items.forEach(({ el }) => el.remove());
      items.clear();
      return { ok: true };
    },

    redraw() {
      // 滚动/resize 后，根据保留的 ref 重新算位置
      items.forEach((item, id) => {
        if (item.kind === 'ring') {
          const r = rectOf(item.ref);
          if (!r) { item.el.remove(); items.delete(id); return; }
          Object.assign(item.el.style, {
            left: r.left - 4 + 'px', top: r.top - 4 + 'px',
            width: r.width + 8 + 'px', height: r.height + 8 + 'px'
          });
        } else if (item.kind === 'annot') {
          const r = rectOf(item.ref);
          if (!r) return;
          Object.assign(item.el.style, {
            left: Math.min(r.right + 16, window.innerWidth - 300) + 'px',
            top: Math.max(8, r.top) + 'px'
          });
        }
        // arrow: 实际项目里也该重画，黑客松省略
      });
    }
  };

  // 滚动/缩放时跟着重画
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; cmd.redraw(); }); };
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule);

  window.__pointme_overlay__ = cmd;
})();
