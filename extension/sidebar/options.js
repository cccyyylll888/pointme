// options.js — 配置页保存逻辑（MV3 CSP 不允许 inline script，必须独立文件）
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['apiKey', 'proxyUrl'], (cfg) => {
  $('apiKey').value = cfg.apiKey || '';
  $('proxyUrl').value = cfg.proxyUrl || '';
});

$('save').addEventListener('click', () => {
  chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    proxyUrl: $('proxyUrl').value.trim()
  }, () => {
    if (chrome.runtime.lastError) {
      $('status').className = '';
      $('status').textContent = '保存失败：' + chrome.runtime.lastError.message;
      return;
    }
    $('status').className = 'ok';
    $('status').textContent = '已保存 ✓';
    setTimeout(() => { $('status').textContent = ''; }, 2000);
  });
});
