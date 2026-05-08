// main.js — content script 总线
// 把 sidebar 的用户输入发给 background，把 background 的工具调用执行掉，返回结果

(() => {
  if (window.__pointme_main__) return;
  window.__pointme_main__ = true;

  const sidebar = window.__pointme_sidebar__;
  const overlay = window.__pointme_overlay__;
  const snap = window.__pointme_snapshot__;
  const observer = window.__pointme_observer__;

  if (!sidebar || !overlay || !snap || !observer) {
    console.error('[PointMe] missing module', { sidebar, overlay, snap, observer });
    return;
  }

  let port = null;

  const ensurePort = () => {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'pointme-agent' });
    port.onMessage.addListener(handleAgentMessage);
    port.onDisconnect.addListener(() => { port = null; });
    return port;
  };

  // 一注入就先建 port，让 background 立刻推 restore_history（页面跳转后回填历史）
  ensurePort();

  async function handleAgentMessage(msg) {
    if (msg.type === 'restore_history') {
      sidebar.clearLog();
      for (const item of msg.items) {
        if (item.kind === 'user') sidebar.addMessage('user', item.text);
        else if (item.kind === 'step') sidebar.upsertStep(item.stepNumber, item.instruction, item.detail, true);
      }
      // 历史里如果最后一步还没 done，意味着 agent 在等用户做完那一步——
      // 但跨 nav 后 overlay 已经丢，没法恢复高亮。先 open 面板提示用户可继续。
      if (msg.items.length) sidebar.open();
      return;
    }
    if (msg.type === 'step_streaming') {
      sidebar.upsertStep(msg.stepNumber, msg.instruction || '', msg.detail || '');
      sidebar.open();
      return;
    }
    if (msg.type === 'display_step') {
      // streaming 完成后的最终权威版本，关掉光标
      sidebar.upsertStep(msg.stepNumber, msg.instruction, msg.detail, true);
      sidebar.open();
      return;
    }
    if (msg.type === 'tool_call') {
      const result = await executeTool(msg.tool, msg.input);
      port?.postMessage({ type: 'tool_result', toolUseId: msg.toolUseId, result });
      return;
    }
    if (msg.type === 'done') {
      sidebar.setThinking(false);
      return;
    }
    if (msg.type === 'error') {
      sidebar.addMessage('error', '❌ ' + msg.error);
      sidebar.setThinking(false);
      return;
    }
  }

  async function executeTool(name, input) {
    try {
      switch (name) {
        case 'observe': {
          const s = snap.capture({ includeOffscreen: !!input?.includeOffscreen });
          return { ok: true, snapshot: s };
        }
        case 'highlight':       return overlay.highlight(input.refId);
        case 'annotate':        return overlay.annotate(input.refId, input.text);
        case 'draw_arrow':      return overlay.draw_arrow(input.fromRefId, input.toRefId);
        case 'scroll_to':       return overlay.scroll_to(input.refId);
        case 'clear_overlay':   return overlay.clear();
        case 'wait_for_user_action': {
          snap.capture(); // 等待前刷新一次 ref 表，让 click 反查能命中
          return await observer.waitFor(input.condition, { timeoutMs: input.timeoutMs || 120000 });
        }
        case 'ask_user': {
          sidebar.addMessage('assistant', '❓ ' + input.question);
          sidebar.open();
          return await new Promise((resolve) => {
            const handler = (text) => {
              sidebar.onSubmit(originalHandler);
              resolve({ ok: true, answer: text });
            };
            sidebar.onSubmit(handler);
          });
        }
        case 'done': {
          overlay.clear();
          sidebar.addMessage('assistant', '✅ ' + (input.summary || '完成'));
          sidebar.setThinking(false);
          return { ok: true };
        }
        default:
          return { ok: false, error: 'unknown tool: ' + name };
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  let originalHandler;
  originalHandler = (text) => {
    sidebar.addMessage('user', text);
    sidebar.setThinking(true);
    const initialSnap = snap.capture();
    ensurePort().postMessage({
      type: 'user_message',
      text,
      snapshot: initialSnap
    });
  };
  sidebar.onSubmit(originalHandler);
})();
