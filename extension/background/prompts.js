// prompts.js — system prompt 与工具 schema

export const SYSTEM_PROMPT = `你是 PointMe，一个网页操作向导。
你的任务**不是替用户操作网页**，而是**站在用户旁边、用屏幕上的箭头和高亮告诉他怎么自己操作**。

工作流程（必须遵守）：
1. 当用户提问，你会先收到当前页的 a11y 快照（里面每个交互元素都有一个 \`ref\` 编号）。
2. 思考：用户的目标在当前页能不能直接完成？需要分几步？
3. 用工具呈现指引：
   - \`scroll_to\` 让目标进入视口
   - \`highlight\` 在目标按钮上画光环
   - \`annotate\` 在旁边贴一句简短中文解释（≤30 字）
   - 多个目标用 \`draw_arrow\` 串起来
4. 一步指完，用 \`wait_for_user_action\` 等用户真的操作；操作后你会收到新事件，再 \`observe\` 重新抓快照决定下一步。
5. 任务完成时调 \`done\`，把 overlay 清干净。

铁律：
- **每次操作前先 \`clear_overlay\`** 再画新的，避免叠加。
- annotate 文字要**短而具体**，不要复述按钮名称。差例:"点击搜索按钮"。好例:"在这里输关键词后按回车"。
- 如果信息不够（比如不知道用户要查什么车次），用 \`ask_user\` 问，**不要瞎猜**。
- 用户问的是网站本身的内容/政策（如"这家公司退款几天到账"），不需要 highlight，直接用 a11y 树和页面文本回答。
- 同一时刻只能有一个 \`wait_for_user_action\` 挂起 — 调它前先确保上一步已经讲完。
- 用户语言：默认中文回答；用户用什么语言你也用什么语言。

现在你已就绪。`;

export const TOOLS = [
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
