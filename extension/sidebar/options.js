// options.js — 配置页保存逻辑

const $ = (id) => document.getElementById(id);

const PRESETS = {
  minimax:  { baseUrl: 'https://api.minimax.chat/v1',                            model: 'MiniMax-M1' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1',                            model: 'deepseek-chat' },
  zhipu:    { baseUrl: 'https://open.bigmodel.cn/api/paas/v4',                   model: 'glm-4-plus' },
  qwen:     { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',      model: 'qwen-plus' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1',                             model: 'moonshot-v1-32k' },
  doubao:   { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',               model: 'doubao-pro-32k' },
  openai:   { baseUrl: 'https://api.openai.com/v1',                              model: 'gpt-4o' }
};

const FIELDS = ['provider', 'apiKey', 'proxyUrl', 'openaiBaseUrl', 'openaiModel', 'openaiKey'];

function showPanel(provider) {
  $('anthropic-panel').style.display = provider === 'anthropic' ? '' : 'none';
  $('openai-panel').style.display    = provider === 'openai'    ? '' : 'none';
}

// 加载已保存配置
chrome.storage.local.get(FIELDS, (cfg) => {
  $('provider').value      = cfg.provider || 'anthropic';
  $('apiKey').value        = cfg.apiKey || '';
  $('proxyUrl').value      = cfg.proxyUrl || '';
  $('openaiBaseUrl').value = cfg.openaiBaseUrl || '';
  $('openaiModel').value   = cfg.openaiModel || '';
  $('openaiKey').value     = cfg.openaiKey || '';
  showPanel($('provider').value);
});

$('provider').addEventListener('change', (e) => showPanel(e.target.value));

// 预设按钮
document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    $('openaiBaseUrl').value = p.baseUrl;
    if (!$('openaiModel').value) $('openaiModel').value = p.model;
  });
});

function setStatus(text, kind) {
  $('status').className = kind || '';
  $('status').textContent = text;
  if (text) setTimeout(() => { $('status').textContent = ''; $('status').className = ''; }, 4000);
}

$('save').addEventListener('click', () => {
  const data = {
    provider:      $('provider').value,
    apiKey:        $('apiKey').value.trim(),
    proxyUrl:      $('proxyUrl').value.trim(),
    openaiBaseUrl: $('openaiBaseUrl').value.trim().replace(/\/+$/, ''),
    openaiModel:   $('openaiModel').value.trim(),
    openaiKey:     $('openaiKey').value.trim()
  };
  chrome.storage.local.set(data, () => {
    if (chrome.runtime.lastError) {
      setStatus('保存失败：' + chrome.runtime.lastError.message, 'err');
    } else {
      setStatus('已保存 ✓', 'ok');
    }
  });
});

// 测试连接：发一个最小的 ping，看是否 200
$('test').addEventListener('click', async () => {
  setStatus('测试中…', '');
  try {
    const provider = $('provider').value;
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': $('apiKey').value.trim(),
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
      });
      if (r.ok) setStatus('Anthropic 连通 ✓', 'ok');
      else setStatus('Anthropic 失败：' + r.status + ' ' + (await r.text()).slice(0, 120), 'err');
    } else {
      const base = $('openaiBaseUrl').value.trim().replace(/\/+$/, '');
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + $('openaiKey').value.trim() },
        body: JSON.stringify({ model: $('openaiModel').value.trim(), max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
      });
      if (r.ok) setStatus('OpenAI 兼容连通 ✓', 'ok');
      else setStatus('失败：' + r.status + ' ' + (await r.text()).slice(0, 200), 'err');
    }
  } catch (e) {
    setStatus('网络错误：' + e.message, 'err');
  }
});
