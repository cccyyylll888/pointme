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
  let currentRunId = 0;

  const ensurePort = () => {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'pointme-agent' });
    port.onMessage.addListener(handleAgentMessage);
    port.onDisconnect.addListener(() => { port = null; });
    return port;
  };

  // 处理 background 发来的消息
  async function handleAgentMessage(msg) {
    if (msg.runId !== currentRunId) return; // 老 run 的回声，丢弃

    if (msg.type === 'assistant_text') {
      sidebar.addMessage('assistant', msg.text);
      return;
    }
    if (msg.type === 'tool_call') {
      const result = await executeTool(msg.tool, msg.input);
      sidebar.addMessage('tool', `🔧 ${msg.tool}(${shortJson(msg.input)}) → ${shortJson(result).slice(0, 80)}`);
      port.postMessage({ type: 'tool_result', runId: msg.runId, toolUseId: msg.toolUseId, result });
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

  // 执行 agent 的工具调用
  async function executeTool(name, input) {
    try {
      switch (name) {
        case 'observe': {
          const s = snap.capture({ includeOffscreen: !!input?.includeOffscreen });
          // 只发文字 a11y 树；截图 demo 里先省略，token 太贵
          return { ok: true, snapshot: s };
        }
        case 'highlight':       return overlay.highlight(input.refId);
        case 'annotate':        return overlay.annotate(input.refId, input.text);
        case 'draw_arrow':      return overlay.draw_arrow(input.fromRefId, input.toRefId);
        case 'scroll_to':       return overlay.scroll_to(input.refId);
        case 'clear_overlay':   return overlay.clear();
        case 'wait_for_user_action': {
          // 等之前先重新 snapshot 一次，确保 ref 是最新可见的
          snap.capture();
          return await observer.waitFor(input.condition, { timeoutMs: input.timeoutMs || 120000 });
        }
        case 'ask_user': {
          sidebar.addMessage('assistant', '❓ ' + input.question);
          return await new Promise((resolve) => {
            const handler = (text) => {
              sidebar.onSubmit(originalHandler); // 还原
              resolve({ ok: true, answer: text });
            };
            sidebar.onSubmit(handler);
          });
        }
        case 'done': {
          overlay.clear();
          sidebar.addMessage('assistant', '✅ ' + (input.summary || '完成'));
          return { ok: true };
        }
        default:
          return { ok: false, error: 'unknown tool: ' + name };
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // 工具栏小人对话框 → 用户提交问题
  let originalHandler;
  originalHandler = (text) => {
    sidebar.addMessage('user', text);
    sidebar.setThinking(true);
    currentRunId++;
    const initialSnap = snap.capture();
    ensurePort().postMessage({
      type: 'user_message',
      runId: currentRunId,
      text,
      snapshot: initialSnap
    });
  };
  sidebar.onSubmit(originalHandler);

  function shortJson(o) {
    try { return JSON.stringify(o); } catch { return String(o); }
  }
})();
