// snapshot.js — 把当前页面压成精简 a11y JSON，给每个交互元素分配稳定的 refId
// 设计原则：
//   1. 只收"可交互 + 可见 + 在视口附近"的元素 — 控制 token
//   2. refId 与 DOM 元素保持双向映射，便于 overlay 反查
//   3. 输出结构既要让 LLM 看懂语义，又要简短

(() => {
  if (window.__pointme_snapshot__) return;

  const INTERACTIVE_SELECTORS = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]',
    '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=combobox]',
    '[role=textbox]', '[role=searchbox]', '[role=option]',
    '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  // refId ↔ Element 双向映射（弱引用，元素被 GC 自动清掉）
  const refToEl = new Map();
  const elToRef = new WeakMap();
  let refCounter = 0;

  const getRef = (el) => {
    let r = elToRef.get(el);
    if (r) return r;
    r = 'r' + (++refCounter);
    elToRef.set(el, r);
    refToEl.set(r, new WeakRef(el));
    return r;
  };

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  };

  // 离视口 1 屏内的也保留 — agent 可能要 scroll_to
  const isNear = (el) => {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    return rect.bottom > -vh && rect.top < vh * 2 && rect.right > -vw && rect.left < vw * 2;
  };

  const accessibleName = (el) => {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      (el.innerText || '').trim().slice(0, 80) ||
      el.getAttribute('name') ||
      el.value ||
      ''
    ).replace(/\s+/g, ' ').trim();
  };

  const elementRole = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return el.type || 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return tag;
  };

  const summarize = (el) => {
    const rect = el.getBoundingClientRect();
    const node = {
      ref: getRef(el),
      role: elementRole(el),
      name: accessibleName(el),
      pos: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
    };
    if (el.getAttribute('aria-pressed')) node.pressed = el.getAttribute('aria-pressed') === 'true';
    if (el.getAttribute('aria-expanded')) node.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.getAttribute('aria-current')) node.current = true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
    if (el.value && el.tagName === 'INPUT') node.value = String(el.value).slice(0, 60);
    if (el.tagName === 'A' && el.href) node.href = el.href.slice(0, 120);
    return node;
  };

  const capture = ({ includeOffscreen = false } = {}) => {
    refToEl.clear();   // 每次 snapshot 重新分配 ref，避免老 ref 漂移
    refCounter = 0;
    const all = Array.from(document.querySelectorAll(INTERACTIVE_SELECTORS));
    const filtered = all.filter(el => isVisible(el) && (includeOffscreen || isNear(el)));

    // 同样保留页面主标题/h1-h3 当锚点 — 给 agent 看上下文
    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter(isVisible).slice(0, 12)
      .map(h => ({ role: 'heading', level: +h.tagName[1], name: h.innerText.trim().slice(0, 80) }));

    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: window.scrollY },
      headings,
      elements: filtered.map(summarize)
    };
  };

  const resolveRef = (refId) => {
    const wr = refToEl.get(refId);
    if (!wr) return null;
    const el = wr.deref();
    if (!el || !document.contains(el)) return null;
    return el;
  };

  // 反查：Element → refId（仅当该元素在最近一次 capture 中被分配过 ref 才有结果）
  const _reverseLookup = (el) => elToRef.get(el) || null;

  window.__pointme_snapshot__ = { capture, resolveRef, _reverseLookup };
})();
