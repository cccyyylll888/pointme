// observer.js — 监听用户的实际操作；wait_for_user_action 在这里兑现
// 支持三种 condition：
//   - {type:"click", refId}                 用户点了某元素
//   - {type:"url_changes", contains?}       URL 变了（可选包含子串）
//   - {type:"input_filled", refId}          某 input 有了非空值
//   - {type:"any_change"}                   任意 DOM mutation 触发（兜底）
// 也能直接告诉 agent："用户主动点了 X"作为额外 observation

(() => {
  if (window.__pointme_observer__) return;

  let pending = null;            // { condition, resolve, deadline }
  const subscribers = new Set(); // 监听 user click 事件的回调（给 sidebar 用）

  const matches = (cond, evt) => {
    if (!cond) return false;
    switch (cond.type) {
      case 'click':
        return evt.kind === 'click' && evt.refId === cond.refId;
      case 'url_changes':
        return evt.kind === 'urlchange' && (!cond.contains || evt.url.includes(cond.contains));
      case 'input_filled':
        return evt.kind === 'input' && evt.refId === cond.refId && evt.value;
      case 'any_change':
        return evt.kind === 'mutation';
    }
    return false;
  };

  const fire = (evt) => {
    subscribers.forEach(fn => { try { fn(evt); } catch {} });
    if (pending && matches(pending.condition, evt)) {
      const p = pending;
      pending = null;
      p.resolve({ ok: true, observed: evt });
    }
  };

  // 全局 click 捕获（捕获阶段，避免被 stopPropagation）
  document.addEventListener('click', (e) => {
    const path = e.composedPath();
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      const refId = window.__pointme_snapshot__ ? findRef(node) : null;
      if (refId) {
        fire({ kind: 'click', refId, target: describe(node) });
        return;
      }
    }
    fire({ kind: 'click', refId: null, target: describe(e.target) });
  }, true);

  document.addEventListener('input', (e) => {
    const refId = findRef(e.target);
    if (refId) fire({ kind: 'input', refId, value: e.target.value || '' });
  }, true);

  // URL 变化（SPA 友好）
  let lastUrl = location.href;
  const checkUrl = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      fire({ kind: 'urlchange', url: location.href });
    }
  };
  setInterval(checkUrl, 300);

  // 兜底 mutation 监听（节流）
  let mutTimer = 0;
  new MutationObserver(() => {
    if (mutTimer) return;
    mutTimer = setTimeout(() => { mutTimer = 0; fire({ kind: 'mutation' }); }, 400);
  }).observe(document.body, { childList: true, subtree: true, attributes: true });

  // 反查 element → refId（重新 snapshot 后才能拿到）
  const findRef = (el) => {
    const snap = window.__pointme_snapshot__;
    if (!snap) return null;
    // 简化：从 el 沿祖先回溯，看哪个被分配了 ref
    // 因为 snapshot 只在 capture 时分配，这里需要 capture 一次或维护一个反向 map
    // 黑客松里我们让 main.js 在每次 wait 前先 capture，让 ref 是最新的
    let node = el;
    while (node && node !== document.body) {
      const r = snap._reverseLookup?.(node);
      if (r) return r;
      node = node.parentElement;
    }
    return null;
  };

  const describe = (el) => {
    if (!(el instanceof Element)) return '';
    const tag = el.tagName?.toLowerCase();
    const text = (el.innerText || el.value || '').trim().slice(0, 50);
    return `<${tag}> ${text}`;
  };

  window.__pointme_observer__ = {
    waitFor(condition, { timeoutMs = 120000 } = {}) {
      // 取消上一个未结的等待
      if (pending) { pending.resolve({ ok: false, error: 'superseded' }); pending = null; }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending && pending.resolve === resolve) { pending = null; resolve({ ok: false, error: 'timeout' }); }
        }, timeoutMs);
        pending = { condition, resolve: (v) => { clearTimeout(timer); resolve(v); }, deadline: Date.now() + timeoutMs };
      });
    },
    cancelWait() { if (pending) { pending.resolve({ ok: false, error: 'cancelled' }); pending = null; } },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
  };
})();
