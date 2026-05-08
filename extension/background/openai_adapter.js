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
      const msg = { role: 'assistant' };
      msg.content = texts.length ? texts.join('\n') : null;
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

// === 调用 ===
export async function callOpenAICompatible({ baseUrl, model, apiKey, system, messages, tools, maxTokens = 1024 }) {
  if (!baseUrl) throw new Error('OpenAI 兼容：未配置 Base URL');
  if (!model)   throw new Error('OpenAI 兼容：未配置 Model 名称');
  if (!apiKey)  throw new Error('OpenAI 兼容：未配置 API Key');

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model,
    max_tokens: maxTokens,
    messages: anthropicToOpenAIMessages(system, messages),
    tools: anthropicToOpenAITools(tools),
    tool_choice: 'auto'
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`OpenAI 兼容 API ${r.status}: ${text.slice(0, 400)}`);
  }
  const json = await r.json();
  return openAIResponseToAnthropic(json);
}
