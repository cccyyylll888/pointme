# PointMe — 屏幕导航小子

> 不替你操作网页，**站在你旁边指着屏幕教你怎么用**。任何网站、任何任务。

## 一句话定位

PointMe 是一个 Chrome 扩展。装上之后，每个网页右下角都会出现一个像素小人。
你问："我怎么在这个网站退选这门课？" 它会：

1. 看一眼你当前页面的 accessibility 树 + 截图
2. 在屏幕上**画箭头/spotlight 高亮按钮** + 文字解释
3. 等你点完，**自动观察 DOM 变化**进入下一步
4. 直到任务完成

它**不替你点**——它只教你怎么点。这一条让它和 Claude for Chrome / Browser Use / Computer Use 划清界线。

## 架构

```
                ┌──────────────────────────────────────────────┐
                │  Webpage (任何网页)                          │
                │  ┌───────────────────────────────────┐       │
                │  │ content scripts                    │       │
                │  │  • snapshot.js  (a11y 树压缩)     │       │
                │  │  • overlay.js   (高亮/箭头/标注)  │       │
                │  │  • observer.js  (等用户操作)      │       │
                │  │  • sidebar.js   (右下角小人 + 对话) │     │
                │  └───────────────────────────────────┘       │
                └──────────────────────────────────────────────┘
                       │ chrome.runtime.sendMessage
                       ▼
                ┌──────────────────────────┐
                │ background/agent.js      │   prompt cache:
                │   agent loop + tool call │   a11y 树 ≈90% 命中
                └──────────────────────────┘
                       │ fetch
                       ▼
                ┌──────────────────────────┐
                │ proxy (Cloudflare Worker)│   只做 key 转发
                └──────────────────────────┘
                       │
                       ▼
                ┌──────────────────────────┐
                │  Claude Sonnet 4.6       │
                └──────────────────────────┘
```

## Agent 工具集（8 个）

| 工具 | 作用 |
|---|---|
| `observe()` | 重抓当前页 a11y 树和截图 |
| `highlight(refId)` | 给元素加一圈脉冲光环 |
| `annotate(refId, text)` | 在元素旁贴气泡文字 |
| `draw_arrow(fromRefId, toRefId)` | 从 A 画箭头指向 B |
| `scroll_to(refId)` | 把元素滚到视口中央 |
| `wait_for_user_action(condition)` | 暂停 agent，等用户完成某动作（点击/输入/URL 变化） |
| `ask_user(question)` | 反问用户拿信息 |
| `done(summary)` | 任务结束，清理 overlay |

## 安装（开发模式）

1. `chrome://extensions` → 打开开发者模式 → "加载已解压的扩展程序" → 选 `extension/` 目录
2. 点击工具栏图标，在弹出的 Options 里贴你的 Anthropic API key（或 proxy URL）
3. 打开任意网页，看到右下角小人就装好了

## Demo 脚本

- `demo/12306-退票.md` — 在 12306 上引导用户退一张票
- `demo/github-pr.md` — 在 GitHub 上引导新人 fork → 提 PR

## 黑客松路演要点

见 `docs/pitch.md`。

---

**Made for hackathon by 陈宇梁** · powered by Claude Sonnet 4.6
