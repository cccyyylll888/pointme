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
import { streamAnthropicMessages } from './anthropic_stream.js';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
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
        observed: { kind: 'navigation' },
        // 强命令：阻止 LLM 误判任务结束 → 必须 observe + say_step 继续
        next_action_required: 'NAVIGATION_DETECTED. The user successfully completed the previous step and the page has navigated. The overall task is NOT finished — keep guiding. You MUST: (1) call observe to fetch the new page snapshot; (2) call clear_overlay; (3) call say_step with stepNumber = previous + 1 describing the next action; (4) call highlight/annotate/wait_for_user_action for the next interaction. DO NOT call done. DO NOT just output text.'
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
  const MAX_STUCK_RETRIES = 2;
  let stuckRetries = 0;

  // 流式回调：在 LLM 还没结束输出时，提前把 say_step 的内容流到 sidebar
  const onPartialStep = (partial) => {
    sendToPort(session, { type: 'step_streaming', runId: session.runId, ...partial }).catch(() => {});
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await callLLM(session.messages, onPartialStep);
    const blocks = resp.content || [];

    const assistantContent = [];
    const toolCalls = [];
    const textParts = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text.trim()) {
          assistantContent.push({ type: 'text', text: block.text });
          textParts.push(block.text);
        }
      } else if (block.type === 'tool_use') {
        assistantContent.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        toolCalls.push(block);
      }
    }
    console.log(`[PointMe agent] round=${round} tools=[${toolCalls.map(t => t.name).join(',')}] text="${textParts.join(' ').slice(0, 120)}"`);
    if (assistantContent.length) session.messages.push({ role: 'assistant', content: assistantContent });

    if (toolCalls.length === 0) {
      // text-only 自救：LLM 没调任何工具，用户看不到任何东西。多数情况是 MiniMax 等
      // 不严格遵守"必须调 tool"的指令，加一条 user 消息硬拉它回协议轨道。
      if (stuckRetries < MAX_STUCK_RETRIES) {
        stuckRetries++;
        console.warn(`[PointMe agent] no tool calls — coercing retry ${stuckRetries}/${MAX_STUCK_RETRIES}`);
        session.messages.push({
          role: 'user',
          content: 'PROTOCOL VIOLATION: You returned plain text instead of calling tools. The user CANNOT see plain text — only tool outputs (say_step, highlight, etc.) reach the UI. You MUST call tools now. If the page just navigated, call: observe → clear_overlay → say_step (stepNumber +1) → highlight → wait_for_user_action. If the task is genuinely complete, call done({summary}). Otherwise continue with the next step. Do NOT respond with text only again.'
        });
        continue;
      }
      // 重试用尽 → 至少给用户一句反馈
      const stuckMsg = { kind: 'step', stepNumber: 0, instruction: 'AI 没按协议给出指令', detail: '它只输出了文字没调工具。可以重问一次，或在 Options 里换 provider。' };
      session.displayLog.push(stuckMsg);
      await sendToPort(session, { type: 'display_step', runId: session.runId, ...stuckMsg });
      return;
    }
    stuckRetries = 0;

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

async function callLLM(messages, onPartialStep) {
  const cfg = await chrome.storage.local.get([
    'provider', 'apiKey', 'proxyUrl',
    'openaiBaseUrl', 'openaiModel', 'openaiKey',
    'streaming'
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
      maxTokens: 2048,
      useStreaming: !!cfg.streaming,
      onPartialStep
    });
  }

  return await callAnthropic(messages, cfg, onPartialStep);
}

async function callAnthropic(messages, cfg, onPartialStep) {
  const url = cfg.proxyUrl || ANTHROPIC_API_DEFAULT;
  const useDirect = !cfg.proxyUrl;
  if (useDirect && !cfg.apiKey) {
    throw new Error('未配置 Anthropic API key — 点扩展图标 → Options 贴一个进去');
  }

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    messages
  };
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (useDirect) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  // streaming 模式（cfg.streaming === true）实验性，MV3 SW 下偶发卡死；默认走非流式
  if (cfg.streaming) {
    return await streamAnthropicMessages({ url, headers, body, onPartialStep });
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Claude API ${r.status}: ${text.slice(0, 300)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timeoutId);
  }
}
