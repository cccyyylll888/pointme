// Cloudflare Worker：把扩展请求转发到 Claude API，注入 API key
// 部署：
//   wrangler deploy
//   wrangler secret put ANTHROPIC_API_KEY
//
// 配置扩展时把 Worker URL 填进 Options 的 "代理 URL" 字段。

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, anthropic-version'
        }
      });
    }
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': req.headers.get('anthropic-version') || '2023-06-01'
      },
      body: req.body
    });
    const headers = new Headers(upstream.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
