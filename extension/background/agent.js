// agent.js — service worker，跑 Claude agent loop
// 协议（与 content/main.js 对接）：
//   ← user_message {runId, text, snapshot}
//   → assistant_text {runId, text}
//   → tool_call {runId, toolUseId, tool, input}
//   ← tool_result {runId, toolUseId, result}
//   → done {runId}
//   → error {runId, error}

import { TOOLS, SYSTEM_PROMPT } from './prompts.js';

const MODEL = 'claude-sonnet-4-6';
const API_BASE_DEFAULT = 'https://api.anthropic.com/v1/messages';

// 每个 port 一个会话状态；切到新 tab 重连时上下文重置
const sessions = new Map(); // portId -> { messages, runId }

let portIdCounter = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pointme-agent') return;
  const portId = ++portIdCounter;
  sessions.set(portId, { messages: [], runId: 0 });

  port.onDisconnect.addListener(() => sessions.delete(portId));

  port.onMessage.addListener(async (msg) => {
    const session = sessions.get(portId);
    if (!session) return;

    if (msg.type === 'user_message') {
      session.runId = msg.runId;
      // 用户文本 + 当前页 snapshot 一并交给 Claude
      session.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `[CURRENT PAGE SNAPSHOT]\n${JSON.stringify(msg.snapshot, null, 2)}`,
            cache_control: { type: 'ephemeral' } },   // 大块、稳定 → 缓存
          { type: 'text', text: msg.text }
        ]
      });
      try {
        await runAgentLoop(port, session);
        port.postMessage({ type: 'done', runId: session.runId });
      } catch (e) {
        console.error('[PointMe agent]', e);
        port.postMessage({ type: 'error', runId: session.runId, error: String(e?.message || e) });
      }
      return;
    }

    if (msg.type === 'tool_result') {
      // 由 runAgentLoop 内部 pendingToolResult promise 兑现
      const pending = session._pendingToolResult;
      if (pending && pending.toolUseId === msg.toolUseId) {
        pending.resolve(msg.result);
      }
    }
  });
});

async function runAgentLoop(port, session) {
  const MAX_ROUNDS = 25;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await callClaude(session.messages);
    const blocks = resp.content || [];

    // 收集助手输出（文本 + 工具调用）
    const assistantContent = [];
    const toolCalls = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        assistantContent.push({ type: 'text', text: block.text });
        if (block.text.trim()) {
          port.postMessage({ type: 'assistant_text', runId: session.runId, text: block.text });
        }
      } else if (block.type === 'tool_use') {
        assistantContent.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        toolCalls.push(block);
      }
    }
    session.messages.push({ role: 'assistant', content: assistantContent });

    // 没有工具调用 → 一轮结束
    if (toolCalls.length === 0) return;

    // 把每个工具调用发给 content script 执行，收集结果
    const toolResultBlocks = [];
    for (const tc of toolCalls) {
      const result = await invokeContentTool(port, session, tc.id, tc.name, tc.input);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result)
      });
      // done 工具一旦被调用就终止
      if (tc.name === 'done') {
        session.messages.push({ role: 'user', content: toolResultBlocks });
        return;
      }
    }
    session.messages.push({ role: 'user', content: toolResultBlocks });
  }
  port.postMessage({ type: 'assistant_text', runId: session.runId, text: '（已达最大轮数，停下让你接手）' });
}

function invokeContentTool(port, session, toolUseId, name, input) {
  return new Promise((resolve) => {
    session._pendingToolResult = { toolUseId, resolve: (v) => {
      session._pendingToolResult = null;
      resolve(v);
    } };
    port.postMessage({ type: 'tool_call', runId: session.runId, toolUseId, tool: name, input });
  });
}

async function callClaude(messages) {
  const { apiKey, proxyUrl } = await chrome.storage.local.get(['apiKey', 'proxyUrl']);
  const url = proxyUrl || API_BASE_DEFAULT;
  const useDirect = !proxyUrl;
  if (useDirect && !apiKey) {
    throw new Error('未配置 API key — 点扩展图标 → Options 贴一个进去');
  }

  const body = {
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    messages
  };

  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (useDirect) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Claude API ${r.status}: ${text.slice(0, 300)}`);
  }
  return await r.json();
}
