/**
 * 消息构造模块（纯函数）
 * 将提示词、会话历史、网页内容等输入组合为标准的 messages 数组，
 * 不依赖 DOM、不触发副作用，便于测试与复用。
 * @since 1.2.0
 */

/**
 * @typedef {Object} ConversationNode
 * @property {string} id 唯一ID
 * @property {('user'|'assistant'|'system')} role 角色
 * @property {string} content 文本内容
 */

/**
 * @typedef {Object} PromptsConfigItem
 * @property {string} prompt 提示词文本
 * @property {string} model 偏好模型或 'follow_current'
 */

/**
 * @typedef {Object<string, PromptsConfigItem>} PromptsConfig
 */

/**
 * @typedef {Object} ComposeMessagesArgs
 * @property {PromptsConfig} prompts 提示词配置对象
 * @property {Array<string>} injectedSystemMessages 额外注入的系统消息
 * @property {{title: string, url: string, content: string}|null} pageContent 网页内容（可空）
 * @property {boolean} imageContainsScreenshot 是否包含截图
 * @property {string|null} currentPromptType 当前提示词类型
 * @property {boolean} regenerateMode 是否为重新生成模式
 * @property {string|null} messageId 重新生成目标消息ID
 * @property {ConversationNode[]} conversationChain 当前会话链（按时间顺序）
 * @property {boolean} sendChatHistory 是否发送历史（已根据业务规则计算好）
 * @property {number} maxHistory 最大发送的历史条目数
 */

/**
 * 构造标准的 messages 数组
 * @param {ComposeMessagesArgs} args 参数
 * @returns {Array<{role: string, content: string}>} messages
 * @example
 * const messages = composeMessages({
 *   prompts,
 *   injectedSystemMessages: [],
 *   pageContent: { title, url, content },
 *   imageContainsScreenshot: false,
 *   currentPromptType: 'summary',
 *   regenerateMode: false,
 *   messageId: null,
 *   conversationChain,
 *   sendChatHistory: true,
 *   maxHistory: 16
 * });
 */
export function composeMessages(args) {
  const {
    prompts,
    injectedSystemMessages,
    pageContent,
    imageContainsScreenshot,
    currentPromptType,
    regenerateMode,
    messageId,
    conversationChain,
    sendChatHistory,
    maxHistory
  } = args;

  const messages = [];

  // 1) 系统消息：系统提示词 + 注入系统消息 + 网页内容 + 截图提示
  const pageContentPrompt = pageContent
    ? `\n\n当前网页内容：\n标题：${pageContent.title}\nURL：${pageContent.url}\n内容：${pageContent.content}`
    : '';

  let systemMessageContent = prompts.system?.prompt || '';
  if (imageContainsScreenshot) {
    systemMessageContent += "\n用户附加了当前页面的屏幕截图";
  }
  if (Array.isArray(injectedSystemMessages) && injectedSystemMessages.length > 0) {
    systemMessageContent += "\n" + injectedSystemMessages.join('\n');
  }
  systemMessageContent += pageContentPrompt;

  messages.push({ role: 'system', content: systemMessageContent });

  // 2) 历史消息选择
  const chain = Array.isArray(conversationChain) ? conversationChain.slice() : [];

  // 重新生成模式：裁剪到目标消息
  let effectiveChain = chain;
  if (regenerateMode && messageId) {
    const targetIndex = chain.findIndex(msg => msg.id === messageId);
    if (targetIndex !== -1) {
      effectiveChain = chain.slice(0, targetIndex + 1);
    }
  }

  if (sendChatHistory) {
    // 当 maxHistory 为 0 时，不发送任何历史消息
    if (maxHistory === 0) {
      // 不添加任何历史消息
    } else if (maxHistory && maxHistory > 0) {
      // 限制历史消息数量
      const limited = effectiveChain.slice(-maxHistory);
      messages.push(...limited.map(node => ({ role: mapRole(node.role), content: node.content })));
    } else {
      // 发送全部历史消息
      messages.push(...effectiveChain.map(node => ({ role: mapRole(node.role), content: node.content })));
    }
  } else {
    // 只发送最后一条
    if (effectiveChain.length > 0) {
      const last = effectiveChain[effectiveChain.length - 1];
      messages.push({ role: mapRole(last.role), content: last.content });
    }
  }

  // 3) 确保当前用户消息被包含
  // 当 maxHistory 为 0 时，我们需要确保至少包含当前用户的消息
  // 这样 AI 才能知道用户问了什么问题
  if (maxHistory === 0 && effectiveChain.length > 0) {
    // 查找最后一条用户消息
    for (let i = effectiveChain.length - 1; i >= 0; i--) {
      const message = effectiveChain[i];
      if (message.role === 'user') {
        messages.push({ role: 'user', content: message.content });
        break; // 只添加最后一条用户消息
      }
    }
  }

  return messages;
}

/**
 * 角色映射为 API 兼容的 role 值
 * @param {string} role 原始角色
 * @returns {'user'|'assistant'|'system'}
 */
function mapRole(role) {
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  // 兼容历史记录内部命名
  if (role === 'ai') return 'assistant';
  return 'user';
}


