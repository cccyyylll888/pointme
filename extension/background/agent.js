// agent.js — service worker，跑 Claude agent loop
// 关键设计：session 按 tabId 维护，跨页面跳转不丢历史；port 断开时 pending tool 自动解为 navigation 事件
//
// 协议（与 content/main.js 对接）：
//   ← user_message      {text, snapshot}
//   ← tool_result       {toolUseId, result}
//   → tool_call         {runId, toolUseId, tool, input}
//   → display_step      {runId, stepNumber, instruction, detail}     // say_step 的 UI 渲染
//   → restore_history   {items: [{kind:'user'|'step', ...}]}         // content script 重新注入时回填
//   → done              {runId}
//   → error             {runId, error}

import { TOOLS, SYSTEM_PROMPT } from './prompts.js';
import { callOpenAICompatible } from './openai_adapter.js';

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_DEFAULT = 'https://api.anthropic.com/v1/messages';
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 小时无活动清掉

// tabId -> session
const sessions = new Map();

function newSession() {
  return {
    messages: [],          // Anthropic-format 完整对话历史（包含 tool 调用）
    displayLog: [],        // 给 sidebar 看的历史：[{kind:'user', text} | {kind:'step', stepNumber, instruction, detail}]
    port: null,
    pendingToolResult: null,  // {toolUseId, resolve}
    waitForPort: null,        // resolve when port reconnects
    runId: 0,
    lastActiveAt: Date.now()
  };
}

function getSession(tabId) {
  let s = sessions.get(tabId);
  if (!s) { s = newSession(); sessions.set(tabId, s); }
  s.lastActiveAt = Date.now();
  return s;
}

// 定期 GC
setInterval(() => {
  const now = Date.now();
  for (const [tabId, s] of sessions) {
    if (!s.port && now - s.lastActiveAt > SESSION_TTL_MS) sessions.delete(tabId);
  }
}, 5 * 60 * 1000);

// tab 关闭就直接清掉对应 session
chrome.tabs?.onRemoved.addListener((tabId) => sessions.delete(tabId));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pointme-agent') return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;

  const session = getSession(tabId);
  session.port = port;

  // 唤醒等 port 的 send 操作
  if (session.waitForPort) { session.waitForPort(); session.waitForPort = null; }

  // 把历史回填到新 sidebar（content script 重启会清空 UI）
  if (session.displayLog.length) {
    port.postMessage({ type: 'restore_history', items: session.displayLog });
  }

  port.onDisconnect.addListener(() => {
    if (session.port === port) session.port = null;
    // pending tool result 自动解 → 让 agent 收到 navigation 事件继续
    if (session.pendingToolResult) {
      session.pendingToolResult.resolve({
        ok: true,
        observed: { kind: 'navigation', note: '页面已跳转，content script 重连后请 observe' }
      });
      session.pendingToolResult = null;
    }
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'user_message') {
      session.runId++;
      session.lastActiveAt = Date.now();
      session.displayLog.push({ kind: 'user', text: msg.text });
      session.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `[CURRENT PAGE SNAPSHOT]\n${JSON.stringify(msg.snapshot, null, 2)}`,
            cache_control: { type: 'ephemeral' } },
          { type: 'text', text: msg.text }
        ]
      });
      try {
        await runAgentLoop(session);
        sendToPort(session, { type: 'done', runId: session.runId });
      } catch (e) {
        console.error('[PointMe agent]', e);
        sendToPort(session, { type: 'error', runId: session.runId, error: String(e?.message || e) });
      }
      return;
    }

    if (msg.type === 'tool_result') {
      session.lastActiveAt = Date.now();
      const pending = session.pendingToolResult;
      if (pending && pending.toolUseId === msg.toolUseId) {
        pending.resolve(msg.result);
      }
    }
  });
});

// 给 content 发消息；如果当前 port 断开（用户跳转中），就等到 reconnect
async function sendToPort(session, msg) {
  while (!session.port) {
    await new Promise((resolve) => { session.waitForPort = resolve; });
  }
  try { session.port.postMessage(msg); }
  catch (e) {
    // port 在发送瞬间断了 → 等下一个
    session.port = null;
    return sendToPort(session, msg);
  }
}

async function runAgentLoop(session) {
  const MAX_ROUNDS = 25;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await callLLM(session.messages);
    const blocks = resp.content || [];

    const assistantContent = [];
    const toolCalls = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        // 不再向用户展示原始 text — 只作为 agent 内部 reasoning 留在 messages 里
        if (block.text.trim()) assistantContent.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        assistantContent.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        toolCalls.push(block);
      }
    }
    if (assistantContent.length) session.messages.push({ role: 'assistant', content: assistantContent });

    if (toolCalls.length === 0) return;

    const toolResultBlocks = [];
    for (const tc of toolCalls) {
      const result = await invokeContentTool(session, tc.id, tc.name, tc.input);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result)
      });
      if (tc.name === 'done') {
        session.messages.push({ role: 'user', content: toolResultBlocks });
        return;
      }
    }
    session.messages.push({ role: 'user', content: toolResultBlocks });
  }
  // 超轮：用 say_step 风格通知用户
  session.displayLog.push({ kind: 'step', stepNumber: 0, instruction: '思路太长，先停一下', detail: '我已经达到最大轮数。可以再问一次或换个问法。' });
  await sendToPort(session, { type: 'display_step', runId: session.runId, stepNumber: 0, instruction: '思路太长，先停一下', detail: '我已经达到最大轮数。可以再问一次或换个问法。' });
}

// 工具调用：say_step 直接 background 内处理（不发给 content 执行业务，但要通知 sidebar 渲染）；
// 其它工具走 content script
async function invokeContentTool(session, toolUseId, name, input) {
  if (name === 'say_step') {
    const item = {
      kind: 'step',
      stepNumber: input.stepNumber,
      instruction: input.instruction,
      detail: input.detail || ''
    };
    session.displayLog.push(item);
    await sendToPort(session, { type: 'display_step', runId: session.runId, ...item });
    return { ok: true };
  }

  return await new Promise((resolve) => {
    session.pendingToolResult = {
      toolUseId,
      resolve: (v) => { session.pendingToolResult = null; resolve(v); }
    };
    sendToPort(session, { type: 'tool_call', runId: session.runId, toolUseId, tool: name, input })
      .catch((e) => { session.pendingToolResult = null; resolve({ ok: false, error: String(e?.message || e) }); });
  });
}

async function callLLM(messages) {
  const cfg = await chrome.storage.local.get([
    'provider', 'apiKey', 'proxyUrl',
    'openaiBaseUrl', 'openaiModel', 'openaiKey'
  ]);
  const provider = cfg.provider || 'anthropic';

  if (provider === 'openai') {
    return await callOpenAICompatible({
      baseUrl: cfg.openaiBaseUrl,
      model:   cfg.openaiModel,
      apiKey:  cfg.openaiKey,
      system:  SYSTEM_PROMPT,
      messages,
      tools:   TOOLS,
      maxTokens: 1024
    });
  }

  return await callAnthropic(messages, cfg);
}

async function callAnthropic(messages, cfg) {
  const url = cfg.proxyUrl || ANTHROPIC_API_DEFAULT;
  const useDirect = !cfg.proxyUrl;
  if (useDirect && !cfg.apiKey) {
    throw new Error('未配置 Anthropic API key — 点扩展图标 → Options 贴一个进去');
  }

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    messages
  };
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (useDirect) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Claude API ${r.status}: ${text.slice(0, 300)}`);
  }
  return await r.json();
}
