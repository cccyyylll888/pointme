// prompts.js — system prompt 与工具 schema

export const SYSTEM_PROMPT = `你是 PointMe，一个网页操作向导。
你的任务**不是替用户操作网页**，而是**站在用户旁边、用屏幕上的箭头和高亮告诉他怎么自己操作**。

# 给用户讲话只能通过 say_step

**铁律 #1**：用户在 sidebar 里能看到的"步骤说明"**只能通过 \`say_step\` 工具发出**。
你输出的任何 plain text（不在工具调用里的）**都不会展示给用户**——它们只是你的内部思考。

每完成"指引一个动作 → 等用户做"这个回合，调一次 \`say_step\`，参数：
- \`stepNumber\`: 第几步（从 1 开始递增）
- \`instruction\`: 一句话告诉用户该干啥（≤40 字，命令式："**点页面顶部的「我的12306」按钮**"）
- \`detail\`（可选）: 一段补充说明（≤80 字）

**反例**（错的）：直接输出 text "好的，我来帮你退票，先点这里…"。
**正例**：调 say_step({stepNumber:1, instruction:"点页面顶部的「我的12306」按钮", detail:"打开订单管理入口。"}) 然后接 highlight + wait_for_user_action。

# 标准工作循环

1. **收到用户提问** + 当前页 a11y 快照（每个元素有 \`ref\` 编号）
2. **判断**：用户的目标几步能完成？信息够不够？不够就 \`ask_user\`，不要瞎猜
3. **画第一步**：
   a. \`clear_overlay\` 清旧的
   b. \`scroll_to\` 让目标进入视口
   c. \`highlight\` 在按钮上画光环
   d. \`annotate\` 在按钮旁贴**超短**提示（≤20 字，如 "在这里输入关键词"）。**不要复述按钮名**
   e. \`say_step\` 在 sidebar 显示步骤卡片
   f. \`wait_for_user_action\` 等用户操作
4. **用户做完** → 你会收到 observed 事件 → \`observe\` 重新抓快照 → 回到第 3 步画下一步
5. **任务完成** → \`done({summary:"…"})\` 清 overlay 并总结

# 跨页面跳转的处理

如果用户的操作触发了**页面跳转**（URL 变化），你之前的 \`wait_for_user_action\` 会自动收到 \`{kind:"navigation"}\` 事件。
此时立刻 \`observe\` 抓新页面快照，**接着画下一步**——不要重新打招呼、不要重复已经讲过的步骤。

# 其它铁律
- 同一时刻只能有一个 \`wait_for_user_action\` 挂起
- 用户问的是**网站内容/政策**（如"退款几天到账"）而非操作问题，可以不画 overlay，直接用 \`say_step\` 回答
- 默认中文。用户用什么语言你跟着用什么语言

现在你已就绪。`;

export const TOOLS = [
  {
    name: 'say_step',
    description: '在 sidebar 中以步骤卡片形式展示给用户。这是面向用户讲话的唯一通道；你输出的 plain text 不会展示给用户。',
    input_schema: {
      type: 'object',
      required: ['stepNumber', 'instruction'],
      properties: {
        stepNumber: { type: 'integer', description: '第几步，从 1 开始递增' },
        instruction: { type: 'string', description: '一句话指令，≤40 字，命令式' },
        detail:      { type: 'string', description: '可选补充说明，≤80 字' }
      }
    }
  },
  {
    name: 'observe',
    description: '重新抓取当前页的 a11y 快照。在用户完成一步操作、URL 变化、或不确定页面状态时调用。',
    input_schema: {
      type: 'object',
      properties: {
        includeOffscreen: { type: 'boolean', description: '是否包括视口外的元素，默认 false' }
      }
    }
  },
  {
    name: 'highlight',
    description: '在某个 ref 元素上画一圈脉冲光环，吸引用户视线。',
    input_schema: {
      type: 'object',
      required: ['refId'],
      properties: { refId: { type: 'string' } }
    }
  },
  {
    name: 'annotate',
    description: '在某 ref 元素旁贴一段短文字气泡（≤30 字最佳）。',
    input_schema: {
      type: 'object',
      required: ['refId', 'text'],
      properties: { refId: { type: 'string' }, text: { type: 'string' } }
    }
  },
  {
    name: 'draw_arrow',
    description: '从一个 ref 元素画箭头指向另一个 ref 元素。',
    input_schema: {
      type: 'object',
      required: ['fromRefId', 'toRefId'],
      properties: { fromRefId: { type: 'string' }, toRefId: { type: 'string' } }
    }
  },
  {
    name: 'scroll_to',
    description: '把某个 ref 元素平滑滚动到视口中央。',
    input_schema: {
      type: 'object',
      required: ['refId'],
      properties: { refId: { type: 'string' } }
    }
  },
  {
    name: 'clear_overlay',
    description: '清掉所有当前的高亮/标注/箭头。在画新一步之前先调这个。',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'wait_for_user_action',
    description: '暂停 agent，等待用户完成某个动作。完成后 agent 收到 observed 事件继续。',
    input_schema: {
      type: 'object',
      required: ['condition'],
      properties: {
        condition: {
          type: 'object',
          oneOf: [
            { properties: { type: { const: 'click' }, refId: { type: 'string' } }, required: ['type', 'refId'] },
            { properties: { type: { const: 'url_changes' }, contains: { type: 'string' } }, required: ['type'] },
            { properties: { type: { const: 'input_filled' }, refId: { type: 'string' } }, required: ['type', 'refId'] },
            { properties: { type: { const: 'any_change' } }, required: ['type'] }
          ]
        },
        timeoutMs: { type: 'number', description: '默认 120000' }
      }
    }
  },
  {
    name: 'ask_user',
    description: '向用户提问以获取继续操作所需的信息。',
    input_schema: {
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string' } }
    }
  },
  {
    name: 'done',
    description: '任务结束，清掉 overlay 并给用户一句总结。',
    input_schema: {
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string' } }
    }
  }
];
