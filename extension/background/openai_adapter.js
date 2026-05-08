// openai_adapter.js — 把 Anthropic 风格的消息/工具/响应翻译到 OpenAI 兼容协议
// 目标：agent loop 内部仍然只看 Anthropic 格式，provider 切换无感

// === Messages: Anthropic → OpenAI ===
export function anthropicToOpenAIMessages(systemText, anthropicMessages) {
  const out = [];
  if (systemText) out.push({ role: 'system', content: systemText });

  for (const m of anthropicMessages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];

    if (m.role === 'user') {
      // user 消息里可能混着 text 和 tool_result：tool_result 拆成独立 tool message
      const textParts = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          textParts.push(b.text);
        } else if (b.type === 'tool_result') {
          // 先把累积的 text flush 掉
          if (textParts.length) {
            out.push({ role: 'user', content: textParts.join('\n\n') });
            textParts.length = 0;
          }
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
          });
        }
      }
      if (textParts.length) {
        out.push({ role: 'user', content: textParts.join('\n\n') });
      }
    } else if (m.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
          });
        }
      }
      // 注意：MiniMax / 部分国产兼容 API 不接受 content=null（即使有 tool_calls），用空字符串兜底
      const msg = {
        role: 'assistant',
        content: texts.length ? texts.join('\n') : ''
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

// === Tools: Anthropic → OpenAI ===
export function anthropicToOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} }
    }
  }));
}

// === Response: OpenAI → Anthropic-style content blocks ===
// 让 agent loop 现有的 block 解析逻辑无需修改
export function openAIResponseToAnthropic(resp) {
  const choice = resp?.choices?.[0];
  if (!choice) {
    throw new Error('OpenAI 响应缺少 choices: ' + JSON.stringify(resp).slice(0, 200));
  }
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let parsed = {};
    try { parsed = JSON.parse(tc.function?.arguments || '{}'); }
    catch (e) { parsed = { __raw: tc.function?.arguments, __parseError: e.message }; }
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function?.name,
      input: parsed
    });
  }
  return { content, stop_reason: choice.finish_reason };
}

// === 非流式调用（保留作为 fallback）===
export async function callOpenAICompatible({ baseUrl, model, apiKey, system, messages, tools, maxTokens = 1024, onPartialStep }) {
  if (!baseUrl) throw new Error('OpenAI 兼容：未配置 Base URL');
  if (!model)   throw new Error('OpenAI 兼容：未配置 Model 名称');
  if (!apiKey)  throw new Error('OpenAI 兼容：未配置 API Key');

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const baseBody = {
    model,
    max_tokens: maxTokens,
    messages: anthropicToOpenAIMessages(system, messages),
    tools: anthropicToOpenAITools(tools),
    tool_choice: 'auto'
  };

  // 默认走 streaming —— 提速感知最大的那一招
  return await streamOpenAI({ url, apiKey, body: baseBody, onPartialStep });
}

async function streamOpenAI({ url, apiKey, body, onPartialStep }) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey, 'accept': 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: true })
  });
  if (!r.ok) {
    const text = await r.text();
    console.error('[PointMe openai] request failed', { url, model: body.model, status: r.status, errorBody: text });
    console.error('[PointMe openai] outbound messages:', JSON.stringify(body.messages, null, 2));
    throw new Error(`OpenAI 兼容 API ${r.status}: ${text.slice(0, 400)}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 按 index 累积 tool_calls；OpenAI 流式协议里 tool_call 用 index 标识，arguments 是字符串增量
  const toolAcc = new Map(); // index → { id, name, args }
  let textAcc = '';

  const tryEmitSayStep = (acc) => {
    if (acc.name !== 'say_step') return;
    const json = acc.args || '';
    const stepM = json.match(/"stepNumber"\s*:\s*(\d+)/);
    if (!stepM) return;
    const stepNumber = parseInt(stepM[1], 10);
    const instM = json.match(/"instruction"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const detM  = json.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const instruction = instM ? unescape(instM[1]) : '';
    const detail      = detM  ? unescape(detM[1])  : '';
    const sig = stepNumber + '|' + instruction + '|' + detail;
    if (acc.lastSig === sig) return;
    acc.lastSig = sig;
    onPartialStep?.({ stepNumber, instruction, detail });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string') textAcc += delta.content;

      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        let acc = toolAcc.get(i);
        if (!acc) { acc = { id: null, name: null, args: '' }; toolAcc.set(i, acc); }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) {
          acc.args += tc.function.arguments;
          tryEmitSayStep(acc);
        }
      }
    }
  }

  // 拼成 Anthropic 风格 content blocks
  const content = [];
  if (textAcc.trim()) content.push({ type: 'text', text: textAcc });
  for (const [_, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    let parsed = {};
    try { parsed = acc.args ? JSON.parse(acc.args) : {}; }
    catch (e) { parsed = { __parseError: e.message, __raw: acc.args }; }
    content.push({ type: 'tool_use', id: acc.id || `call_${Math.random().toString(36).slice(2,10)}`, name: acc.name, input: parsed });
  }
  return { content };
}
