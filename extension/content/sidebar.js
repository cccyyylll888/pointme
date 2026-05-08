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
