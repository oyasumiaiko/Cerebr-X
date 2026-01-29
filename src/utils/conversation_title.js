/**
 * @file 对话标题/摘要生成（纯函数）
 *
 * 设计目标：
 * 1) 不再通过“字符串/正则”去猜测用户是否发起了某类指令（总结/划词等）；
 * 2) 优先使用发送时写入到消息节点上的 promptType / promptMeta（见 core/message_sender.js）；
 * 3) 对于 selection/query 这类“划词指令”，标题应为 `[划词解释] + 划词内容`，而不是把整段提示词模板保存下来；
 * 4) 保持纯函数：不读写 DOM、不依赖全局状态，便于复用与后续演进。
 */

const DEFAULT_MAX_LENGTH = 160;

/**
 * 提取消息的纯文本（兼容历史的多模态数组结构）
 * @param {any} content
 * @param {{imagePlaceholder?: string}} [options]
 * @returns {string}
 */
function extractPlainText(content, options = {}) {
  const imagePlaceholder = (typeof options.imagePlaceholder === 'string')
    ? options.imagePlaceholder
    : '[图片]';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => (part?.type === 'image_url' ? imagePlaceholder : (part?.text || '').trim()))
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * 对外导出：提取消息的纯文本（兼容历史的多模态数组结构）
 * @param {any} content
 * @param {{imagePlaceholder?: string}} [options]
 * @returns {string}
 */
export function extractPlainTextFromContent(content, options = {}) {
  return extractPlainText(content, options);
}

/**
 * 归一化空白字符：将多种空白压缩为单个空格，并去掉首尾空白
 * @param {string} text
 * @returns {string}
 */
function normalizeWhitespace(text) {
  const input = String(text || '');
  let out = '';
  let lastWasSpace = true;
  for (const ch of input) {
    const isWs =
      ch === ' ' ||
      ch === '\n' ||
      ch === '\r' ||
      ch === '\t' ||
      ch === '\f' ||
      ch === '\v';
    if (isWs) {
      if (!lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
      }
      continue;
    }
    out += ch;
    lastWasSpace = false;
  }
  return out.trim();
}

/**
 * 截断到指定长度（按 JS 字符长度，够用且与现有实现一致）
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncate(text, maxLength) {
  const limit = Number.isFinite(maxLength) ? Math.max(0, maxLength) : DEFAULT_MAX_LENGTH;
  const str = String(text || '');
  return str.length > limit ? str.slice(0, limit) : str;
}

/**
 * 纯函数：从“模板替换后的完整提示词”中提取 <SELECTION> 对应的原文。
 * @param {string} renderedPrompt
 * @param {string} templatePrompt
 * @returns {string}
 */
function extractSelectionTextFromRenderedPrompt(renderedPrompt, templatePrompt) {
  if (typeof renderedPrompt !== 'string' || typeof templatePrompt !== 'string') return '';
  const placeholder = '<SELECTION>';
  const parts = templatePrompt.split(placeholder);
  if (parts.length < 2) return '';

  const prefix = parts[0] || '';
  const suffix = parts[1] || '';

  let startIndex = 0;
  if (prefix) {
    const prefixIndex = renderedPrompt.indexOf(prefix);
    if (prefixIndex === -1) return '';
    startIndex = prefixIndex + prefix.length;
  }

  let endIndex = renderedPrompt.length;
  if (suffix) {
    const suffixIndex = renderedPrompt.lastIndexOf(suffix);
    if (suffixIndex !== -1 && suffixIndex >= startIndex) {
      endIndex = suffixIndex;
    }
  }

  return renderedPrompt.slice(startIndex, endIndex).trim();
}

/**
 * 从消息节点中提取“划词内容”（优先 promptMeta，其次基于模板确定性提取）
 * @param {Object} message
 * @param {Object|null} promptsConfig
 * @param {string} plainText
 * @returns {string}
 */
function resolveSelectionText(message, promptsConfig, plainText) {
  const fromMeta = message?.promptMeta?.selectionText;
  if (typeof fromMeta === 'string' && fromMeta.trim()) {
    return fromMeta.trim();
  }

  const promptType = typeof message?.promptType === 'string' ? message.promptType : 'none';
  const template =
    promptType === 'query'
      ? (promptsConfig?.query?.prompt || '')
      : (promptsConfig?.selection?.prompt || '');
  if (!template) return '';
  return extractSelectionTextFromRenderedPrompt(plainText || '', template);
}

/**
 * 根据第一条用户消息生成对话摘要（对话列表显示的“标题”）
 *
 * 规则（可按需扩展）：
 * - summary：`[总结] + 页面标题`（若可获取）
 * - pdf：`[PDF总结]`
 * - selection/query：`[划词解释] + 划词内容`
 * - image：`[解释图片]`
 * - 其它：使用第一条用户消息的摘要
 *
 * @param {Object|null} firstUserMessage
 * @param {{promptsConfig?: Object|null, pageTitle?: string, maxLength?: number, suffix?: string}} [options]
 * @returns {string}
 */
export function buildConversationSummaryFromFirstUserMessage(firstUserMessage, options = {}) {
  if (!firstUserMessage) return '';
  const promptsConfig = options.promptsConfig || null;
  const pageTitle = typeof options.pageTitle === 'string' ? options.pageTitle : '';
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : DEFAULT_MAX_LENGTH;
  const suffix = typeof options.suffix === 'string' ? options.suffix : '';

  const plainText = extractPlainText(firstUserMessage.content);
  const promptType = typeof firstUserMessage.promptType === 'string' ? firstUserMessage.promptType : 'none';

  let summary = '';
  if (promptType === 'summary') {
    const normalizedTitle = normalizeWhitespace(pageTitle);
    summary = normalizedTitle ? `[总结] ${normalizedTitle}` : '[总结]';
  } else if (promptType === 'pdf') {
    summary = '[PDF总结]';
  } else if (promptType === 'image') {
    summary = '[解释图片]';
  } else if (promptType === 'selection' || promptType === 'query') {
    const selectionText = normalizeWhitespace(resolveSelectionText(firstUserMessage, promptsConfig, plainText));
    summary = selectionText ? `[划词解释] ${selectionText}` : '[划词解释]';
  } else {
    summary = normalizeWhitespace(plainText);
  }

  return truncate(summary + (suffix || ''), maxLength);
}

/**
 * 从消息数组生成对话摘要（会自动挑选第一条用户消息）
 * @param {Array<Object>} messages
 * @param {{promptsConfig?: Object|null, pageTitle?: string, maxLength?: number, suffix?: string}} [options]
 * @returns {string}
 */
export function buildConversationSummaryFromMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const firstUser = list.find(msg => (msg?.role || '').toLowerCase() === 'user' && extractPlainText(msg.content));
  return buildConversationSummaryFromFirstUserMessage(firstUser || null, options);
}

