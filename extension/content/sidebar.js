// sidebar.js — 右下角小人 + 对话面板
// 暴露 pointmeSidebar.{open, close, addMessage, setThinking, onSubmit}

(() => {
  if (window.__pointme_sidebar__) return;

  const root = document.createElement('div');
  root.id = '__pointme_sidebar_root__';
  root.innerHTML = `
    <div class="pm-panel">
      <div class="pm-header">
        <span>PointMe · 网页向导</span>
        <button class="pm-close" title="关闭">×</button>
      </div>
      <div class="pm-log"></div>
      <div class="pm-input">
        <textarea placeholder="问我怎么用这个网站… (Enter 发送, Shift+Enter 换行)"></textarea>
        <button class="pm-send">发送</button>
      </div>
    </div>
    <div class="pm-mascot" title="召唤 PointMe">🦊</div>
  `;
  document.documentElement.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const log = $('.pm-log');
  const ta = $('.pm-input textarea');
  const sendBtn = $('.pm-send');
  const mascot = $('.pm-mascot');

  let submitHandler = null;

  const open = () => root.classList.add('open');
  const close = () => root.classList.remove('open');
  const isOpen = () => root.classList.contains('open');

  mascot.addEventListener('click', () => isOpen() ? close() : open());
  $('.pm-close').addEventListener('click', close);

  // === 拖拽逻辑 ===
  // 改 root 的 right/bottom 让悬浮球可以被拖到任意位置；位置存 localStorage 跨页面记忆
  // 区分 click 和 drag：超过 4px 移动算 drag，drag 结束后吞掉随后的 click 防止 toggle 误触发
  const POS_KEY = '__pointme_pos__';
  const MARGIN = 8;
  const MASCOT_SIZE = 56;

  const clampAndSet = (rightPx, bottomPx) => {
    const maxR = Math.max(MARGIN, window.innerWidth  - MASCOT_SIZE - MARGIN);
    const maxB = Math.max(MARGIN, window.innerHeight - MASCOT_SIZE - MARGIN);
    const r = Math.max(MARGIN, Math.min(maxR, rightPx));
    const b = Math.max(MARGIN, Math.min(maxB, bottomPx));
    root.style.right  = r + 'px';
    root.style.bottom = b + 'px';
    return { r, b };
  };

  // 恢复上次位置
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) {
      clampAndSet(saved.right, saved.bottom);
    }
  } catch {}

  // 窗口缩小时把球拉回视口
  window.addEventListener('resize', () => {
    const r = parseFloat(root.style.right)  || 16;
    const b = parseFloat(root.style.bottom) || 16;
    clampAndSet(r, b);
  });

  let drag = null;
  let suppressNextClick = false;

  mascot.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = root.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origRight:  window.innerWidth  - rect.right,
      origBottom: window.innerHeight - rect.bottom,
      moved: false
    };
    try { mascot.setPointerCapture(e.pointerId); } catch {}
    mascot.classList.add('pm-dragging');
  });

  mascot.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    clampAndSet(drag.origRight - dx, drag.origBottom - dy);
  });

  const finishDrag = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    try { mascot.releasePointerCapture(e.pointerId); } catch {}
    mascot.classList.remove('pm-dragging');
    if (drag.moved) {
      suppressNextClick = true;
      const r = parseFloat(root.style.right)  || 16;
      const b = parseFloat(root.style.bottom) || 16;
      try { localStorage.setItem(POS_KEY, JSON.stringify({ right: r, bottom: b })); } catch {}
    }
    drag = null;
  };
  mascot.addEventListener('pointerup', finishDrag);
  mascot.addEventListener('pointercancel', finishDrag);

  // 捕获阶段拦截 drag 之后那次 click，避免拖完之后顺手把面板 toggle 掉
  mascot.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  const send = () => {
    const text = ta.value.trim();
    if (!text || !submitHandler) return;
    ta.value = '';
    submitHandler(text);
  };

  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // 把 LLM 偶发输出的轻量 markdown 渲染成 HTML（先转义防 XSS，再有限替换）
  const renderInline = (text) => {
    if (text == null) return '';
    let s = String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '<em>$1</em>');
    s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
    s = s.replace(/「([^」\n]+?)」/g, '<strong>「$1」</strong>');
    s = s.replace(/\n/g, '<br>');
    return s;
  };

  const addMessage = (role, text) => {
    const div = document.createElement('div');
    div.className = 'pm-msg ' + role;
    if (role === 'tool' || role === 'user') div.textContent = text;
    else div.innerHTML = renderInline(text);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  };

  // stepNumber → cardEl，用于流式更新同一张卡片
  const stepCards = new Map();

  const buildCard = (stepNumber) => {
    const card = document.createElement('div');
    card.className = 'pm-step pm-step-streaming';
    const badge = document.createElement('div');
    badge.className = 'pm-step-badge';
    badge.textContent = stepNumber > 0 ? String(stepNumber) : '!';
    const body = document.createElement('div');
    body.className = 'pm-step-body';
    const inst = document.createElement('div');
    inst.className = 'pm-step-instruction';
    body.appendChild(inst);
    card.appendChild(badge);
    card.appendChild(body);
    log.appendChild(card);
    return card;
  };

  // 创建或更新步骤卡片；finalized=true 时收掉流式光标
  const upsertStep = (stepNumber, instruction, detail, finalized) => {
    let card = stepCards.get(stepNumber);
    if (!card) {
      card = buildCard(stepNumber);
      stepCards.set(stepNumber, card);
    }
    const inst = card.querySelector('.pm-step-instruction');
    inst.innerHTML = renderInline(instruction || '');

    let det = card.querySelector('.pm-step-detail');
    if (detail) {
      if (!det) {
        det = document.createElement('div');
        det.className = 'pm-step-detail';
        card.querySelector('.pm-step-body').appendChild(det);
      }
      det.innerHTML = renderInline(detail);
    } else if (det) {
      det.remove();
    }
    if (finalized) card.classList.remove('pm-step-streaming');
    log.scrollTop = log.scrollHeight;
    return card;
  };

  // 兼容旧调用
  const addStep = upsertStep;

  const clearLog = () => {
    log.innerHTML = '';
    stepCards.clear();
  };

  const setThinking = (b) => {
    mascot.classList.toggle('thinking', !!b);
    sendBtn.disabled = !!b;
  };

  window.__pointme_sidebar__ = {
    open, close, isOpen,
    addMessage, addStep, upsertStep, clearLog, setThinking,
    onSubmit(fn) { submitHandler = fn; }
  };
})();
