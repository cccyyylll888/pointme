# PointMe 架构详解

## 模块边界

```
extension/
├── manifest.json              # MV3 配置
├── background/
│   ├── agent.js               # service worker：agent loop + Claude API
│   └── prompts.js             # system prompt + 工具 schema
├── content/                   # 注入到每个页面
│   ├── snapshot.js            # 抓 a11y 树，分配稳定 refId
│   ├── overlay.js             # 高亮/箭头/标注的渲染层（shadow DOM 隔离）
│   ├── observer.js            # 监听 click/input/url/mutation，兑现 wait_for_user_action
│   ├── sidebar.js             # 右下角小狐狸 + 对话面板
│   ├── sidebar.css            # 面板样式
│   └── main.js                # 总线：sidebar ↔ background ↔ overlay
└── sidebar/
    └── options.html           # API key / proxy URL 配置页
proxy/
├── worker.js                  # Cloudflare Worker：保护 API key
└── wrangler.toml
```

## 关键设计决策

### 1. 为什么用 a11y 树而不是截图 + 视觉模型？

视觉模型（Claude Computer Use 路线）每轮都要发完整截图，又贵又慢。a11y 树：
- 1 个复杂网页 ≈ 5-15 KB JSON，有 prompt cache 后 90% 命中
- 元素带语义角色（button/link/textbox），grounding 远比像素坐标稳定
- 输出的是 refId，content script 反查 DOM，**永不出现 selector 漂移**

代价：纯 SPA 的 canvas/WebGL 应用拿不到 a11y 树。这是已知短板，hackathon 不解决。

### 2. 为什么是"教用户点"而不是"代用户点"？

技术上：
- 不点 ≠ 不能点。能点意味着要可靠的 selector / 等待加载 / 处理弹窗 —— 工程量爆炸
- 教只需要**视觉指引**，错了用户会自己识别和绕过

产品上：
- 法律风险低（不会替用户做单/付款）
- 用户保留控制感 —— 这恰恰是大多数人对 AI 焦虑的核心
- 学习价值：用户用三次以后自己学会了，AI 进入"低频救场"角色，留存反而高

### 3. wait_for_user_action 的必要性

如果 agent 一口气把所有箭头画完就退出，用户根本来不及看。
真正的引导节奏是 "**画一步 → 等用户走完 → 再画下一步**"。

实现上：
- agent 通过工具调用挂条件
- content script 的 observer.js 监听对应事件，匹配后回送 observation
- agent 拿到 observation 进入下一轮思考

这个闭环是产品体验的灵魂。

### 4. ref id 稳定性

snapshot 每次 capture 都重置 ref 计数器 —— 这意味着 ref 在两次 capture 之间无法跨越使用。
约定：**任何工具调用前都假设 ref 来自最近一次 observe / 用户消息附带的 snapshot**。
agent 自己也被 prompt 提醒"不确定就重新 observe"。

## 已知缺陷（黑客松后再补）

| 问题 | 临时方案 | 长期方案 |
|---|---|---|
| iframe 内容抓不到 | manifest 加 `"all_frames": true` | 跨 frame 消息总线统一 ref 命名 |
| ref 在长会话里语义飘移 | 每次 observe 重置 | 给元素生成内容 hash，hash 稳定就复用 ref |
| API key 暴露在客户端 | hackathon BYOK + 提示风险 | 强制走 proxy，proxy 做 OAuth / 配额 |
| 截图未启用 | 仅 a11y 树 | 给 SPA / canvas 应用上视觉兜底 |
| 多轮 token 成本 | system + snapshot 都打 cache_control | 引入 prompt 摘要 + 滑动窗口 |
