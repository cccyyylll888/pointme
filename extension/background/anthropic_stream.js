// anthropic_stream.js — 解析 Anthropic Messages API 的 SSE 流，组装完整 content blocks
// 关键：当某个 tool_use block（特别是 say_step）的 input JSON 在 streaming 中累积时，
//      增量从 partial_json 里提取 stepNumber/instruction/detail，回调 onPartialStep，
//      让 sidebar 在 LLM 还在打字时就开始浮现步骤卡片。

export async function streamAnthropicMessages({ url, headers, body, onPartialStep }) {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Claude API ${r.status}: ${text.slice(0, 300)}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 累积每个 content block：index → { type, id?, name?, text, partialJson, sayStepEmitted }
  const blocks = new Map();

  const tryEmitSayStep = (block) => {
    if (block.type !== 'tool_use' || block.name !== 'say_step') return;
    const json = block.partialJson || '';

    const stepM = json.match(/"stepNumber"\s*:\s*(\d+)/);
    if (!stepM) return; // 还没流到 stepNumber，先不展示

    const stepNumber = parseInt(stepM[1], 10);
    const instM = json.match(/"instruction"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const detM  = json.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)/);

    const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const instruction = instM ? unescape(instM[1]) : '';
    const detail      = detM  ? unescape(detM[1])  : '';

    const sig = stepNumber + '|' + instruction + '|' + detail;
    if (block.lastEmittedSig === sig) return;
    block.lastEmittedSig = sig;
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

      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }

      if (evt.type === 'content_block_start') {
        const cb = evt.content_block || {};
        blocks.set(evt.index, {
          type: cb.type,
          id: cb.id,
          name: cb.name,
          text: '',
          partialJson: ''
        });
      } else if (evt.type === 'content_block_delta') {
        const block = blocks.get(evt.index);
        if (!block) continue;
        const d = evt.delta || {};
        if (d.type === 'text_delta') block.text += d.text || '';
        else if (d.type === 'input_json_delta') {
          block.partialJson += d.partial_json || '';
          tryEmitSayStep(block);
        }
      } else if (evt.type === 'content_block_stop') {
        const block = blocks.get(evt.index);
        if (block && block.type === 'tool_use') {
          try { block.input = block.partialJson ? JSON.parse(block.partialJson) : {}; }
          catch (e) { block.input = { __parseError: e.message, __raw: block.partialJson }; }
        }
      }
      // message_start / message_delta / message_stop / ping 等其它事件忽略
    }
  }

  // 按 index 顺序整理回 Anthropic 风格 content blocks
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([_, b]) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
    return null;
  }).filter(Boolean);

  return { content: ordered };
}
