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
    const node = {
      ref: getRef(el),
      role: elementRole(el),
      name: accessibleName(el).slice(0, 50)
    };
    // 只保留 LLM 真正会用到的状态字段
    if (el.getAttribute('aria-expanded') === 'true') node.expanded = true;
    if (el.getAttribute('aria-pressed') === 'true') node.pressed = true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
    if (el.value && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      node.value = String(el.value).slice(0, 30);
    }
    return node;
  };

  // 视口内的元素优先；多余的丢弃。max 默认 80（足够复杂页面），过多反而稀释 LLM 注意力
  const capture = ({ includeOffscreen = false, max = 80 } = {}) => {
    refToEl.clear();
    refCounter = 0;
    const all = Array.from(document.querySelectorAll(INTERACTIVE_SELECTORS));
    let filtered = all.filter(el => isVisible(el) && (includeOffscreen || isNear(el)));

    // 视口内排前面（agent 通常关心当前视野），超出 max 的截掉
    filtered.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const inA = ra.top >= 0 && ra.top < window.innerHeight ? 0 : 1;
      const inB = rb.top >= 0 && rb.top < window.innerHeight ? 0 : 1;
      return inA - inB || ra.top - rb.top;
    });
    if (filtered.length > max) filtered = filtered.slice(0, max);

    return {
      url: location.href,
      title: document.title.slice(0, 100),
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
