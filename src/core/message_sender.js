/**
 * 消息发送和处理模块
 * 
 * 负责管理消息的构建、发送和处理响应的整个生命周期。
 * 这个模块是应用程序的核心部分，处理从用户输入到AI响应显示的完整流程。
 */
import { composeMessages } from './message_composer.js';
import { renderUserMessageTemplateWithInjection, applyRenderedTextToMessageContent } from './message_preprocessor.js';
import { extractThinkingFromText, mergeStreamingThoughts, mergeThoughts } from '../utils/thoughts_parser.js';
import { createAdaptiveUpdateThrottler } from '../utils/adaptive_update_throttler.js';
import { extractPlainTextFromContent } from '../utils/conversation_title.js';

/**
 * 创建消息发送器
 * @param {Function} options.getPrompts - 获取提示词设置的函数
 * @param {Object} options.uiManager - UI管理器实例
 * @returns {Object} 消息发送器实例
 */
export function createMessageSender(appContext) {
  // 从选项中提取所需依赖
  const {
    dom,
    services,
    utils,
    state
  } = appContext;

  const apiManager = services.apiManager;
  const messageProcessor = services.messageProcessor;
  const imageHandler = services.imageHandler;
  const chatHistoryUI = services.chatHistoryUI;
  const chatHistoryManager = services.chatHistoryManager;
  const inputController = services.inputController;
  const getCurrentConversationChain = chatHistoryManager.getCurrentConversationChain;
  const chatContainer = dom.chatContainer;
  const threadContainer = dom.threadContainer;
  const messageInput = dom.messageInput; // 保持兼容：占位符/样式仍可直接操作
  const imageContainer = dom.imageContainer; // 将逐步迁移到 inputController
  const scrollToBottom = utils.scrollToBottom;
  const settingsManager = services.settingsManager;
  const promptSettingsManager = services.promptSettingsManager;
  const showNotification = utils.showNotification;

  /**
   * 将 API 返回的 inlineData 图片保存到本地下载目录，并返回可用于 <img src> 的本地文件链接。
   * 
   * 设计目标：
   * - 只在 sidebar 扩展页环境下调用，依赖 chrome.downloads 权限；
   * - 下载失败时回退为 null，由调用方决定是否继续使用 base64 dataURL；
   * - 返回的链接统一为 file:// 协议，便于后续预览与历史记录中复用。
   *
   * 注意：
   * - 这里不会在 IndexedDB 中保存 base64 字符串，只在内存中临时构造 dataURL 交给下载接口。
   *
   * @param {string} mimeType - 图片 MIME 类型，例如 "image/png"
   * @param {string} base64Data - 图片的 Base64 字符串，不包含 data: 前缀
   * @returns {Promise<string|null>} - 成功时返回 file:// 开头的本地文件 URL，失败时返回 null
   */
  async function saveInlineImageToLocalFile(mimeType, base64Data) {
    try {
      if (!mimeType || !base64Data || !chrome?.downloads?.download) {
        // 在无法访问下载 API 时直接放弃本地文件方案，交由上层使用 dataURL 回退
        return null;
      }

      const safeMime = String(mimeType || '').toLowerCase();
      let ext = 'png';
      if (safeMime === 'image/jpeg' || safeMime === 'image/jpg') ext = 'jpg';
      else if (safeMime === 'image/webp') ext = 'webp';
      else if (safeMime === 'image/gif') ext = 'gif';
      else if (safeMime === 'image/png') ext = 'png';
      else if (safeMime.startsWith('image/')) {
        ext = safeMime.split('/')[1] || 'png';
      }

      // 统一存放到下载目录下的 Cerebr/Images 子目录，便于用户管理
      const now = new Date();
      const pad2 = (n) => String(n).padStart(2, '0');
      const timestamp = [
        now.getFullYear(),
        pad2(now.getMonth() + 1),
        pad2(now.getDate()),
        pad2(now.getHours()),
        pad2(now.getMinutes()),
        pad2(now.getSeconds())
      ].join('');
      const random = Math.random().toString(36).slice(2, 8);
      const baseName = `cerebr_${timestamp}_${random}`;
      const filename = `Cerebr/Images/${baseName}.${ext}`;

      const dataUrl = `data:${safeMime};base64,${base64Data}`;

      // 第一步：触发浏览器下载
      const downloadId = await new Promise((resolve, reject) => {
        try {
          chrome.downloads.download(
            {
              url: dataUrl,
              filename,
              conflictAction: 'uniquify',
              saveAs: false
            },
            (id) => {
              const lastError = chrome.runtime?.lastError;
              if (lastError || typeof id !== 'number') {
                console.error('保存内联图片到本地失败(download):', lastError);
                reject(new Error(lastError?.message || 'downloads.download 失败'));
              } else {
                resolve(id);
              }
            }
          );
        } catch (e) {
          console.error('调用 chrome.downloads.download 异常:', e);
          reject(e);
        }
      });

      // 第二步：轮询等待下载完成，拿到实际文件路径
      const filePath = await new Promise((resolve, reject) => {
        const timeoutMs = 30000;
        const start = Date.now();

        function check() {
          try {
            chrome.downloads.search({ id: downloadId }, (items) => {
              const lastError = chrome.runtime?.lastError;
              if (lastError) {
                reject(new Error(lastError.message));
                return;
              }
              const item = items && items[0];
              if (!item) {
                reject(new Error('找不到下载任务'));
                return;
              }
              if (item.state === 'complete' && item.filename) {
                resolve(item.filename);
                return;
              }
              if (item.state === 'interrupted') {
                reject(new Error(item.error || '下载被中断'));
                return;
              }
              if (Date.now() - start > timeoutMs) {
                reject(new Error('等待图片下载完成超时'));
                return;
              }
              setTimeout(check, 500);
            });
          } catch (e) {
            reject(e);
          }
        }

        check();
      });

      if (!filePath || typeof filePath !== 'string') {
        return null;
      }

      // 将本地绝对路径转换为标准的 file:// URL
      let normalizedPath = filePath.replace(/\\/g, '/');
      if (/^[A-Za-z]:\//.test(normalizedPath)) {
        // Windows 路径: C:/Users/... 需要前置一个斜杠 -> /C:/Users/...
        normalizedPath = '/' + normalizedPath;
      }
      const fileUrl = `file://${normalizedPath}`;
      return fileUrl;
    } catch (error) {
      console.error('保存内联图片到本地失败:', error);
      return null;
    }
  }

  // 私有状态
  let isProcessingMessage = false;
  let shouldAutoScroll = true;
  /**
   * 当前所有进行中的请求尝试集合（支持并行生成）
   * key 为内部 attemptId，value 为尝试状态对象：
   * { id, controller, manualAbort, finished, loadingMessage, aiMessageId }
   * 
   * 设计说明：
   * - 之前只维护单一 activeAttempt，无法区分多路并行流式响应；
   * - 现在将每一路请求视为独立 attempt，便于实现“按消息粒度的停止生成 / 自动重试”。
   */
  const activeAttempts = new Map();
  let isTemporaryMode = false;
  const TEMP_MODE_SESSION_KEY = 'cerebr.sidebar.temp_mode';
  let pageContent = null;
  let shouldSendChatHistory = true;
  let autoRetryEnabled = false;
  // 流式标记：若当前数据流进入 <think> 段落，则持续写入思考块直到遇到 </think>
  let isInStreamingThoughtBlock = false;
  // 自动重试配置：指数退避，最多 5 次
  const MAX_AUTO_RETRY_ATTEMPTS = 5;
  const AUTO_RETRY_BASE_DELAY_MS = 500;
  const AUTO_RETRY_MAX_DELAY_MS = 8000;

  // 使用 sessionStorage 在“当前标签页会话”内记住纯对话模式，专门解决 iframe 手动重载导致的开关丢失
  function readTempModeSessionState() {
    try {
      const raw = window.sessionStorage?.getItem(TEMP_MODE_SESSION_KEY);
      if (raw === null) return null;
      return raw === '1';
    } catch (_) {
      return null;
    }
  }

  function persistTempModeSessionState(isOn) {
    try {
      window.sessionStorage?.setItem(TEMP_MODE_SESSION_KEY, isOn ? '1' : '0');
    } catch (_) {}
  }

  function getAutoRetryDelayMs(attemptIndex = 0) {
    const normalizedAttempt = Math.max(0, attemptIndex);
    const rawDelay = AUTO_RETRY_BASE_DELAY_MS * Math.pow(2, normalizedAttempt);
    return Math.min(AUTO_RETRY_MAX_DELAY_MS, Math.round(rawDelay));
  }

  /**
   * 纯函数：从“模板替换后的完整提示词”中提取 <SELECTION> 对应的原文。
   *
   * 设计背景：
   * - 对话标题/摘要需要展示“划词内容”，但过去的实现依赖模板前缀/正则去猜测，用户一旦把模板写成以
   *   `<SELECTION>` 开头（前缀为空）就会出现误判（例如对所有对话都打上同一个标签）。
   * - 这里不再依赖“前缀必须非空”的假设，而是严格基于模板的 prefix/suffix 定位被替换的那一段。
   *
   * 约束与兜底：
   * - 只负责字符串定位与裁剪，不做任何业务判断；
   * - 如果模板不包含 `<SELECTION>` 或定位失败，返回空字符串，由上层决定如何回退。
   *
   * @param {string} renderedPrompt - 实际发送给模型的完整用户消息（已将 <SELECTION> 替换为选中文本）
   * @param {string} templatePrompt - 提示词模板（包含 <SELECTION> 占位符）
   * @returns {string} 提取到的选中文本（可能为空字符串）
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
   * 纯函数：构造要写入“用户消息节点”的 promptMeta。
   *
   * 设计目标：
   * - promptType 是“当时的指令类型”的权威来源；promptMeta 只保存“标题/摘要”等需要的最小信息；
   * - selection/query 优先使用调用方显式传入的 selectionText；缺失时再基于模板做一次确定性的提取；
   * - 不在这里做任何“正则猜测”，避免逻辑分散且在用户自定义提示词时失效。
   *
   * @param {Object} args
   * @param {string} args.promptType
   * @param {Object|null} args.promptMeta
   * @param {string} args.messageText
   * @param {Object} args.promptsConfig
   * @returns {Object|null}
   */
  function buildPromptMetaForHistory({ promptType, promptMeta, messageText, promptsConfig }) {
    const safeType = typeof promptType === 'string' ? promptType : 'none';
    const safeMeta = (promptMeta && typeof promptMeta === 'object') ? promptMeta : null;
    const result = safeMeta ? { ...safeMeta } : {};

    if (safeType === 'selection' || safeType === 'query') {
      let selectionText = typeof safeMeta?.selectionText === 'string' ? safeMeta.selectionText.trim() : '';
      if (!selectionText) {
        const template = safeType === 'selection'
          ? (promptsConfig?.selection?.prompt || '')
          : (promptsConfig?.query?.prompt || '');
        selectionText = extractSelectionTextFromRenderedPrompt(messageText || '', template);
      }
      if (selectionText) {
        result.selectionText = selectionText;
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * 解析预处理模板的输入基准文本，避免“已渲染文本”再次被套模板。
   * @param {Object} args
   * @param {string} args.messageText
   * @param {boolean} args.regenerateMode
   * @param {string|null} args.messageId
   * @returns {string}
   */
  function resolvePreprocessBaseText({ messageText, regenerateMode, messageId }) {
    if (!regenerateMode || !messageId) return messageText;
    const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === messageId);
    if (!node) return messageText;

    const originalText = (typeof node.preprocessOriginalText === 'string') ? node.preprocessOriginalText : '';
    const renderedText = (typeof node.preprocessRenderedText === 'string') ? node.preprocessRenderedText : '';
    if (originalText && renderedText && renderedText === messageText) {
      return originalText;
    }
    return messageText;
  }

  /**
   * 将预处理后的文本应用到“最后一条 user 消息”，用于只影响发送不改历史。
   * @param {Array} messages
   * @param {string} renderedText
   * @returns {Array}
   */
  function applyPreprocessedTextToMessages(messages, renderedText) {
    if (!Array.isArray(messages) || typeof renderedText !== 'string') return messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;
      const next = { ...msg, content: applyRenderedTextToMessageContent(msg.content, renderedText) };
      const cloned = messages.slice();
      cloned[i] = next;
      return cloned;
    }
    return messages;
  }

  function normalizeInjectedRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    if (normalized === 'assistant' || normalized === 'ai' || normalized === 'model') return 'assistant';
    if (normalized === 'user' || normalized === 'system') return normalized;
    return null;
  }

  /**
   * 规范化模板注入消息（仅用于请求载荷，不写入历史）。
   * @param {Array<{role: string, content: string}>} injectedMessages
   * @returns {Array<{role: 'user'|'assistant'|'system', content: string}>}
   */
  function normalizeInjectedMessages(injectedMessages) {
    if (!Array.isArray(injectedMessages)) return [];
    const results = [];
    for (const item of injectedMessages) {
      if (!item) continue;
      const role = normalizeInjectedRole(item.role);
      if (!role) continue;
      let content = (typeof item.content === 'string') ? item.content : '';
      if (!content.trim()) continue;
      if (role === 'user') {
        const { baseText } = extractTrailingControlMarkers(content);
        content = baseText;
      }
      results.push({ role, content });
    }
    return results;
  }

  /**
   * 将注入消息插入到“最后一条 user 消息”之后，保证模型续写逻辑正确。
   * @param {Array} messages
   * @param {Array<{role: string, content: string}>} injectedMessages
   * @returns {Array}
   */
  function insertInjectedMessagesAfterLastUser(messages, injectedMessages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const normalized = normalizeInjectedMessages(injectedMessages);
    if (normalized.length === 0) return messages;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return messages.concat(normalized);
    }
    return [
      ...messages.slice(0, lastUserIndex + 1),
      ...normalized,
      ...messages.slice(lastUserIndex + 1)
    ];
  }

  // 对话标题生成：避免重复触发同一会话的标题请求
  const conversationTitleRequests = new Set();

  function normalizeConversationTitleText(rawText) {
    const input = (typeof rawText === 'string') ? rawText.trim() : '';
    if (!input) return '';
    let text = input;

    // 兼容模型返回 JSON：优先读取 title 字段
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.title === 'string') {
          text = parsed.title;
        }
      } catch (_) {}
    }

    const firstLine = text.split(/\r?\n/).find(line => line.trim()) || '';
    let cleaned = firstLine.trim();
    cleaned = cleaned.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
    cleaned = cleaned.replace(/^(标题|Title)[:：]\s*/i, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    const maxLength = 160;
    if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength);
    return cleaned;
  }

  async function extractConversationTitleFromResponse(response, apiConfig) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (e) {
      const fallbackText = await response.text().catch(() => '');
      return fallbackText || '';
    }

    if (payload && payload.error) {
      const msg = payload.error.message || 'API 返回错误';
      throw new Error(msg);
    }

    const isGeminiApi = response.url.includes('generativelanguage.googleapis.com')
      || apiConfig?.baseUrl === 'genai';
    if (isGeminiApi) {
      const parts = payload?.candidates?.[0]?.content?.parts || [];
      const textParts = parts
        .filter(part => typeof part?.text === 'string' && !part?.thought)
        .map(part => part.text);
      return textParts.join('');
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    if (typeof choice?.message?.content === 'string') return choice.message.content;
    if (typeof choice?.text === 'string') return choice.text;
    if (typeof payload?.content === 'string') return payload.content;
    return '';
  }

  function truncateTextForTitle(text) {
    const input = (typeof text === 'string') ? text.trim() : '';
    if (!input) return '';
    if (input.length <= 600) return input;
    const head = input.slice(0, 300);
    const tail = input.slice(-300);
    return `[${head}...${tail}]`;
  }

  function formatMessageForTitle(message) {
    if (!message || typeof message.role !== 'string') return '';
    const roleRaw = String(message.role || '').trim().toLowerCase();
    let roleLabel = '消息';
    if (roleRaw === 'user') roleLabel = '用户消息';
    else if (roleRaw === 'assistant' || roleRaw === 'ai' || roleRaw === 'model') roleLabel = 'AI回复';
    else if (roleRaw === 'system') roleLabel = '系统消息';
    else roleLabel = `${message.role}消息`;
    const text = extractPlainTextFromContent(message.content, { imagePlaceholder: '[图片]' });
    const trimmed = truncateTextForTitle(text);
    if (!trimmed) return '';
    return `${roleLabel}：\n${trimmed}`;
  }

  function buildConversationTextForTitle(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const formattedMessages = messages
      .map(formatMessageForTitle)
      .filter(Boolean);
    return formattedMessages.join('\n\n').trim();
  }

  function resolvePromptTypeFromMessages(messages) {
    if (!Array.isArray(messages)) return 'none';
    const firstUserMessage = messages.find(m => (m?.role || '').toLowerCase() === 'user') || null;
    return typeof firstUserMessage?.promptType === 'string' ? firstUserMessage.promptType : 'none';
  }

  function resolveTitlePrefixByPromptType(promptType) {
    if (promptType === 'summary') return '[总结]';
    if (promptType === 'selection' || promptType === 'query') return '[划词解释]';
    return '';
  }

  async function requestConversationTitle({ apiConfig, prompt, conversationText }) {
    // 将指令 + 全部消息合并为单条 user 消息，并在开头包含指令，避免模型把 assistant 内容当作续写上下文。
    const combinedUserMessage = [
      prompt,
      '对话内容：',
      conversationText
    ].join('\n\n').trim();
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: combinedUserMessage }
    ];
    const configForTitle = { ...apiConfig, useStreaming: false };
    const requestBody = await apiManager.buildRequest({
      messages,
      config: configForTitle,
      overrides: { stream: false }
    });
    if (requestBody && typeof requestBody === 'object' && 'stream' in requestBody) {
      requestBody.stream = false;
    }

    const response = await apiManager.sendRequest({
      requestBody,
      config: configForTitle
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(errorText || `API错误 (${response.status})`);
    }

    const rawTitle = await extractConversationTitleFromResponse(response, configForTitle);
    return normalizeConversationTitleText(rawTitle);
  }

  // 复用“自动重试”设置，对标题生成做指数退避重试。
  async function requestConversationTitleWithRetry(params) {
    const maxAttempts = autoRetryEnabled ? MAX_AUTO_RETRY_ATTEMPTS : 1;
    let attemptIndex = 0;
    let lastError = null;
    while (attemptIndex < maxAttempts) {
      try {
        return await requestConversationTitle(params);
      } catch (error) {
        lastError = error;
        const canRetry = autoRetryEnabled && attemptIndex < (maxAttempts - 1);
        if (!canRetry) throw error;
        const delayMs = getAutoRetryDelayMs(attemptIndex);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        attemptIndex += 1;
      }
    }
    throw lastError || new Error('生成对话标题失败');
  }

  // 触发条件：
  // - 仅首条 AI 回复完成后触发（避免多轮对话重复生成）；
  // - 跳过划词线程与重新生成场景；
  // - 写入前校验 expectedSummary，避免覆盖用户手动重命名。
  async function maybeGenerateConversationTitle({ conversationId, attemptState, regenerateMode }) {
    if (!conversationId) return;
    if (regenerateMode) return;
    if (attemptState?.threadContext) return;
    if (!settingsManager?.getSetting || !apiManager) return;
    if (conversationTitleRequests.has(conversationId)) return;

    const enabled = !!settingsManager.getSetting('autoGenerateConversationTitle');
    if (!enabled) return;

    const prompt = (settingsManager.getSetting('conversationTitlePrompt') || '').trim();
    if (!prompt) return;

    const apiPref = settingsManager.getSetting('conversationTitleApi');
    const resolvedApi = (typeof apiManager.resolveApiParam === 'function')
      ? apiManager.resolveApiParam(apiPref)
      : apiManager.getSelectedConfig();
    if (!resolvedApi?.baseUrl || !resolvedApi?.apiKey) return;

    const chain = (typeof chatHistoryManager?.getCurrentConversationChain === 'function')
      ? chatHistoryManager.getCurrentConversationChain()
      : [];
    const historyMessages = chatHistoryManager?.chatHistory?.messages || [];
    const messages = (Array.isArray(chain) && chain.length > 0) ? chain : historyMessages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const promptType = resolvePromptTypeFromMessages(messages);
    if (promptType === 'summary' && !settingsManager.getSetting('autoGenerateTitleForSummary')) return;
    if ((promptType === 'selection' || promptType === 'query') && !settingsManager.getSetting('autoGenerateTitleForSelection')) return;

    const assistantMessages = messages.filter(m => (m?.role || '').toLowerCase() === 'assistant');
    if (assistantMessages.length !== 1) return;

    const conversationText = buildConversationTextForTitle(messages);
    if (!conversationText) return;

    const expectedSummary = chatHistoryUI?.getActiveConversationSummary?.() || '';
    conversationTitleRequests.add(conversationId);
    try {
      const title = await requestConversationTitleWithRetry({
        apiConfig: resolvedApi,
        prompt,
        conversationText
      });
      if (!title) return;
      let finalTitle = title;
      const prefixTag = resolveTitlePrefixByPromptType(promptType);
      if (prefixTag && !finalTitle.startsWith(prefixTag)) {
        finalTitle = `${prefixTag} ${finalTitle}`.trim();
      }
      await chatHistoryUI?.updateConversationSummary?.(conversationId, finalTitle, {
        expectedSummary,
        summarySource: 'auto',
        skipIfManual: true
      });
    } catch (error) {
      console.warn('生成对话标题失败:', error);
    } finally {
      conversationTitleRequests.delete(conversationId);
    }
  }

  /**
   * 生成指定会话消息列表的标题（供历史右键批量生成复用）
   * @param {{messages?: Array<Object>, conversationId?: string}} options
   * @returns {Promise<{ok: boolean, title?: string, reason?: string, promptType?: string, prefixTag?: string, error?: Error}>}
   */
  async function generateConversationTitleForMessages(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const messages = Array.isArray(normalizedOptions.messages) ? normalizedOptions.messages : [];
    const conversationId = (typeof normalizedOptions.conversationId === 'string')
      ? normalizedOptions.conversationId.trim()
      : '';
    if (!settingsManager?.getSetting || !apiManager) {
      return { ok: false, reason: 'missing_services' };
    }
    if (messages.length === 0) {
      return { ok: false, reason: 'empty_messages' };
    }

    const prompt = (settingsManager.getSetting('conversationTitlePrompt') || '').trim();
    if (!prompt) {
      return { ok: false, reason: 'missing_prompt' };
    }

    const apiPref = settingsManager.getSetting('conversationTitleApi');
    const resolvedApi = (typeof apiManager.resolveApiParam === 'function')
      ? apiManager.resolveApiParam(apiPref)
      : apiManager.getSelectedConfig();
    if (!resolvedApi?.baseUrl || !resolvedApi?.apiKey) {
      return { ok: false, reason: 'missing_api' };
    }

    const conversationText = buildConversationTextForTitle(messages);
    if (!conversationText) {
      return { ok: false, reason: 'empty_messages' };
    }

    const promptType = resolvePromptTypeFromMessages(messages);
    const prefixTag = resolveTitlePrefixByPromptType(promptType);

    if (conversationId && conversationTitleRequests.has(conversationId)) {
      return { ok: false, reason: 'in_progress' };
    }
    if (conversationId) conversationTitleRequests.add(conversationId);

    try {
      const title = await requestConversationTitleWithRetry({
        apiConfig: resolvedApi,
        prompt,
        conversationText
      });
      if (!title) {
        return { ok: false, reason: 'empty_title' };
      }
      let finalTitle = title;
      if (prefixTag && !finalTitle.startsWith(prefixTag)) {
        finalTitle = `${prefixTag} ${finalTitle}`.trim();
      }
      return {
        ok: true,
        title: finalTitle,
        promptType,
        prefixTag
      };
    } catch (error) {
      return { ok: false, reason: 'error', error };
    } finally {
      if (conversationId) conversationTitleRequests.delete(conversationId);
    }
  }

  /**
   * 解析当前激活的“划词线程上下文”。
   *
   * 设计要点：
   * - 只读取 selectionThreadManager 状态，不主动创建任何历史节点；
   * - 若锚点消息不存在，则认为线程已失效，提示用户并退出线程模式；
   * - 返回值仅用于后续“发送时”逻辑判断。
   *
   * @returns {{threadId: string, anchorMessageId: string, selectionText: string, annotation: Object}|null}
   */
  function resolveActiveThreadContext() {
    const threadManager = services.selectionThreadManager;
    if (!threadManager?.isThreadModeActive?.()) return null;
    const threadId = threadManager.getActiveThreadId?.();
    if (!threadId) return null;
    const info = threadManager.findThreadById?.(threadId);
    if (!info || !info.annotation) return null;
    const anchorMessageId = info.anchorMessageId || threadManager.getActiveAnchorMessageId?.();
    if (!anchorMessageId) return null;

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === anchorMessageId);
    if (!anchorNode) {
      if (typeof showNotification === 'function') {
        showNotification({ message: '划词线程锚点已丢失，已退出线程模式', type: 'warning' });
      }
      threadManager.exitThread?.();
      return null;
    }

    return {
      threadId,
      anchorMessageId,
      selectionText: info.annotation?.selectionText || threadManager.getActiveSelectionText?.() || '',
      annotation: info.annotation
    };
  }

  /**
   * 线程消息的历史补丁字段（用于标记“该消息属于某条划词线程”）。
   * @param {Object|null} threadContext
   * @returns {Object|null}
   */
  function buildThreadHistoryPatch(threadContext) {
    if (!threadContext) return null;
    return {
      threadId: threadContext.threadId,
      threadAnchorId: threadContext.anchorMessageId,
      threadSelectionText: threadContext.selectionText || '',
      threadRootId: threadContext.annotation?.rootMessageId || null
    };
  }

  /**
   * 确保线程根节点存在（隐藏的“> 选中文本”用户消息）。
   * @param {Object} threadContext
   * @returns {string|null} rootMessageId
   */
  function ensureThreadRootMessage(threadContext) {
    if (!threadContext || !threadContext.annotation) return null;
    if (threadContext.annotation.rootMessageId) {
      threadContext.rootMessageId = threadContext.annotation.rootMessageId;
      return threadContext.annotation.rootMessageId;
    }

    const selectionText = threadContext.selectionText || '';
    const content = selectionText ? `> ${selectionText}` : '>';
    const node = chatHistoryManager.addMessageToTreeWithOptions(
      'user',
      content,
      threadContext.anchorMessageId,
      { preserveCurrentNode: true }
    );

    if (!node) return null;
    node.threadId = threadContext.threadId;
    node.threadAnchorId = threadContext.anchorMessageId;
    node.threadSelectionText = threadContext.selectionText || '';
    node.threadHiddenSelection = true;
    node.threadMatchIndex = Number.isFinite(threadContext.annotation.matchIndex)
      ? threadContext.annotation.matchIndex
      : 0;

    threadContext.annotation.rootMessageId = node.id;
    threadContext.annotation.lastMessageId = node.id;
    threadContext.rootMessageId = node.id;
    threadContext.lastMessageId = node.id;
    return node.id;
  }

  /**
   * 更新线程的最新消息 ID（用于拼接上下文/恢复线程）。
   * @param {Object|null} threadContext
   * @param {string|null} messageId
   */
  function updateThreadLastMessage(threadContext, messageId) {
    if (!threadContext || !threadContext.annotation || !messageId) return;
    threadContext.annotation.lastMessageId = messageId;
    threadContext.lastMessageId = messageId;
  }

  /**
   * 构造“主链 + 线程链”的上下文序列。
   * - 主链：从根到锚点消息；
   * - 线程链：从隐藏选中文本到线程最新消息。
   *
   * @param {Object|null} threadContext
   * @param {string|null} [lastMessageIdOverride]
   * @returns {Array<Object>}
   */
  function buildThreadConversationChain(threadContext, lastMessageIdOverride = null) {
    if (!threadContext) return getCurrentConversationChain();
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    const findNode = (id) => nodes.find(m => m.id === id) || null;

    const mainChain = [];
    let currentId = threadContext.anchorMessageId;
    while (currentId) {
      const node = findNode(currentId);
      if (!node) break;
      mainChain.unshift(node);
      currentId = node.parentId;
    }

    const rootId = threadContext.annotation?.rootMessageId || null;
    const lastId = lastMessageIdOverride || threadContext.annotation?.lastMessageId || rootId;
    const threadChain = [];
    if (rootId && lastId) {
      let threadCurrentId = lastId;
      while (threadCurrentId) {
        const node = findNode(threadCurrentId);
        if (!node) break;
        threadChain.unshift(node);
        if (threadCurrentId === rootId) break;
        threadCurrentId = node.parentId;
      }
      if (threadChain.length && threadChain[0].id !== rootId) {
        const rootNode = findNode(rootId);
        if (rootNode) threadChain.unshift(rootNode);
      }
    }

    return mainChain.concat(threadChain);
  }

  /**
   * 线程滚动容器解析：
   * - 侧栏内联模式：线程容器嵌套在 chatContainer，应滚动 chatContainer；
   * - 全屏双栏模式：线程容器独立滚动。
   *
   * @param {Object|null} threadContext
   * @returns {HTMLElement|null}
   */
  function resolveThreadScrollContainer(threadContext) {
    const container = threadContext?.container || null;
    if (!container) return null;
    const isNested = typeof container.closest === 'function'
      ? !!container.closest('#chat-container')
      : false;
    return isNested ? chatContainer : container;
  }

  // 判断“当前 UI 是否正在展示该线程”，用于避免跨线程渲染互相污染。
  function isThreadUiActive(threadContext) {
    if (!threadContext) return false;
    const threadManager = services.selectionThreadManager;
    if (!threadManager?.isThreadModeActive?.()) return false;
    const activeThreadId = threadManager.getActiveThreadId?.();
    return !!(activeThreadId && activeThreadId === threadContext.threadId);
  }

  // 仅当线程 UI 可见且匹配时，返回可滚动容器；否则返回 null。
  function resolveThreadUiContainer(threadContext) {
    if (!threadContext) return null;
    if (!isThreadUiActive(threadContext)) return null;
    return resolveThreadScrollContainer(threadContext);
  }

  // 线程后台生成时仅写入历史（不渲染 DOM），避免与当前线程视图串线。
  function createThreadAiMessageHistoryOnly(payload) {
    const {
      content,
      thoughts,
      historyParentId,
      historyPatch
    } = payload || {};
    if (!historyParentId) return null;
    const processedContent = imageHandler.processImageTags(content || '', null);
    const addWithOptions = typeof chatHistoryManager.addMessageToTreeWithOptions === 'function';
    const node = addWithOptions
      ? chatHistoryManager.addMessageToTreeWithOptions(
          'assistant',
          processedContent,
          historyParentId,
          { preserveCurrentNode: true }
        )
      : chatHistoryManager.addMessageToTree('assistant', processedContent, historyParentId);
    if (!node) return null;
    if (thoughts !== undefined) node.thoughtsRaw = thoughts;
    if (historyPatch && typeof historyPatch === 'object') {
      Object.assign(node, historyPatch);
    }
    node.hasInlineImages = Array.isArray(processedContent) && processedContent.some(p => p?.type === 'image_url');
    return node;
  }

  /**
   * 安全更新“加载占位消息”的状态文案。
   *
   * 设计背景：
   * - 流式输出在拿到首个 token 后会移除 loadingMessage 并创建正式 AI 消息；
   * - 用户手动停止/自动重试/异常路径也可能提前移除或替换该元素；
   * - 因此任何状态更新都必须先确认节点仍在 DOM 中，避免写入已失效的引用。
   *
   * @param {HTMLElement|null} loadingMessage
   * @param {string} text - 需要展示的短文案（尽量一行可读）
   * @param {Object|null} [meta] - 更细粒度的补充信息（仅用于 title 悬停提示；不得包含敏感数据）
   */
  function updateLoadingStatus(loadingMessage, text, meta = null) {
    if (!loadingMessage || !loadingMessage.parentNode) return;
    loadingMessage.textContent = text;

    // 使用 title 提供“更细节但不打扰”的信息密度：鼠标悬停可查看。
    // 注意：不要在这里拼接/透出任何 API Key 或包含 key 的 URL。
    if (!meta || typeof meta !== 'object') {
      loadingMessage.title = '';
      return;
    }
    try {
      const lines = [];
      if (meta.stage) lines.push(`阶段: ${String(meta.stage)}`);
      if (meta.apiBase) lines.push(`API: ${String(meta.apiBase)}`);
      if (meta.modelName) lines.push(`模型: ${String(meta.modelName)}`);
      if (Number.isFinite(meta.httpStatus)) lines.push(`HTTP: ${meta.httpStatus}`);
      if (typeof meta.note === 'string' && meta.note.trim()) lines.push(meta.note.trim().slice(0, 300));
      loadingMessage.title = lines.join('\n');
    } catch (_) {
      loadingMessage.title = '';
    }
  }

  /**
   * 将 apiManager.sendRequest 的“结构化阶段事件”映射为对用户可见的文案。
   * 目的：把“正在发送请求...”细分为更贴近真实网络生命周期的多个阶段，提升透明度。
   *
   * 注意：Fetch API 不提供精确上传进度，因此这里的“上传/等待”只表示所处阶段，而非字节级进度。
   *
   * @param {HTMLElement|null} loadingMessage
   * @returns {(evt: {stage: string, [key: string]: any}) => void}
   */
  function createRequestStatusHandler(loadingMessage) {
    return (evt) => {
      if (!loadingMessage || !loadingMessage.parentNode) return;
      if (!evt || typeof evt !== 'object') return;

      const stage = evt.stage;
      switch (stage) {
        case 'api_key_selected': {
          const keyCount = Number(evt.keyCount) || 1;
          const keyIndex = Number(evt.keyIndex);
          const hasIndex = Number.isFinite(keyIndex) && keyIndex >= 0;
          const text = keyCount > 1 && hasIndex
            ? `正在选择可用的 API Key (${keyIndex + 1}/${keyCount})...`
            : '正在校验 API Key...';
          updateLoadingStatus(loadingMessage, text, {
            stage,
            apiBase: evt.apiBase || '',
            modelName: evt.modelName || '',
            note: keyCount > 1 ? '提示：检测到多 Key 配置，必要时会自动轮换以提升成功率。' : ''
          });
          break;
        }
        case 'http_request_start': {
          updateLoadingStatus(loadingMessage, '正在建立连接并上传请求载荷...', {
            stage,
            apiBase: evt.apiBase || '',
            modelName: evt.modelName || ''
          });
          break;
        }
        case 'http_request_sent': {
          updateLoadingStatus(loadingMessage, '请求已发出，等待服务器响应...', {
            stage,
            apiBase: evt.apiBase || '',
            modelName: evt.modelName || '',
            note: '此阶段可能包含：上传剩余载荷、服务器排队、模型开始计算。'
          });
          break;
        }
        case 'http_429_rate_limited': {
          const willRetry = !!evt.willRetry;
          updateLoadingStatus(
            loadingMessage,
            willRetry ? '触发限流 (HTTP 429)，正在切换 API Key 重试...' : '触发限流 (HTTP 429)...',
            { stage, apiBase: evt.apiBase || '', modelName: evt.modelName || '', httpStatus: 429 }
          );
          break;
        }
        case 'http_auth_or_bad_request_key_blacklisted': {
          const httpStatus = Number(evt.status);
          const willRetry = !!evt.willRetry;
          updateLoadingStatus(
            loadingMessage,
            willRetry
              ? `API Key 可能无效/受限 (HTTP ${Number.isFinite(httpStatus) ? httpStatus : '?'})，正在切换 Key 重试...`
              : `API Key 可能无效/受限 (HTTP ${Number.isFinite(httpStatus) ? httpStatus : '?'})...`,
            { stage, apiBase: evt.apiBase || '', modelName: evt.modelName || '', httpStatus }
          );
          break;
        }
        default:
          // 其他阶段先不做 UI 文案映射，避免过度刷屏；需要时再逐步补充。
          break;
      }
    };
  }

  //TODO:
  //对于通过<think>标签传输的思考过程 只匹配开头的think标签到第一个<think/>结尾的部分作为思考过程，后续传输文本里如果再出现think就视为正文

  /**
   * 将流式增量按 <think> 标签拆分到思考块与正文块。
   * 若已进入思考模式，则持续写入直到遇到闭合标签。
   * @param {string} delta - 本次增量文本
   * @param {boolean} forceThought - 是否优先视为思考文本（例如 part.thought=true）
   * @returns {{answerDelta: string, thoughtDelta: string}}
   */
  function splitDeltaByThinkTags(delta, forceThought = false) {
    if (typeof delta !== 'string' || delta.length === 0) {
      return { answerDelta: '', thoughtDelta: '' };
    }

    let answerDelta = '';
    let thoughtDelta = '';
    let remaining = delta;

    while (remaining.length > 0) {
      if (isInStreamingThoughtBlock) {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx === -1) {
          thoughtDelta += remaining;
          remaining = '';
          continue;
        }
        thoughtDelta += remaining.slice(0, closeIdx);
        remaining = remaining.slice(closeIdx + 8);
        isInStreamingThoughtBlock = false;
        continue;
      }

      const openIdx = remaining.indexOf('<think>');
      if (openIdx === -1) {
        if (forceThought) {
          thoughtDelta += remaining;
        } else {
          answerDelta += remaining;
        }
        remaining = '';
        continue;
      }

      // 先写入开标签前的内容
      if (openIdx > 0) {
        const before = remaining.slice(0, openIdx);
        if (forceThought) {
          thoughtDelta += before;
        } else {
          answerDelta += before;
        }
      }

      // 跳过 <think> 标签
      remaining = remaining.slice(openIdx + 7);

      const closeIdx = remaining.indexOf('</think>');
      if (closeIdx === -1) {
        // 没有闭合标签，进入思考模式，剩余内容全部写入思考摘要
        thoughtDelta += remaining;
        remaining = '';
        isInStreamingThoughtBlock = true;
        continue;
      }

      // 有闭合标签，截取其中内容写入思考摘要
      thoughtDelta += remaining.slice(0, closeIdx);
      remaining = remaining.slice(closeIdx + 8);
    }

    return { answerDelta, thoughtDelta };
  }
  let currentConversationId = null;

  /**
   * 检测 Gemini 返回中「HTTP 200 但因安全原因被拦截」的场景，并给出统一的错误消息
   *
   * 典型表现为：
   * - 顶层 HTTP 状态码是 200（sendRequest 不会把它视为错误）
   * - candidates[0].finishReason 为 IMAGE_SAFETY / SAFETY 等安全相关值
   *   或 promptFeedback.blockReason 为 SAFETY
   * - 且本帧 / 本事件中没有任何可用的 text 正文内容
   *
   * 这类情况在用户看来是“200 返回错误”，需要抛出 Error 让 sendMessage 的自动重试逻辑接管。
   * 注意：为了避免影响正常有输出但以 SAFETY 结束的情况，这里要求「当前帧没有正文」且
   *       流式场景下前面也没有输出过内容（hasExistingContent=false）才视为错误。
   *
   * @param {Object} json - Gemini 返回的 JSON 对象（整帧或 SSE 事件数据）
   * @param {Object} [options]
   * @param {boolean} [options.hasExistingContent=false] - 对于流式场景，标记之前是否已经输出过正文
   * @returns {{blocked: boolean, message: string}|null}
   */
  function detectGeminiSafetyBlock(json, options = {}) {
    const hasExistingContent = !!options.hasExistingContent;
    if (!json || typeof json !== 'object') return null;

    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    const candidate = candidates[0] || null;

    const finishReason = candidate?.finishReason || candidate?.finish_reason || null;
    const finishMessage = candidate?.finishMessage || candidate?.finish_message || null;

    const parts = candidate?.content?.parts || [];
    const hasTextContent = Array.isArray(parts) && parts.some(
      (part) => typeof part?.text === 'string' && part.text.trim() !== ''
    );

    const promptFeedback = json.promptFeedback || json.prompt_feedback || null;
    const promptBlockReason = promptFeedback?.blockReason || promptFeedback?.block_reason || null;
    const promptBlockMessage = promptFeedback?.blockReasonMessage || promptFeedback?.block_reason_message || null;

    const reasonStr = [finishReason, promptBlockReason]
      .filter(Boolean)
      .map(String)
      .join(', ');
    const isSafetyReason = /(SAFETY|IMAGE_SAFETY|PROHIBITED_CONTENT)/i.test(reasonStr);

    // 没有命中安全相关原因，或当前/之前已经有正文输出，则不视为“200 返回错误”
    if (!isSafetyReason || hasTextContent || hasExistingContent) {
      return null;
    }

    const message =
      finishMessage ||
      promptBlockMessage ||
      'Gemini 返回安全拦截结果（HTTP 200），未包含可用内容，请稍后重试。';

    return { blocked: true, message };
  }

  // 取消内部自动重试和定时器逻辑：由外部消费返回值并决定是否重试

  /**
   * 获取是否应该自动滚动
   * @returns {boolean} 是否应该自动滚动
   */
  function getShouldAutoScroll() {
    return shouldAutoScroll;
  }

  /**
   * 设置是否应该自动滚动
   * @param {boolean} value - 是否应该自动滚动
   */
  function setShouldAutoScroll(value) {
    shouldAutoScroll = value;
  }

  /**
   * 清空消息输入框和图片容器
   * @private
   */
  function clearInputs() {
    try {
      if (inputController) {
        inputController.clear();
      } else {
        messageInput.innerHTML = '';
        imageContainer.innerHTML = '';
        appContext.services.uiManager.resetInputHeight();
      }
      try { appContext.services.uiManager?.updateSendButtonState?.(); } catch (_) {}
    } catch (error) {
      console.error('清空消息输入框和图片容器失败:', error);
    }
  }

  function escapeMessageIdForSelector(id) {
    const raw = (id == null) ? '' : String(id);
    if (!raw) return '';
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(raw);
      }
    } catch (_) {}
    // 极简回退：避免引号/反斜杠破坏 attribute selector（messageId 目前是 msg_...，通常不会走到这里）
    return raw.replace(/["\\]/g, '\\$&');
  }

  /**
   * 读取当前滚动视口内“最靠上的可见消息元素”（阅读锚点）。
   *
   * 用途：当用户正在阅读对话中部/顶部时，如果我们更新了其上方某条消息（例如“重新生成”导致该消息变长），
   * 浏览器会因为内容高度变化而让视口中的内容整体下移/上移，造成“跳一下”的体验。
   * 这里通过锁定“当前屏幕上第一条可见消息”的 top 位置来抵消这种跳动。
   *
   * 性能：使用二分查找在 chatContainer.children 中定位第一个 bottom > scrollTop 的元素，避免每次遍历全部消息。
   *
   * @param {HTMLElement} container - chatContainer
   * @returns {HTMLElement|null}
   */
  function findFirstVisibleMessageElement(container) {
    if (!container) return null;
    const children = container.children;
    const total = children ? children.length : 0;
    if (!total) return null;

    const viewportTop = container.scrollTop || 0;
    const EPS = 1; // 允许 1px 误差，避免边界抖动

    let low = 0;
    let high = total - 1;
    let firstIdx = total;

    // 找到第一个满足：elementBottom > viewportTop 的元素
    while (low <= high) {
      const mid = (low + high) >> 1;
      const el = children[mid];
      const bottom = (el?.offsetTop || 0) + (el?.offsetHeight || 0);
      if (bottom <= viewportTop + EPS) {
        low = mid + 1;
      } else {
        firstIdx = mid;
        high = mid - 1;
      }
    }

    // 从 firstIdx 起向后找第一个 .message（chatContainer 理论上只包含 .message，这里做健壮性处理）
    for (let i = firstIdx; i < total; i += 1) {
      const el = children[i];
      if (el && el.classList && el.classList.contains('message')) return el;
    }
    return null;
  }

  /**
   * 仅在“重新生成（原地替换指定 AI 消息）且目标消息位于当前阅读位置上方”时，捕获阅读锚点。
   *
   * 捕获内容：锚点 messageId + 锚点 top 相对于容器视口的偏移（offsetTop - scrollTop）。
   * 后续在 DOM 更新后，通过调整 scrollTop 把该偏移恢复，从而保持用户阅读位置不跳动。
   *
   * @param {HTMLElement} container
   * @param {string|null} targetMessageId - 正在被更新的目标 AI 消息ID
   * @param {Object|null} attemptState - 当前请求 attempt
   * @returns {{ anchorId: string, anchorOffset: number } | null}
   */
  function captureReadingAnchorForRegenerate(container, targetMessageId, attemptState) {
    if (!attemptState || attemptState.preserveReadingPosition !== true) return null;
    if (!targetMessageId || targetMessageId !== attemptState.preserveTargetMessageId) return null;

    const safeTargetId = escapeMessageIdForSelector(targetMessageId);
    const targetEl = container.querySelector(`.message[data-message-id="${safeTargetId}"]`);
    if (!targetEl) return null;

    const viewportTop = container.scrollTop || 0;
    const viewportBottom = viewportTop + (container.clientHeight || 0);
    const targetTop = targetEl.offsetTop || 0;
    const targetBottom = targetTop + (targetEl.offsetHeight || 0);
    const isTargetVisible = targetBottom > viewportTop && targetTop < viewportBottom;
    // 仅在目标消息“出现在当前视口内”时锁定阅读位置，避免视口外消息被反复“吸住”在顶部。
    if (!isTargetVisible) return null;

    const anchorEl = findFirstVisibleMessageElement(container);
    if (!anchorEl) return null;

    const anchorId = anchorEl.getAttribute('data-message-id') || '';
    if (!anchorId) return null;

    // 只有当“目标消息在锚点之前”（也就是目标位于用户阅读位置上方）时才需要补偿滚动
    try {
      if (anchorEl === targetEl) return null;
      const pos = targetEl.compareDocumentPosition(anchorEl);
      const isTargetAboveAnchor = !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!isTargetAboveAnchor) return null;
    } catch (_) {
      return null;
    }

    return {
      anchorId,
      anchorOffset: (anchorEl.offsetTop || 0) - (container.scrollTop || 0)
    };
  }

  /**
   * 恢复阅读锚点位置：让锚点消息的 top 坐标保持不变，避免视图跳动。
   * @param {HTMLElement} container
   * @param {{ anchorId: string, anchorOffset: number } | null} anchorInfo
   */
  function restoreReadingAnchor(container, anchorInfo) {
    if (!container || !anchorInfo) return;
    const anchorId = anchorInfo.anchorId || '';
    if (!anchorId) return;

    const safeAnchorId = escapeMessageIdForSelector(anchorId);
    const anchorEl = container.querySelector(`.message[data-message-id="${safeAnchorId}"]`);
    if (!anchorEl) return;

    const currentOffset = (anchorEl.offsetTop || 0) - (container.scrollTop || 0);
    const delta = currentOffset - (Number(anchorInfo.anchorOffset) || 0);
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;

    // 关键：补偿 scrollTop，使锚点消息回到原来的像素位置
    container.scrollTop = (container.scrollTop || 0) + delta;
  }


  // 重新生成时清理用户手动折叠标记，确保新的思考过程按默认规则自动展开/折叠。
  function resetThoughtsToggleStateForRegenerate(targetElement) {
    if (!targetElement) return;
    const thoughtsContent = targetElement.querySelector('.thoughts-content');
    if (!thoughtsContent) return;
    if (thoughtsContent.dataset && thoughtsContent.dataset.userToggled) {
      delete thoughtsContent.dataset.userToggled;
    }
  }

  /**
   * 重新生成（原地替换）时清空旧的“推理签名/推理字段”。
   *
   * 设计说明：
   * - 推理签名与“该条 assistant 的回答/推理内容”绑定；
   * - 当我们开始把新的生成结果写回到旧消息时，旧签名将不再匹配；
   * - 若本次响应未返回新签名，就必须保持为空，否则后续把历史回传给上游时会触发
   *   “signature required / invalid signature” 等校验错误；
   * - 这里同时清理 OpenAI 兼容字段（reasoning_content/tool_calls），避免旧内容残留导致语义错配。
   *
   * 注意：只在“原地替换的重新生成”场景触发；普通追加新消息不需要清理。
   *
   * @param {string|null} messageId
   * @param {Object|null} attemptState
   * @returns {boolean} 是否发生了清空
   */
  function clearBoundSignatureForRegenerate(messageId, attemptState) {
    const id = (typeof messageId === 'string' && messageId.trim()) ? messageId.trim() : '';
    if (!id) return false;
    if (!attemptState || attemptState.preserveTargetMessageId !== id) return false;

    try {
      const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === id) || null;
      if (!node || node.role !== 'assistant') return false;

      node.thoughtSignature = null;
      node.thoughtSignatureSource = null;
      node.reasoning_content = null;
      node.tool_calls = null;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 验证API配置是否有效
   * @private
   * @returns {boolean} 配置是否有效
   */
  function validateApiConfig() {
    const config = apiManager.getSelectedConfig();
    if (!config?.baseUrl || !config?.apiKey) {
      messageProcessor.appendMessage('请在设置中完善 API 配置', 'ai', true);
      return false;
    }
    return true;
  }

  /**
   * 获取网页内容
   * @private
   * @returns {Promise<Object|null>} 页面内容对象，包含标题、URL和内容文本
   */
  async function getPageContent() {
    try {
      console.log('发送获取网页内容请求');
      const response = await chrome.runtime.sendMessage({
        type: 'GET_PAGE_CONTENT_FROM_SIDEBAR'
      });
      if (response) {
        state.pageInfo = response;
      }
      return response;
    } catch (error) {
      console.error('获取网页内容失败:', error);
      return null;
    }
  }

  function GetInputContainer() {
    return document.getElementById('input-container');
  }

  /**
   * 进入临时模式，不获取网页内容
   * @public
   */
  function enterTemporaryMode() {
    isTemporaryMode = true;
    GetInputContainer().classList.add('temporary-mode');
    document.body.classList.add('temporary-mode');
    messageInput.setAttribute('placeholder', '纯对话模式，输入消息...');
    persistTempModeSessionState(true);
    try {
      document.dispatchEvent(new CustomEvent('TEMP_MODE_CHANGED', { detail: { isOn: true } }));
    } catch (_) {}
  }

  /**
   * 退出临时模式
   * @public
   */
  function exitTemporaryMode() {
    isTemporaryMode = false;
    GetInputContainer().classList.remove('temporary-mode');
    document.body.classList.remove('temporary-mode');
    messageInput.setAttribute('placeholder', '输入消息...');
    persistTempModeSessionState(false);
    try {
      document.dispatchEvent(new CustomEvent('TEMP_MODE_CHANGED', { detail: { isOn: false } }));
    } catch (_) {}
  }

  if (!state.isStandalone) {
    const storedTempMode = readTempModeSessionState();
    if (storedTempMode === true) {
      enterTemporaryMode();
    }
  }

  /**
   * 核心发送逻辑（单路请求），不处理 [xN] 并行语法。
   *
   * 说明：
   * - 对外暴露的 API 请使用 sendMessage（见下方），sendMessage 会在需要时解析 [xN] 并发起多路并行请求；
   * - sendMessageCore 始终只处理“一次对话请求”，方便自动重试逻辑直接复用，而不会重复拆分并行。
   *
   * @private
   * @param {Object} [options] - 可选参数对象
   * @param {Array<string>} [options.injectedSystemMessages] - 重新生成时保留的系统消息
   * @param {string} [options.specificPromptType] - 指定使用的提示词类型
   * @param {Object|null} [options.promptMeta] - 与提示词类型相关的补充信息（例如 { selectionText }）
   * @param {string} [options.originalMessageText] - 原始消息文本，用于恢复输入框内容
   * @param {boolean} [options.regenerateMode] - 是否为重新生成模式
   * @param {string} [options.messageId] - 重新生成模式下的消息ID（通常是用户消息的ID）
   * @param {string|null} [options.targetAiMessageId] - 重新生成模式下要“原地替换”的 AI 消息ID（为空则按旧逻辑追加新消息）
   * @param {Object|string} [options.api] - API 选择参数：可为完整配置对象、配置 id/displayName/modelName、'selected'、或 {favoriteIndex}
   * @param {Object} [options.resolvedApiConfig] - 已解析好的 API 配置（优先于 api 参数，完全绕过内部选择策略）
   * @param {boolean} [options.forceSendFullHistory] - 是否强制发送完整历史
   * @param {Object|null} [options.pageContentSnapshot] - 若提供则使用该网页内容快照，避免再次获取
   * @param {Array<Object>|null} [options.conversationSnapshot] - 若提供则使用该会话历史快照（数组 of nodes）构建消息
   * @returns {Promise<{ ok: true, apiConfig: Object } | { ok: false, error: Error, apiConfig: Object, retryHint: Object, retry: (delayMs?: number, override?: Object) => Promise<any> }>} 结果对象（供外部无状态重试）
   */
  async function sendMessageCore(options = {}) {
    // 验证API配置
    if (!validateApiConfig()) return;

    // 从options中提取重新生成所需的变量
    const {
      injectedSystemMessages: existingInjectedSystemMessages = [],
      specificPromptType = null,
      promptMeta: externalPromptMeta = null,
      originalMessageText = null,
      regenerateMode = false,
      messageId = null,
      targetAiMessageId = null,
      forceSendFullHistory = false,
      api = null,
      resolvedApiConfig = null,
      pageContentSnapshot = null,
      conversationSnapshot = null,
      aspectRatioOverride: externalAspectRatioOverride = null
    } = options;

    const autoRetrySetting = settingsManager?.getSetting?.('autoRetry');
    if (typeof autoRetrySetting === 'boolean') {
      autoRetryEnabled = autoRetrySetting;
    }

    const autoRetryAttempt = (typeof options.__autoRetryAttempt === 'number' && options.__autoRetryAttempt >= 0)
      ? options.__autoRetryAttempt
      : 0;
    let aspectRatioOverride = externalAspectRatioOverride || null;

    const hasImagesInInput = inputController ? inputController.hasImages() : !!imageContainer.querySelector('.image-tag');
    // 如果是重新生成，使用原始消息文本；否则从输入框获取
    let messageText = (originalMessageText !== null && originalMessageText !== undefined)
      ? originalMessageText
      : (inputController ? inputController.getInputText() : messageInput.textContent);
    const imageContainsScreenshot = inputController ? inputController.hasScreenshot() : !!imageContainer.querySelector('img[alt="page-screenshot.png"]');

    // 如果消息为空且没有图片标签，则不发送消息
    const isEmptyMessage = !messageText && !hasImagesInInput;
    // 允许在“强制发送完整历史”或“重新生成模式”下继续执行（不新增用户消息）
    if (isEmptyMessage && !regenerateMode && !forceSendFullHistory) return;

    let activeThreadContext = null;
    // 获取当前提示词设置
    const promptsConfig = promptSettingsManager.getPrompts();
    const currentPromptType = specificPromptType || messageProcessor.getPromptTypeFromContent(messageText, promptsConfig);

    const preprocessorConfig = resolvedApiConfig
      || (api != null && typeof apiManager.resolveApiParam === 'function' ? apiManager.resolveApiParam(api) : null)
      || apiManager.getSelectedConfig();
    const skipUserMessagePreprocess = options.__skipUserMessagePreprocess === true;
    let messageTextForHistory = messageText;
    let preprocessedMessageText = null;
    let shouldApplyPreprocessor = false;
    let preprocessHistoryPatch = null;
    let injectedMessages = [];
    let hasInjectedBlocks = false;

    if (skipUserMessagePreprocess) {
      shouldApplyPreprocessor = regenerateMode || !isEmptyMessage;
      preprocessedMessageText = messageText;
      injectedMessages = [];
      hasInjectedBlocks = false;
    } else {
      const template = (typeof preprocessorConfig?.userMessagePreprocessorTemplate === 'string')
        ? preprocessorConfig.userMessagePreprocessorTemplate
        : '';
      const hasTemplate = template.trim().length > 0;
      shouldApplyPreprocessor = hasTemplate && (regenerateMode || !isEmptyMessage);
      if (shouldApplyPreprocessor) {
        const baseText = resolvePreprocessBaseText({ messageText, regenerateMode, messageId });
        const templateResult = renderUserMessageTemplateWithInjection({ template, inputText: baseText });
        preprocessedMessageText = templateResult.renderedText;
        injectedMessages = templateResult.injectedMessages;
        hasInjectedBlocks = templateResult.hasInjectedBlocks;
        const allowPreprocessHistory = !regenerateMode
          && preprocessorConfig?.userMessagePreprocessorIncludeInHistory
          && !hasInjectedBlocks;
        if (allowPreprocessHistory) {
          messageTextForHistory = preprocessedMessageText;
          preprocessHistoryPatch = {
            preprocessOriginalText: baseText,
            preprocessRenderedText: preprocessedMessageText
          };
        }
      }
    }

    const threadContextCandidate = resolveActiveThreadContext();
    if (threadContextCandidate && threadContainer) {
      // 重新生成时，仅当目标消息属于当前线程才启用线程上下文
      let shouldUseThreadContext = true;
      if (regenerateMode) {
        const targetId = (typeof targetAiMessageId === 'string' && targetAiMessageId.trim())
          ? targetAiMessageId.trim()
          : (typeof messageId === 'string' && messageId.trim() ? messageId.trim() : '');
        if (targetId) {
          const targetNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === targetId) || null;
          shouldUseThreadContext = !!(targetNode && targetNode.threadId === threadContextCandidate.threadId);
        }
      }

      if (shouldUseThreadContext) {
        activeThreadContext = threadContextCandidate;
        activeThreadContext.container = threadContainer;
        // 线程内删除/重生成可能导致 lastMessageId 失效，发送前先修复注解链路。
        const repairedAnnotation = services.selectionThreadManager?.repairThreadAnnotation?.(activeThreadContext.threadId);
        if (repairedAnnotation) {
          activeThreadContext.annotation = repairedAnnotation;
        }
        activeThreadContext.rootMessageId = activeThreadContext.annotation?.rootMessageId || null;
        activeThreadContext.lastMessageId = activeThreadContext.annotation?.lastMessageId || null;
      }
    }

    // 重新生成“指定 AI 消息”的场景：如果提供 targetAiMessageId，则尝试进入“原地替换”模式。
    // 说明：
    // - messageId 仍然表示“对应的用户消息ID”，用于 composeMessages 裁剪上下文；
    // - targetAiMessageId 表示“要被替换内容的 AI 消息ID”，用于把生成结果写回到同一条消息上；
    // - 若校验失败（找不到消息/不是 assistant），会自动回退为旧逻辑：追加一条新的 AI 消息。
    const normalizedTargetAiMessageId = (typeof targetAiMessageId === 'string' && targetAiMessageId.trim())
      ? targetAiMessageId.trim()
      : null;
    // 提前创建 loadingMessage 配合finally使用
    let loadingMessage;
    let canUpdateExistingAiMessage = false;
    let pageContentResponse = null;
    let pageContentLength = 0;
    let conversationChain = null;
    let preferredApiConfig = null;
    let effectiveApiConfig = null;

    const beginAttempt = () => {
      // 为当前请求创建独立的取消控制器与状态对象
      const attemptState = {
        id: `attempt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        controller: new AbortController(),
        manualAbort: false,
        finished: false,
        loadingMessage: null,
        aiMessageId: null
      };
      activeAttempts.set(attemptState.id, attemptState);

      // 如果这是第一个进行中的请求，开启全局“正在处理”状态与自动滚动
      if (activeAttempts.size === 1) {
        isProcessingMessage = true;
        shouldAutoScroll = true;
        GetInputContainer().classList.add('auto-scroll-glow');
      }

      return attemptState;
    };

	    const finalizeAttempt = (attemptState) => {
	      if (!attemptState || attemptState.finished) return;

	      // 重要：请求结束/失败/中断时，先把最后一帧 UI 更新尽量落地，并清理节流器的定时器。
	      // 否则可能出现“请求已结束但仍在后台更新 DOM”的情况，进一步放大卡顿或触发对已删除节点的更新。
	      try { attemptState.uiUpdateThrottler?.flush?.({ force: true }); } catch (_) {}
	      try { attemptState.uiUpdateThrottler?.cancel?.(); } catch (_) {}
	      try { attemptState.uiUpdateThrottler = null; } catch (_) {}

	      attemptState.finished = true;
	      activeAttempts.delete(attemptState.id);

      const hasOtherAttempts = activeAttempts.size > 0;
      if (!hasOtherAttempts) {
        // 所有请求都已结束，恢复静止状态
        isProcessingMessage = false;
        shouldAutoScroll = false;
        GetInputContainer().classList.remove('auto-scroll-glow');
        GetInputContainer().classList.remove('auto-scroll-glow-active');
      }

      // 清理与本次尝试相关的 UI 状态
      if (attemptState.aiMessageId) {
        const safeAiMessageId = escapeMessageIdForSelector(attemptState.aiMessageId);
        const selector = safeAiMessageId ? `.message[data-message-id="${safeAiMessageId}"]` : '';
        const aiEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContainer ? threadContainer.querySelector(selector) : null))
          : null;
        if (aiEl) {
          aiEl.classList.remove('updating');
          aiEl.classList.remove('regenerating');
        }
      } else if (attemptState.loadingMessage && attemptState.loadingMessage.parentNode) {
        // 尚未产生正式 AI 消息，仅存在 loading 占位
        attemptState.loadingMessage.remove();
      }
    };

    let attempt = null;

    try {
      // 开始处理消息：为本次请求注册 attempt，并在必要时开启全局“正在处理”状态
      attempt = beginAttempt();
      const signal = attempt.controller.signal;

      // 如果已有注入的系统消息，则使用它；否则从消息文本中提取
      const injectedSystemMessages = existingInjectedSystemMessages.length > 0 ? 
                                 existingInjectedSystemMessages : [];
                                   
      if (injectedSystemMessages.length === 0) {
        // 提取提示词中注入的系统消息
        const systemMessageRegex = /{{system}}([\s\S]*?){{end_system}}/g;
        messageText = messageText.replace(systemMessageRegex, (match, capture) => {
          injectedSystemMessages.push(capture);
          console.log('捕获注入的系统消息：', injectedSystemMessages);
          return '';
        });
      }

      // 在重新生成模式下，不添加新的用户消息
      let userMessageDiv;
      if (!isEmptyMessage && !regenerateMode) {
        const promptMetaForHistory = buildPromptMetaForHistory({
          promptType: currentPromptType || 'none',
          promptMeta: externalPromptMeta,
          messageText,
          promptsConfig
        });
        const historyMeta = { promptType: currentPromptType || 'none', promptMeta: promptMetaForHistory };

        if (activeThreadContext) {
          // 线程模式：先补齐隐藏的“> 选中文本”节点，再把用户消息挂在其后
          const threadRootId = ensureThreadRootMessage(activeThreadContext);
          if (threadRootId) {
            const historyParentId = activeThreadContext.annotation?.lastMessageId || threadRootId;
            const threadHistoryPatch = buildThreadHistoryPatch(activeThreadContext);
            const historyPatch = (threadHistoryPatch || preprocessHistoryPatch)
              ? { ...(threadHistoryPatch || {}), ...(preprocessHistoryPatch || {}) }
              : null;
            userMessageDiv = messageProcessor.appendMessage(
              messageTextForHistory,
              'user',
              false,
              null,
              inputController ? inputController.getImagesHTML() : imageContainer.innerHTML,
              null,
              null,
              historyMeta,
              {
                container: activeThreadContext.container,
                historyParentId,
                preserveCurrentNode: true,
                historyPatch
              }
            );

            if (userMessageDiv) {
              const userMessageId = userMessageDiv.getAttribute('data-message-id') || '';
              if (userMessageId) {
                activeThreadContext.userMessageId = userMessageId;
                updateThreadLastMessage(activeThreadContext, userMessageId);
              }
            }
          } else {
            activeThreadContext = null;
          }
        }

        if (!userMessageDiv) {
          const messageOptions = preprocessHistoryPatch ? { historyPatch: preprocessHistoryPatch } : null;
          userMessageDiv = messageProcessor.appendMessage(
            messageTextForHistory,
            'user',
            false,
            null,
            inputController ? inputController.getImagesHTML() : imageContainer.innerHTML,
            null,
            null,
            historyMeta,
            messageOptions
          );
        }
      }

      if (activeThreadContext) {
        if (activeThreadContext.userMessageId) {
          activeThreadContext.parentMessageIdForAi = activeThreadContext.userMessageId;
        }
        attempt.threadContext = activeThreadContext;
      }

      // 清空输入区域
      if (!regenerateMode) {
        clearInputs();
      }

      // --- 重新生成：原地替换指定 AI 消息（不新增/不删除其他消息）---
      // 注意：这里只决定“写回目标”，不改变 composeMessages 的裁剪策略；裁剪仍由 messageId（用户消息ID）负责。
      if (regenerateMode && normalizedTargetAiMessageId) {
        try {
          const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === normalizedTargetAiMessageId) || null;
          const safeTargetId = escapeMessageIdForSelector(normalizedTargetAiMessageId);
          const selector = safeTargetId ? `.message[data-message-id="${safeTargetId}"]` : '';
          const el = selector
            ? (chatContainer.querySelector(selector)
              || (threadContainer ? threadContainer.querySelector(selector) : null))
            : null;
          const isAssistantNode = !!(node && node.role === 'assistant');
          const isAiElement = !!(el && el.classList && el.classList.contains('ai-message'));
          // 允许“仅历史节点存在但 DOM 缺失”的场景继续原地替换，避免线程切换时误追加新消息。
          canUpdateExistingAiMessage = !!isAssistantNode;

          if (canUpdateExistingAiMessage) {
            // 绑定 attempt 到目标 AI 消息，便于“停止更新”按消息粒度工作
            attempt.aiMessageId = normalizedTargetAiMessageId;
            // 阅读位置锁定：仅对“原地替换”重新生成开启。
            // - preserveTargetMessageId 用于在流式/非流式更新时判断是否需要做滚动补偿；
            // - preserveReadingPosition 用于总开关，避免普通发送/普通更新带来额外开销。
            attempt.preserveReadingPosition = true;
            attempt.preserveTargetMessageId = normalizedTargetAiMessageId;
            if (el) {
              resetThoughtsToggleStateForRegenerate(el);
              try {
                el.classList.add('updating');
                el.classList.add('regenerating');
              } catch (_) {}

              // 若目标并非最后一条 AI 消息，关闭自动滚动，避免视角被强行拉到底部
              try {
                const aiScope = (threadContainer && threadContainer.contains(el)) ? threadContainer : chatContainer;
                const aiMessages = aiScope.querySelectorAll('.message.ai-message');
                const lastAi = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
                if (lastAi && lastAi !== el) {
                  shouldAutoScroll = false;
                }
              } catch (_) {}
            }
          }
        } catch (e) {
          console.warn('校验 targetAiMessageId 失败，将回退为追加消息:', e);
          canUpdateExistingAiMessage = false;
        }
      }

      // 添加加载状态消息（仅在“追加新消息”模式下需要占位）
      if (!canUpdateExistingAiMessage) {
        const threadUiActive = isThreadUiActive(activeThreadContext);
        const loadingOptions = activeThreadContext
          ? { container: activeThreadContext.container, skipDom: !threadUiActive }
          : null;
        loadingMessage = messageProcessor.appendMessage('正在处理...', 'ai', true, null, null, null, null, null, loadingOptions);
        attempt.loadingMessage = loadingMessage;
        if (loadingMessage) {
          loadingMessage.classList.add('loading-message');
          // 让“等待回复”占位消息也带有 updating 状态，便于右键菜单显示“停止更新”
          loadingMessage.classList.add('updating');
        }
      } else {
        loadingMessage = null;
        attempt.loadingMessage = null;
      }

      // 如果不是临时模式，获取网页内容
      if (!isTemporaryMode) {
        if (pageContentSnapshot) {
          pageContentResponse = pageContentSnapshot;
        } else {
          updateLoadingStatus(loadingMessage, '正在获取网页内容...', { stage: 'get_page_content' });
          pageContentResponse = await getPageContent();
        }
        if (pageContentResponse) {
          pageContentLength = state.pageInfo?.content?.length || 0;

          // 兜底：为“首条用户消息”校准/补齐 pageMeta（固定会话来源页）
          //
          // 背景：
          // - appendMessage 时会尝试从 state.pageInfo 冻结 {url,title} 到首条用户消息节点上；
          // - 但 state.pageInfo 可能“滞后”于真实页面（例如切换网页后立即触发总结，URL_CHANGED 事件还没同步到 sidebar）；
          // - 更可靠的依据是本次请求实际使用的 pageContentResponse（它来自 content script，对应实际被总结/发送的页面内容）；
          // - 因此这里不仅要“补齐缺失”，还要允许在发现不一致时进行“校准覆盖”，避免新会话错绑到上一个对话的网页。
          try {
            if (!regenerateMode && userMessageDiv) {
              const userMessageId = userMessageDiv.getAttribute('data-message-id') || '';
              const node = userMessageId
                ? chatHistoryManager?.chatHistory?.messages?.find(m => m.id === userMessageId)
                : null;
              const isUser = !!(node && String(node.role || '').toLowerCase() === 'user');
              if (isUser) {
                const hasOtherUserMessage = chatHistoryManager.chatHistory.messages.some(
                  (m) => m && m.id !== node.id && String(m.role || '').toLowerCase() === 'user'
                );
                if (!hasOtherUserMessage) {
                  const url = typeof pageContentResponse?.url === 'string' ? pageContentResponse.url.trim() : '';
                  const title = typeof pageContentResponse?.title === 'string' ? pageContentResponse.title.trim() : '';
                  if (url || title) {
                    const prevUrl = typeof node.pageMeta?.url === 'string' ? node.pageMeta.url.trim() : '';
                    const prevTitle = typeof node.pageMeta?.title === 'string' ? node.pageMeta.title.trim() : '';
                    // 若与之前冻结的快照不一致，则以 pageContentResponse 为准进行校准（它对应“实际用于总结”的页面内容）
                    if (prevUrl !== url || prevTitle !== title) {
                      node.pageMeta = { url, title };
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.warn('补齐首条用户消息 pageMeta 失败（将回退为保存时读取 pageInfo）:', e);
          }
        } else {
          console.error('获取网页内容失败。');
        }
      }
      
      // 更新加载状态：正在构建消息
      updateLoadingStatus(loadingMessage, '正在构建消息...', { stage: 'compose_messages' });

      // 构建消息数组（改为纯函数 composer）
      if (Array.isArray(conversationSnapshot) && conversationSnapshot.length > 0) {
        conversationChain = conversationSnapshot;
      } else if (activeThreadContext) {
        const threadChainOverride = (regenerateMode && messageId) ? messageId : null;
        conversationChain = buildThreadConversationChain(activeThreadContext, threadChainOverride);
      } else {
        conversationChain = getCurrentConversationChain();
      }
      // 解析 api 参数（若提供）。发送层不再做任何策略推断
      if (api != null && typeof apiManager.resolveApiParam === 'function') {
        try { preferredApiConfig = apiManager.resolveApiParam(api); } catch (_) { preferredApiConfig = null; }
      }

      const configForMaxHistory = preferredApiConfig || apiManager.getSelectedConfig();
      const sendChatHistoryFlag = shouldSendChatHistory || forceSendFullHistory;
      const messages = composeMessages({
        prompts: promptsConfig,
        injectedSystemMessages,
        pageContent: pageContentResponse,
        imageContainsScreenshot: !!imageContainsScreenshot,
        currentPromptType,
        regenerateMode,
        messageId,
        conversationChain,
        sendChatHistory: sendChatHistoryFlag,
        // 旧字段：按总条目数裁剪（向后兼容）
        maxHistory: configForMaxHistory?.maxChatHistory ?? 500,
        // 新字段：按角色分别裁剪（超长对话更易控）
        maxUserHistory: configForMaxHistory?.maxChatHistoryUser,
        maxAssistantHistory: configForMaxHistory?.maxChatHistoryAssistant
      });

      // 在真正发给模型前，统一清理所有用户消息末尾的控制标记
      // 包括：[xN] 并行标记 和 [16:9]/[Auto] 等宽高比标记，避免模型看到这些内部控制语法
      const sanitizedMessages = messages.map((msg) => {
        if (msg && msg.role === 'user' && typeof msg.content === 'string') {
          const { baseText } = extractTrailingControlMarkers(msg.content);
          if (baseText !== msg.content) {
            return { ...msg, content: baseText };
          }
        }
        return msg;
      });
      const preprocessedMessages = (shouldApplyPreprocessor && typeof preprocessedMessageText === 'string')
        ? applyPreprocessedTextToMessages(sanitizedMessages, preprocessedMessageText)
        : sanitizedMessages;
      const finalMessages = (shouldApplyPreprocessor && Array.isArray(injectedMessages) && injectedMessages.length > 0)
        ? insertInjectedMessagesAfterLastUser(preprocessedMessages, injectedMessages)
        : preprocessedMessages;

      // 获取API配置：仅使用外部提供（resolvedApiConfig / api 解析）或当前选中。不再做任何内部推断
      let config;
      if (resolvedApiConfig) {
        config = resolvedApiConfig;
      } else if (preferredApiConfig) {
        config = preferredApiConfig;
      } else {
        config = apiManager.getSelectedConfig();
      }
      effectiveApiConfig = config;

      // 添加字数统计元素
      if (!regenerateMode) {
        addContentLengthFooter(userMessageDiv, pageContentLength, config);
      }

      function addContentLengthFooter(userMessageDiv, pageContentLength, config) {
        if (!userMessageDiv) return;
        
        // 创建字数统计元素
        const footer = document.createElement('div');
        footer.classList.add('content-length-footer');
        if (pageContentLength > 0) {
          footer.textContent = `↑ ${pageContentLength.toLocaleString()}`;
        }
        footer.textContent += ` ${config.modelName}`;

        // 添加到用户消息下方
        userMessageDiv.appendChild(footer);
      }

      // 更新加载状态：构造请求载荷（此阶段尚未发起网络请求，可能包含图片编码/自定义参数合并等耗时操作）
      updateLoadingStatus(loadingMessage, '正在构造请求载荷...', { stage: 'build_request_body' });

      // 解析宽高比控制标记（如果存在），用于单次请求级别的图片配置覆盖
      if (!aspectRatioOverride) {
        const aspectInfo = extractTrailingControlMarkers(
          typeof messageText === 'string' ? messageText : ''
        );
        aspectRatioOverride = aspectInfo.aspectRatio;
      }

      /** 构造 API 请求体（可能包含异步图片加载，例如本地文件转 Base64） */
      const requestOverrides = {};
      // 仅在 Gemini 场景下注入宽高比控制，保留 imageSize 由用户配置或后续默认值决定
      if (aspectRatioOverride && config?.baseUrl === 'genai') {
        requestOverrides.generationConfig = {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: aspectRatioOverride
          }
        };
      }

      const requestBody = await apiManager.buildRequest({
        messages: finalMessages,
        config: config,
        overrides: requestOverrides
      });

      // 根据配置选择流式/非流式处理（该判定不依赖 response，可提前计算，用于更准确的状态文案）
      const isGeminiApi = effectiveApiConfig?.baseUrl === 'genai';
      const useStreaming = isGeminiApi
        ? (effectiveApiConfig.useStreaming !== false)
        : !!(requestBody && requestBody.stream);

      // 发送 API 请求（开始网络阶段）
      updateLoadingStatus(loadingMessage, '正在发送请求（上传请求载荷）...', { stage: 'send_request' });
      const response = await apiManager.sendRequest({
        requestBody: requestBody,
        config: effectiveApiConfig,
        signal: signal,
        onStatus: createRequestStatusHandler(loadingMessage)
      });

      if (!response.ok) {
        updateLoadingStatus(
          loadingMessage,
          `服务器返回错误 (HTTP ${response.status})，正在读取错误详情...`,
          { stage: 'read_error_body', httpStatus: response.status, apiBase: effectiveApiConfig?.baseUrl || '', modelName: effectiveApiConfig?.modelName || '' }
        );
        const error = await response.text();
        throw new Error(`API错误 (${response.status}): ${error}`);
      }

      // 响应状态为 ok：此时已收到响应头，接下来进入“等待首 token / 下载完整正文”等阶段
      updateLoadingStatus(
        loadingMessage,
        `已收到响应头 (HTTP ${response.status})，准备接收回复...`,
        { stage: 'response_headers_received', httpStatus: response.status, apiBase: effectiveApiConfig?.baseUrl || '', modelName: effectiveApiConfig?.modelName || '' }
      );

      if (useStreaming) {
        await handleStreamResponse(response, loadingMessage, effectiveApiConfig, attempt);
      } else {
        await handleNonStreamResponse(response, loadingMessage, effectiveApiConfig, attempt);
      }

      // 消息处理完成后，自动保存会话
      if (currentConversationId) {
        await chatHistoryUI.saveCurrentConversation(true); // 更新现有会话记录
      } else {
        await chatHistoryUI.saveCurrentConversation(false); // 新会话，生成新的 conversation id
        // 获取新创建的会话ID并更新本地变量
        currentConversationId = chatHistoryUI.getCurrentConversationId();
      }

      // 首条 AI 回复后尝试生成对话标题（异步，不阻塞主流程）
      const titleConversationId = currentConversationId || chatHistoryUI.getCurrentConversationId();
      if (titleConversationId) {
        void maybeGenerateConversationTitle({
          conversationId: titleConversationId,
          attemptState: attempt,
          regenerateMode
        });
      }

    } catch (error) {
      const isAbortError = error?.name === 'AbortError';
      const wasManualAbort = isAbortError && attempt?.manualAbort;

      if (wasManualAbort) {
        if (loadingMessage && loadingMessage.parentNode) {
          loadingMessage.remove();
        }
        console.log('用户手动停止更新');
        return;
      }

      console.error('发送消息失败:', error);

      // 返回一个可供外部使用的“无状态重试提示”对象
      const canReusePreprocessedText = !skipUserMessagePreprocess
        && shouldApplyPreprocessor
        && !hasInjectedBlocks
        && typeof preprocessedMessageText === 'string';
      const retryOriginalMessageText = canReusePreprocessedText
        ? preprocessedMessageText
        : messageText;
      const skipNextPreprocess = skipUserMessagePreprocess || canReusePreprocessedText;

      const retryHint = {
        injectedSystemMessages: existingInjectedSystemMessages,
        specificPromptType,
        originalMessageText: retryOriginalMessageText,
        regenerateMode: true,
        messageId,
        targetAiMessageId: normalizedTargetAiMessageId,
        forceSendFullHistory,
        pageContentSnapshot: pageContentResponse || null,
        conversationSnapshot: Array.isArray(conversationChain) ? conversationChain : null,
        aspectRatioOverride,
        __skipUserMessagePreprocess: skipNextPreprocess,
        // 透传外部策略决定的API（若有）
        resolvedApiConfig,
        api
      };
      const retry = (delayMs = 0, override = {}) => new Promise((resolve) => {
        setTimeout(async () => {
          // 注意：自动重试直接调用核心发送逻辑，避免再次触发 [xN] 并行拆分
          resolve(await sendMessageCore({ ...retryHint, ...override }));
        }, Math.max(0, delayMs));
      });

      const canAutoRetry = autoRetryEnabled && autoRetryAttempt < (MAX_AUTO_RETRY_ATTEMPTS - 1);
      if (canAutoRetry) {
        if (loadingMessage && loadingMessage.parentNode) {
          loadingMessage.remove();
        }
        const nextAttemptIndex = autoRetryAttempt + 1;
        const delayMs = getAutoRetryDelayMs(autoRetryAttempt);
        if (typeof showNotification === 'function') {
          const delayText = delayMs >= 1000
            ? `${(delayMs / 1000).toFixed(delayMs >= 10000 ? 0 : 1)}秒`
            : `${delayMs}毫秒`;
          // 警告：发送失败，进入自动重试
          showNotification({
            message: `发送失败，将在 ${delayText} 后自动重试 (${nextAttemptIndex}/${MAX_AUTO_RETRY_ATTEMPTS})`,
            type: 'warning'
          });
        }
        return retry(delayMs, { __autoRetryAttempt: nextAttemptIndex });
      }

      const detail = (typeof error?.message === 'string' && error.message.trim().length > 0)
        ? error.message.trim()
        : '发生未知错误';
      const prefix = autoRetryEnabled
        ? `自动重试失败 (${MAX_AUTO_RETRY_ATTEMPTS} 次): `
        : isAbortError
          ? '请求中断: '
          : '发送失败: ';
      const errorMessageText = `${prefix}${detail}`;

      // “原地替换”重新生成：不要在对话末尾追加错误消息，避免污染历史；
      // 这里用轻量通知提示错误即可（目标 AI 消息保留当前内容：可能是旧内容，也可能是已生成的部分新内容）。
      if (canUpdateExistingAiMessage && normalizedTargetAiMessageId) {
        if (typeof showNotification === 'function') {
          showNotification({ message: errorMessageText, type: 'error' });
        }
        if (autoRetryEnabled && typeof showNotification === 'function') {
          // 错误：重试达到上限
          showNotification({ message: '自动重试失败，已达到最大尝试次数', type: 'error' });
        }
        return { ok: false, error, apiConfig: (resolvedApiConfig || preferredApiConfig || apiManager.getSelectedConfig()), retryHint, retry };
      }

      let messageElement = null;
      if (loadingMessage && loadingMessage.parentNode) {
        messageElement = loadingMessage;
        messageElement.textContent = errorMessageText;
      } else {
        const errorUiActive = isThreadUiActive(activeThreadContext);
        const errorOptions = activeThreadContext
          ? { container: activeThreadContext.container, skipDom: !errorUiActive }
          : null;
        messageElement = messageProcessor.appendMessage(errorMessageText, 'ai', true, null, null, null, null, null, errorOptions);
      }

      if (messageElement) {
        messageElement.classList.add('error-message');
        messageElement.classList.remove('loading-message');
        messageElement.classList.remove('updating');
        const errorScrollContainer = activeThreadContext
          ? resolveThreadUiContainer(activeThreadContext)
          : chatContainer;
        if (errorScrollContainer) {
          scrollToBottom(errorScrollContainer);
        }
      }

      if (autoRetryEnabled && typeof showNotification === 'function') {
        // 错误：重试达到上限
        showNotification({ message: '自动重试失败，已达到最大尝试次数', type: 'error' });
      }

      return { ok: false, error, apiConfig: (resolvedApiConfig || preferredApiConfig || apiManager.getSelectedConfig()), retryHint, retry };
    } finally {
      finalizeAttempt(attempt);
    }
    // 成功：返回 ok 与实际使用的 api 配置（供外部记录/重试）
    return { ok: true, apiConfig: (resolvedApiConfig || preferredApiConfig || apiManager.getSelectedConfig()) };
  }

  /**
   * 使用外部解析好的 API 配置发送（完全绕过内部 API 选择策略）
   * @param {Object} params
   * @param {Object} params.apiConfig - 已解析好的 API 配置
   * @param {Array<string>} [params.injectedSystemMessages]
   * @param {string} [params.specificPromptType]
   * @param {string} [params.originalMessageText]
   * @param {boolean} [params.regenerateMode]
   * @param {string} [params.messageId]
   * @param {boolean} [params.forceSendFullHistory]
   * @returns {Promise<void>}
   */
  async function sendWithApiConfig(params) {
    if (!params || !params.apiConfig) {
      console.error('sendWithApiConfig: 缺少 apiConfig');
      return;
    }
    const { apiConfig, ...rest } = params;
    return sendMessage({ ...rest, resolvedApiConfig: apiConfig });
  }

  /**
   * 支持从消息末尾解析控制标记：
   * - [xN]  并行次数
   * - [16:9] / [Auto] 等图片宽高比
   *
   * 解析策略：
   * - 从文本末尾开始，循环吃掉形如 "[...]" 的标记；
   * - 顺序无关，直到遇到无法识别的标记为止；
   * - 返回去掉所有已识别标记后的文本、并行次数与宽高比。
   *
   * @param {string} text
   * @returns {{ baseText: string, parallelCount: number, aspectRatio: string|null }}
   */
  function extractTrailingControlMarkers(text) {
    let raw = (text || '').trimEnd();
    const MAX_PARALLEL_COUNT = 10;
    /** 支持的宽高比（大小写不敏感） */
    const SUPPORTED_RATIOS = [
      'Auto',
      '1:1', '9:16', '16:9',
      '3:4', '4:3',
      '3:2', '2:3',
      '5:4', '4:5',
      '21:9'
    ];

    let parallelCount = null;
    let aspectRatio = null;

    while (true) {
      const match = raw.match(/\[([^\]]+)\]\s*$/i);
      if (!match) break;

      const token = match[1].trim();
      const lower = token.toLowerCase();
      let consumed = false;

      // 1) [xN] 并行标记
      const mX = /^x(\d+)$/.exec(lower);
      if (mX && parallelCount == null) {
        let n = parseInt(mX[1], 10);
        if (Number.isFinite(n) && n >= 2) {
          if (n > MAX_PARALLEL_COUNT) n = MAX_PARALLEL_COUNT;
          parallelCount = n;
        }
        consumed = true;
      } else if (aspectRatio == null) {
        // 2) 宽高比标记（Auto / 16:9 / 1:1 等）
        const found = SUPPORTED_RATIOS.find(
          (r) => r.toLowerCase() === lower
        );
        if (found) {
          aspectRatio = found; // 使用白名单里的规范写法
          consumed = true;
        }
      }

      if (!consumed) {
        // 遇到未知标记，停止继续向前吃，避免误删用户自定义 [xxx]
        break;
      }

      raw = raw.slice(0, match.index).trimEnd();
    }

    return {
      baseText: raw,
      parallelCount: parallelCount || 1,
      aspectRatio: aspectRatio || null
    };
  }

  /**
   * 仅解析并行标记 [xN]，保持向后兼容旧接口。
   * @param {string} text
   * @returns {{ baseText: string, parallelCount: number }}
   */
  function parseParallelMultiplier(text) {
    const info = extractTrailingControlMarkers(text);
    return {
      baseText: info.baseText,
      parallelCount: info.parallelCount,
      aspectRatio: info.aspectRatio
    };
  }

  /**
   * 对外暴露的发送接口：
   * - 负责解析用户输入中的 [xN] 并行生成语法；
   * - 根据是否为重新生成模式，调度多路 sendMessageCore 并行执行；
   * - 自动确保用户消息只插入一次，其余视作对同一用户消息的“并行重新生成”。
   *
   * @public
   * @param {Object} [options] - 参见 sendMessageCore 的参数说明
   * @returns {Promise<any>} - 单路时返回 sendMessageCore 的结果；并行时返回 Promise.allSettled 的结果数组
   */
  async function sendMessage(options = {}) {
    const opts = options || {};

    // 应用层有时会显式跳过并行解析（例如自动重试），此时直接走核心逻辑
    if (opts.__skipParallelExpansion) {
      const { __skipParallelExpansion, ...rest } = opts;
      return sendMessageCore(rest);
    }

    // 推断本次要使用的原始文本：
    // - 重新生成模式优先读取被重新生成的用户消息当前文本（data-original-text）；
    // - 否则优先使用调用方传入的 originalMessageText；
    // - 最后回退到输入框中的内容。
    let rawText = '';

    if (opts.regenerateMode && opts.messageId) {
      try {
        const safeMessageId = escapeMessageIdForSelector(opts.messageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const targetEl = selector ? chatContainer.querySelector(selector) : null;
        const fromDom = targetEl?.getAttribute('data-original-text');
        if (typeof fromDom === 'string' && fromDom.length > 0) {
          rawText = fromDom;
        } else if (chatHistoryManager?.chatHistory?.messages) {
          const node = chatHistoryManager.chatHistory.messages.find(m => m.id === opts.messageId);
          if (node && typeof node.content === 'string') {
            rawText = node.content;
          }
        }
      } catch (e) {
        console.warn('从历史中读取用于并行解析的消息文本失败，将回退到 originalMessageText:', e);
      }
    }

    if (!rawText) {
      if (opts.originalMessageText !== null && opts.originalMessageText !== undefined) {
        rawText = String(opts.originalMessageText);
      } else {
        try {
          rawText = inputController ? inputController.getInputText() : (messageInput.textContent || '');
        } catch (e) {
          console.warn('读取输入文本失败，将按空文本处理:', e);
          rawText = '';
        }
      }
    }

    let { baseText, parallelCount, aspectRatio } = parseParallelMultiplier(rawText);

    // “原地替换指定 AI 消息”不支持并行生成：
    // - 并行会导致多路流式更新互相覆盖同一条消息，结果不可控；
    // - 因此一旦指定 targetAiMessageId，强制退回为单路执行。
    if (typeof opts.targetAiMessageId === 'string' && opts.targetAiMessageId.trim()) {
      parallelCount = 1;
    }

    // 兜底：如果当前原始文本中未检测到 [xN]，再尝试从最后一条用户消息中解析一次
    // 这样可以覆盖一些边缘情况，例如重新生成时上下文传入的 originalMessageText 未及时更新等。
    if (parallelCount <= 1) {
      try {
        const userMessages = chatContainer.querySelectorAll('.user-message');
        if (userMessages.length > 0) {
          const lastUser = userMessages[userMessages.length - 1];
          const lastUserText =
            lastUser.getAttribute('data-original-text') ||
            lastUser.textContent ||
            '';
          const parsedLast = parseParallelMultiplier(lastUserText);
          if (parsedLast.parallelCount > 1) {
            baseText = parsedLast.baseText;
            parallelCount = parsedLast.parallelCount;
            aspectRatio = aspectRatio || parsedLast.aspectRatio || null;
          }
        }
      } catch (e) {
        console.warn('从最后一条用户消息解析并行标记失败:', e);
      }
    }
    const hasImagesInInput = inputController
      ? inputController.hasImages()
      : !!imageContainer.querySelector('.image-tag');

    // 无并行标记或空消息场景：直接走单路核心逻辑（这里仍会沿用去掉 [xN] 后的 baseText）
    const isEmptyMessage = !baseText && !hasImagesInInput && !opts.forceSendFullHistory && !opts.regenerateMode;
    if (parallelCount <= 1 || isEmptyMessage) {
      const singleOpts = { ...opts };
      // 如果原始文本来自输入框或调用方，我们用去掉 [xN] 的文本覆盖 originalMessageText
      if (baseText !== rawText) {
        singleOpts.originalMessageText = baseText;
      }
      if (aspectRatio) {
        singleOpts.aspectRatioOverride = aspectRatio;
      }
      return sendMessageCore(singleOpts);
    }

    // 并行生成：根据上下文选择不同策略
    const tasks = [];

    if (opts.regenerateMode) {
      // 场景一：对已有用户消息的“编辑后重新生成”（包括 Ctrl+Enter）
      // - 此时 messageId 为用户消息 ID；
      // - 直接对同一消息发起多路重新生成即可。
      for (let i = 0; i < parallelCount; i += 1) {
        const taskOptions = {
          ...opts,
          originalMessageText: baseText,
          regenerateMode: true,
          aspectRatioOverride: aspectRatio || undefined
        };
        tasks.push(sendMessageCore(taskOptions));
      }
      return Promise.allSettled(tasks);
    }

    // 场景二：普通发送（从输入框发送一条新用户消息，末尾带 [xN]）
    // 第一步：启动第一路核心请求，让它负责插入用户消息与第一条 AI 回复
    const firstOptions = {
      ...opts,
      originalMessageText: baseText,
      aspectRatioOverride: aspectRatio || undefined
    };
    const firstPromise = sendMessageCore(firstOptions);
    tasks.push(firstPromise);

    // 由于 sendMessageCore 在首次 await 之前会同步插入用户消息，
    // 此处可以立即通过 chatHistoryManager 获取“当前最后一条用户消息”的 ID。
    let baseUserMessageId = null;
    try {
      const history = chatHistoryManager.chatHistory;
      const currentId = history?.currentNode;
      const currentNode = history?.messages?.find(m => m.id === currentId);
      if (currentNode && currentNode.role === 'user') {
        baseUserMessageId = currentNode.id;
      } else if (Array.isArray(history?.messages)) {
        // 回退：从末尾向前查找最后一条用户消息
        const reversed = history.messages.slice().reverse();
        const lastUser = reversed.find(m => m.role === 'user');
        baseUserMessageId = lastUser ? lastUser.id : null;
      }
    } catch (e) {
      console.warn('解析并行生成的基准用户消息失败，将退回为单路生成:', e);
      baseUserMessageId = null;
    }

    if (!baseUserMessageId) {
      // 找不到基准用户消息时，保守地只保留第一路请求，避免插入多条重复用户消息
      return firstPromise;
    }

    // 第二步：为其余 (parallelCount - 1) 路生成发起“对同一用户消息的重新生成”
    for (let i = 1; i < parallelCount; i += 1) {
      const extraOptions = {
        ...opts,
        originalMessageText: baseText,
        regenerateMode: true,
        messageId: baseUserMessageId,
        aspectRatioOverride: aspectRatio || undefined
      };
      tasks.push(sendMessageCore(extraOptions));
    }

    return Promise.allSettled(tasks);
  }

  // 消息构造逻辑已迁移到 message_composer.js 的纯函数 composeMessages

  /**
   * 处理API的流式响应（单路）
   * @private
   * @param {Response} response - Fetch API 响应对象
   * @param {HTMLElement} loadingMessage - 加载状态消息元素
   * @param {Object} usedApiConfig - 本次使用的 API 配置
   * @param {{id:string, aiMessageId?:string}|null} attemptState - 当前请求的 attempt 状态对象
   * @returns {Promise<void>}
   */
  async function handleStreamResponse(response, loadingMessage, usedApiConfig, attemptState) {
    // 流式场景：此时已拿到响应头，但正文 token 尚未到达。
    // 在首个 token 到达前维持占位消息，并展示“等待首 token”的细粒度状态。
    updateLoadingStatus(
      loadingMessage,
      '已建立流式连接，等待首个 token...',
      { stage: 'stream_wait_first_token', apiBase: usedApiConfig?.baseUrl || '', modelName: usedApiConfig?.modelName || '' }
    );

    const threadContext = attemptState?.threadContext || null;
    const getUiContainer = () => {
      if (threadContext) return resolveThreadUiContainer(threadContext);
      return chatContainer;
    };

    function applyApiMetaToMessage(messageId, apiConfig, messageDiv) {
      try {
        if (!messageId) return;
        const node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageId);
        if (node) {
          node.apiUuid = apiConfig?.id || null;
          node.apiDisplayName = apiConfig?.displayName || '';
          node.apiModelId = apiConfig?.modelName || '';
        }
        const safeMessageId = escapeMessageIdForSelector(messageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const fallbackEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
          : null;
        renderApiFooter(messageDiv || fallbackEl, node);
      } catch (e) {
        console.warn('记录/渲染API信息失败:', e);
      }
    }

    function renderApiFooter(messageElement, nodeLike) {
      try {
        if (!messageElement || !nodeLike) return;
        let footer = messageElement.querySelector('.api-footer');
        if (!footer) {
          footer = document.createElement('div');
          footer.classList.add('api-footer');
          messageElement.appendChild(footer);
        }
        const allConfigs = (apiManager.getAllConfigs && apiManager.getAllConfigs()) || [];
        let label = '';
        let matchedConfig = null;
        if (nodeLike.apiUuid) {
          matchedConfig = allConfigs.find(c => c.id === nodeLike.apiUuid) || null;
        }
        if (!label && matchedConfig && typeof matchedConfig.displayName === 'string' && matchedConfig.displayName.trim()) {
          label = matchedConfig.displayName.trim();
        }
        if (!label && matchedConfig && typeof matchedConfig.modelName === 'string' && matchedConfig.modelName.trim()) {
          label = matchedConfig.modelName.trim();
        }
        if (!label) label = (nodeLike.apiDisplayName || '').trim();
        if (!label) label = (nodeLike.apiModelId || '').trim();
        const hasThoughtSignature = !!nodeLike.thoughtSignature;

        // footer：带 Thought Signature 的消息使用 "signatured · 模型名" 文本标记
        let displayLabel = label || '';
        if (hasThoughtSignature) {
          displayLabel = label ? `signatured · ${label}` : 'signatured';
        }
        footer.textContent = displayLabel;

        const titleDisplayName = matchedConfig?.displayName || nodeLike.apiDisplayName || '-';
        const titleModelId = matchedConfig?.modelName || nodeLike.apiModelId || '-';
        const thoughtFlag = hasThoughtSignature ? ' | thought_signature: stored' : '';
        footer.title = `API uuid: ${nodeLike.apiUuid || '-'} | displayName: ${titleDisplayName} | model: ${titleModelId}${thoughtFlag}`;
      } catch (e) {
        console.warn('渲染API footer失败:', e);
      }
    }
    const reader = response.body.getReader();
    let hasStartedResponse = false;
    // 累积 AI 的主回答文本（仅文本部分，包含代码块、内联图片等 Markdown/HTML 内容）
    let aiResponse = '';
    // 累积当前流中的思考过程文本（Gemini / OpenAI reasoning）
    let aiThoughtsRaw = '';
    // 每次流式请求开始时重置思考块状态
    isInStreamingThoughtBlock = false;
    // 标记是否为 Gemini 流式接口
    const isGeminiApi = response.url.includes('generativelanguage.googleapis.com') && !response.url.includes('openai');
    // SSE 行缓冲
    let incomingDataBuffer = ''; 
    const decoder = new TextDecoder();
    let currentEventDataLines = []; // 当前事件中的所有 data: 行内容
	    // 记录当前流式响应中最新的 Gemini 思维链签名（Thought Signature）
	    let latestGeminiThoughtSignature = null;

	    // OpenAI 兼容：记录当前流式响应中最新的推理签名（thoughtSignature）。
	    //
	    // 背景：
	    // - 某些 OpenAI 兼容服务会在 SSE chunk 的 `choices[0].delta` 上透传 `thoughtSignature`；
	    // - 该签名用于校验/回传 `reasoning_content`（以及 tool_calls 片段），否则上游可能报 “signature required”；
	    //
	    // 约定：
	    // - `delta.thoughtSignature`：对应 `delta.reasoning_content`（或 `delta.reasoning`）的签名；
	    // - `delta.tool_calls[i].thoughtSignature`：对应工具调用片段的签名；
	    //
	    // 注意：签名必须“原样保存、原样回传”，不要做 trim/格式化。
	    let latestOpenAIThoughtSignature = null;
	    // OpenAI 兼容：累积原始 reasoning_content（用于与 thoughtSignature 配对回传）
	    let latestOpenAIReasoningContent = '';
	    // OpenAI 兼容：累积 tool_calls（流式增量会把 function.arguments 分片输出）
	    let latestOpenAIToolCalls = [];
		    // 当前流对应的 AI 消息 ID：
		    // - 普通发送：首个 token 到达时新建消息并赋值；
		    // - “原地替换”重新生成：sendMessageCore 会预先把 attempt.aiMessageId 设为目标消息ID，这里直接复用。
		    let currentAiMessageId = attemptState?.aiMessageId || null;
		    // 重新生成（原地替换）：只在“首次写回”时清一次，避免后续 token 更新中重复清空
		    let hasClearedBoundSignatureForRegenerate = false;

	    // 自适应 UI 更新节流器：将多个 token 的高频更新合并为较低频的 DOM 刷新，缓解长消息渲染导致的卡顿。
	    // 说明：这里不改 messageProcessor.updateAIMessage 的“全量重渲染”策略，而是通过“掉帧合并”降低调用频率。
	    const uiUpdateThrottler = createAdaptiveUpdateThrottler({
	      run: (payload) => {
	        if (!payload || !payload.messageId) return;
	        const regenContainer = getUiContainer();
	        const anchor = regenContainer
	          ? captureReadingAnchorForRegenerate(regenContainer, payload.messageId, attemptState)
	          : null;
	        try {
	          messageProcessor.updateAIMessage(
	            payload.messageId,
	            payload.answer || '',
	            payload.thoughts || '',
	            payload.groundingMetadata
	          );
	        } finally {
	          if (regenContainer) {
	            restoreReadingAnchor(regenContainer, anchor);
	          }
	        }
	      },
	      shouldCancel: () => {
	        try { return !!(attemptState?.controller?.signal?.aborted || attemptState?.finished); } catch (_) { return false; }
	      },
	      getContentSize: (payload) => {
	        const answerSize = (typeof payload?.answer === 'string') ? payload.answer.length : 0;
	        const thoughtsSize = (typeof payload?.thoughts === 'string') ? payload.thoughts.length : 0;
	        return answerSize + thoughtsSize;
	      }
	    });
	    if (attemptState) {
	      attemptState.uiUpdateThrottler = uiUpdateThrottler;
	    }

	    // 记录“正文是否已出现过”：用于在“先输出思考、后输出正文”的模型上，让正文首次出现时更快落地到 UI。
	    let hasEverShownAnswerContent = false;

	    while (true) {
	      const { done, value } = await reader.read();
	      if (done) {
        // 处理缓冲区中最后一行未以换行结尾的数据
        if (incomingDataBuffer.length > 0) {
          await processLine(incomingDataBuffer);
          incomingDataBuffer = '';
        }
        // 如果还有未处理完的事件行，作为最后一个事件再处理一次
        if (currentEventDataLines.length > 0) {
          await processEvent();
        }
	        break;
	      }

      incomingDataBuffer += decoder.decode(value, { stream: true });

      let lineEndIndex;
      while ((lineEndIndex = incomingDataBuffer.indexOf('\n')) >= 0) {
        const line = incomingDataBuffer.substring(0, lineEndIndex);
        incomingDataBuffer = incomingDataBuffer.substring(lineEndIndex + 1);
	        await processLine(line);
	      }
	    }

	    // 流式响应结束：强制刷新最后一帧，避免尾部 token 被节流合并后未能落到 UI。
	    try { uiUpdateThrottler.flush({ force: true }); } catch (_) {}

		    // 流式响应结束后，将“签名/推理元信息”写入当前 AI 消息节点，并刷新 footer 标记
		    // - Gemini：Thought Signature（part-level thought_signature）
		    // - OpenAI 兼容：thoughtSignature（message-level thoughtSignature + reasoning_content/tool_calls）
		    if (currentAiMessageId && (latestGeminiThoughtSignature || latestOpenAIThoughtSignature || (Array.isArray(latestOpenAIToolCalls) && latestOpenAIToolCalls.length > 0))) {
		      try {
	        const node = chatHistoryManager.chatHistory.messages.find(m => m.id === currentAiMessageId);
	        if (node) {
	          if (isGeminiApi && latestGeminiThoughtSignature) {
	            // Gemini：在历史节点上记录 Thought Signature，供后续多轮对话回传使用
	            node.thoughtSignature = latestGeminiThoughtSignature;
	            node.thoughtSignatureSource = 'gemini';
	          }

	          if (!isGeminiApi) {
	            // OpenAI 兼容：推理签名与推理原文、tool_calls 原样落库，供后续历史消息回传
	            if (latestOpenAIThoughtSignature) {
	              node.thoughtSignature = latestOpenAIThoughtSignature;
	              node.thoughtSignatureSource = 'openai';
	            } else if (Array.isArray(latestOpenAIToolCalls) && latestOpenAIToolCalls.length > 0) {
	              // 仅有 tool_calls 签名/结构时，也标记来源，避免后续误发给 Gemini
	              if (!node.thoughtSignatureSource) node.thoughtSignatureSource = 'openai';
	            }

	            if (typeof latestOpenAIReasoningContent === 'string' && latestOpenAIReasoningContent) {
	              // 与 OpenAI 兼容字段保持一致：使用 reasoning_content 命名，便于 buildRequest 直接透传
	              node.reasoning_content = latestOpenAIReasoningContent;
	            }

	            if (Array.isArray(latestOpenAIToolCalls) && latestOpenAIToolCalls.length > 0) {
	              node.tool_calls = latestOpenAIToolCalls;
	            }
	          }

          const safeMessageId = escapeMessageIdForSelector(currentAiMessageId);
          const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
          const el = selector
            ? (chatContainer.querySelector(selector)
              || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
            : null;
	          if (el) {
	            renderApiFooter(el, node);
	          }
	        }
	      } catch (e) {
	        console.warn('记录签名/推理元信息失败（流式）:', e);
	      }
	    }

    async function processLine(line) {
      // Trim the line to handle potential CR characters as well (e.g. '\r\n')
      const trimmedLine = line.trim();

      if (trimmedLine === '') { // Empty line: dispatch event
        if (currentEventDataLines.length > 0) {
          await processEvent();
        }
      } else if (trimmedLine.startsWith('data:')) {
        // Add content after "data:" (and optional single space) to current event's data lines
        currentEventDataLines.push(trimmedLine.substring(5).trimStart()); 
      } 
      // Ignoring event:, id:, : (comments) as they are not used by current response structures
    }

    async function processEvent() {
      // 将当前事件的多行 data 合并为一个 JSON 字符串
      const fullEventData = currentEventDataLines.join('\n'); 
      currentEventDataLines = []; // 重置，准备下一个事件

      if (fullEventData.trim() === '') return; // 空事件直接跳过

	      // OpenAI 特有的 [DONE] 结束标记
	      if (!isGeminiApi && fullEventData.trim() === '[DONE]') {
	        // 结束标记到达时，尽量立刻落一次最终 UI，避免连接迟迟不关闭导致的“最后几 token 不显示”。
	        try { uiUpdateThrottler.flush({ force: true }); } catch (_) {}
	        return;
	      }

      try {
        const jsonData = JSON.parse(fullEventData);
        if (isGeminiApi) {
          await handleGeminiEvent(jsonData);
        } else {
          handleOpenAIEvent(jsonData);
        }
      } catch (e) {
        console.error('解析SSE事件JSON出错:', e, 'Event data:', `'${fullEventData}'`);
        // 将错误抛出到上层，让 sendMessage 的 catch 将错误展示到 UI
        throw e;
      }
    }

    /**
     * 处理 Gemini SSE 事件（包括文本、思考过程、代码执行与图片）
     * @param {Object} data - 从SSE事件中解析出的JSON对象
     */
    async function handleGeminiEvent(data) {
      if (data.error) {
        const errorMessage = data.error.message || 'Unknown Gemini error';
        console.error('Gemini API error:', data.error);
        // 不要移除 loadingMessage，让上层的 catch 块来处理错误显示
        throw new Error(errorMessage);
      }

      // 处理 Gemini 里那类「HTTP 200 但因安全策略被拦截」的特殊情况
      // 流式场景下，如果之前尚未输出任何正文，并且当前事件命中安全拦截，则视为“200 返回错误”，交给自动重试
      const safetyBlock = detectGeminiSafetyBlock(data, {
        hasExistingContent: !!(aiResponse && aiResponse.trim())
      });
      if (safetyBlock && safetyBlock.blocked) {
        console.warn('Gemini 响应被安全策略拦截（流式，HTTP 200）:', safetyBlock.message);
        throw new Error(safetyBlock.message);
      }

      // 本事件的增量内容
      let currentEventAnswerDelta = '';
      let currentEventThoughtsDelta = '';
      let groundingMetadata = null;
      const newInlineImages = [];

      if (data.candidates && data.candidates.length > 0) {
        const candidate = data.candidates[0];
        if (candidate.content && Array.isArray(candidate.content.parts)) {
          for (const part of candidate.content.parts) {
            // 0) 捕获 Gemini 3 思维链签名（Thought Signature）：可能出现在最后一个 part，或仅包含签名的空文本 part
            let extractedSignature = null;
            if (typeof part.thought_signature === 'string' && part.thought_signature) {
              extractedSignature = part.thought_signature;
            } else if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
              // 兼容驼峰命名的 thoughtSignature
              extractedSignature = part.thoughtSignature;
            } else {
              const extraContent = part.extra_content || part.extraContent;
              const googleMeta = extraContent && (extraContent.google || extraContent.Google);
              if (googleMeta) {
                if (typeof googleMeta.thought_signature === 'string' && googleMeta.thought_signature) {
                  extractedSignature = googleMeta.thought_signature;
                } else if (typeof googleMeta.thoughtSignature === 'string' && googleMeta.thoughtSignature) {
                  extractedSignature = googleMeta.thoughtSignature;
                }
              }
            }
            if (extractedSignature) {
              latestGeminiThoughtSignature = extractedSignature;
            }

            // 1) 普通文本与思考过程
            if (typeof part.text === 'string') {
              const split = splitDeltaByThinkTags(part.text, !!part.thought);
              currentEventAnswerDelta += split.answerDelta;
              currentEventThoughtsDelta += split.thoughtDelta;
              continue;
            }

            // 2) 可执行代码块 - 转为 Markdown 代码块
            if (part.executableCode && typeof part.executableCode.code === 'string') {
              const lang = (part.executableCode.language || 'python').toString().toLowerCase();
              const code = part.executableCode.code;
              currentEventAnswerDelta += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
              continue;
            }

            // 3) 代码执行结果 - 以代码块形式展示
            if (part.codeExecutionResult && typeof part.codeExecutionResult.output === 'string') {
              const outcome = part.codeExecutionResult.outcome || '';
              const outcomeLabel = outcome ? ` (${outcome})` : '';
              const output = part.codeExecutionResult.output;
              currentEventAnswerDelta += `\n\`\`\`text\n# 代码执行结果${outcomeLabel}\n${output}\n\`\`\`\n`;
              continue;
            }

            // 4) 内联图片数据 - 记录待保存的信息，稍后统一下载为本地文件
            const inline = part.inlineData || part.inline_data;
            if (inline && inline.mimeType && inline.data) {
              if (String(inline.mimeType).startsWith('image/')) {
                newInlineImages.push({
                  mimeType: inline.mimeType,
                  base64Data: inline.data
                });
              }
            }
          }
        }
        groundingMetadata = candidate.groundingMetadata;
      }

      // 将本事件中的图片转为内联 img 元素，直接插入到答案增量中
      if (newInlineImages.length > 0) {
        // 对每张图片优先尝试保存为本地文件，失败则回退为 dataURL
        const resolvedUrls = await Promise.all(
          newInlineImages.map(async (img) => {
            const fileUrl = await saveInlineImageToLocalFile(img.mimeType, img.base64Data);
            if (fileUrl) return fileUrl;
            return `data:${img.mimeType};base64,${img.base64Data}`;
          })
        );

        const inlineHtmlChunks = resolvedUrls.map((url) => {
          const safeUrl = (url || '').replace(/"/g, '&quot;');
          const title = '模型生成图片';
          const safeTitle = title.replace(/"/g, '&quot;');
          return `\n<img class="ai-inline-image" src="${safeUrl}" alt="${safeTitle}" />\n`;
        });
        currentEventAnswerDelta += inlineHtmlChunks.join('');
      }

      const hasTextDelta = !!(currentEventAnswerDelta || currentEventThoughtsDelta);

      // 没有任何可见增量内容时直接返回
      if (!hasTextDelta) return;

      // 累积主回答与思考过程
      aiResponse += currentEventAnswerDelta;
      // 思考过程可能是“流式增量”输出：这里必须按增量拼接，避免每个分片都被插入段落分隔导致渲染成大量 <p>。
      aiThoughtsRaw = mergeStreamingThoughts(aiThoughtsRaw, currentEventThoughtsDelta);
      const thinkExtraction = extractThinkingFromText(aiResponse);
      aiResponse = thinkExtraction.cleanText;
      // 注意：在流式场景中，换行/缩进可能以“分片边界的空白字符”出现。
      // mergeThoughts() 内部会对 existing 做 trim()，若在这里每帧都调用，会把这些空白误删，导致换行丢失。
      // 因此仅在确实提取到了新的 <think> 段落时才合并，避免对流式思考内容做多余的预处理。
      if (thinkExtraction.thoughtText) {
        aiThoughtsRaw = mergeThoughts(aiThoughtsRaw, thinkExtraction.thoughtText);
      }

	      const nowHasAnswerContent = (typeof aiResponse === 'string') && aiResponse.trim() !== '';
	      if (!hasStartedResponse) {
	        // 首次收到内容（文本或图片）：移除“正在处理...”提示
	        if (loadingMessage && loadingMessage.parentNode) loadingMessage.remove();
	        hasStartedResponse = true;
	        try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}

	        if (currentAiMessageId) {
	          // 原地替换：首帧直接更新到既有 AI 消息上（不创建新节点）
	          const regenContainer = getUiContainer();
	          const anchor = regenContainer
	            ? captureReadingAnchorForRegenerate(regenContainer, currentAiMessageId, attemptState)
	            : null;
	          try {
	            messageProcessor.updateAIMessage(
	              currentAiMessageId,
	              aiResponse,
	              aiThoughtsRaw,
	              groundingMetadata
	            );
	            if (!hasClearedBoundSignatureForRegenerate) {
	              hasClearedBoundSignatureForRegenerate = clearBoundSignatureForRegenerate(currentAiMessageId, attemptState);
	            }
	            applyApiMetaToMessage(currentAiMessageId, usedApiConfig);
	          } catch (e) {
	            console.warn('原地替换 AI 消息失败，将回退为追加新消息:', e);
	            currentAiMessageId = null;
	          } finally {
	            if (regenContainer) {
	              restoreReadingAnchor(regenContainer, anchor);
	            }
	          }
	        }

        if (!currentAiMessageId) {
          const threadHistoryPatch = buildThreadHistoryPatch(threadContext);
          const historyParentId = threadContext
            ? (threadContext.parentMessageIdForAi
              || threadContext.lastMessageId
              || threadContext.rootMessageId
              || threadContext.anchorMessageId)
            : null;
          const shouldRenderDom = !threadContext || isThreadUiActive(threadContext);
          if (threadContext && !shouldRenderDom) {
            const createdNode = createThreadAiMessageHistoryOnly({
              content: aiResponse,
              thoughts: aiThoughtsRaw,
              historyParentId,
              historyPatch: threadHistoryPatch
            });
            if (createdNode) {
              currentAiMessageId = createdNode.id;
              if (attemptState) {
                attemptState.aiMessageId = currentAiMessageId;
              }
              applyApiMetaToMessage(currentAiMessageId, usedApiConfig);
              updateThreadLastMessage(threadContext, currentAiMessageId);
            }
          } else {
            const threadOptions = threadContext
              ? {
                  container: threadContext.container,
                  historyParentId,
                  preserveCurrentNode: true,
                  historyPatch: threadHistoryPatch
                }
              : null;
            const newAiMessageDiv = messageProcessor.appendMessage(
              aiResponse,      // 初始完整回答文本
              'ai',
              false,           // skipHistory = false, 创建历史节点
              null,            // fragment = null
              null,            // inline 模式下不再单独传入图片HTML
              aiThoughtsRaw,   // 初始思考过程
              null,            // messageIdToUpdate = null
              null,
              threadOptions
            );

            if (newAiMessageDiv) {
              currentAiMessageId = newAiMessageDiv.getAttribute('data-message-id');
              // 将本次 AI 消息与 attempt 绑定，便于按消息粒度中止/清理
              if (attemptState) {
                attemptState.aiMessageId = currentAiMessageId;
              }
              // 记录 API 元信息并渲染 footer
              applyApiMetaToMessage(currentAiMessageId, usedApiConfig, newAiMessageDiv);
              updateThreadLastMessage(threadContext, currentAiMessageId);
            }
          }
          const scrollContainer = getUiContainer();
          if (scrollContainer) {
            scrollToBottom(scrollContainer);
          }
        }

	        // 记录“正文已出现”：若首帧只包含思考过程，则保持 false，待正文首次出现时强制刷新一次 UI。
	        hasEverShownAnswerContent = nowHasAnswerContent;
	      } else if (currentAiMessageId) {
	        // 后续事件：直接更新完整文本与思考过程（图片已被转为内联HTML）
	        const forceUiUpdate = nowHasAnswerContent && !hasEverShownAnswerContent;
	        if (forceUiUpdate) {
	          // 正文首次出现：优先让 UI 立刻落地（同时触发思考框自动折叠），避免“正文已开始但仍只看到思考”的错觉。
	          hasEverShownAnswerContent = true;
	        }

	        uiUpdateThrottler.enqueue(
	          {
	            messageId: currentAiMessageId,
	            answer: aiResponse,
	            thoughts: aiThoughtsRaw,
	            groundingMetadata
	          },
	          { force: forceUiUpdate }
	        );
	        // scrollToBottom() 在 updateAIMessage 内部调用
	      }
    }

    /**
     * 处理与OpenAI兼容的API的SSE事件
     * @param {Object} data - 从SSE事件中解析出的JSON对象
     */
	    function mergeOpenAIToolCallsDelta(existingCalls, deltaCalls) {
	      const existing = Array.isArray(existingCalls) ? existingCalls : [];
	      const deltas = Array.isArray(deltaCalls) ? deltaCalls : [];
	      if (deltas.length === 0) return existing;

	      // 深拷贝一层，避免在高频流式更新中意外共享引用导致历史节点被“半成品”污染
	      const nextCalls = existing.map((c) => {
	        if (!c || typeof c !== 'object') return c;
	        const cloned = { ...c };
	        if (c.function && typeof c.function === 'object') {
	          cloned.function = { ...c.function };
	        }
	        return cloned;
	      });

	      for (const delta of deltas) {
	        if (!delta || typeof delta !== 'object') continue;
	        const idx = Number.isInteger(delta.index) ? delta.index : nextCalls.length;
	        while (nextCalls.length <= idx) {
	          nextCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
	        }

	        const current = nextCalls[idx] && typeof nextCalls[idx] === 'object' ? nextCalls[idx] : {};
	        const merged = { ...current };

	        if (typeof delta.id === 'string' && delta.id) merged.id = delta.id;
	        if (typeof delta.type === 'string' && delta.type) merged.type = delta.type;

	        // 工具调用片段的签名（某些代理会要求回传）
	        const toolThoughtSignature =
	          (typeof delta.thoughtSignature === 'string' && delta.thoughtSignature) ||
	          (typeof delta.thought_signature === 'string' && delta.thought_signature) ||
	          null;
	        if (toolThoughtSignature) merged.thoughtSignature = toolThoughtSignature;

	        if (delta.function && typeof delta.function === 'object') {
	          const mergedFn = (merged.function && typeof merged.function === 'object')
	            ? { ...merged.function }
	            : {};

	          if (typeof delta.function.name === 'string' && delta.function.name) {
	            mergedFn.name = delta.function.name;
	          }

	          if (typeof delta.function.arguments === 'string' && delta.function.arguments) {
	            const prevArgs = (typeof mergedFn.arguments === 'string') ? mergedFn.arguments : '';
	            // arguments 是流式分片输出：使用 mergeStreamingThoughts 的“去重拼接”策略做通用合并
	            mergedFn.arguments = mergeStreamingThoughts(prevArgs, delta.function.arguments);
	          }

	          merged.function = mergedFn;
	        }

	        nextCalls[idx] = merged;
	      }

	      return nextCalls;
	    }

	    function handleOpenAIEvent(data) {
	      // 检查API返回的错误信息
	      if (data.error) {
          const msg = data.error.message || 'Unknown OpenAI error';
          console.error('OpenAI API error:', data.error);
          // 不要移除 loadingMessage，让上层的 catch 块来处理错误显示
          // 抛出错误，让外层`sendMessage`的try...catch块捕获并处理
          throw new Error(msg);
      }
      // 检查 choices 数组中的错误信息
      if (data.choices?.[0]?.error) {
          const msg = data.choices[0].error.message || 'Unknown OpenAI model error';
          console.error('OpenAI Model error:', data.choices[0].error);
          // 不要移除 loadingMessage，让上层的 catch 块来处理错误显示
          throw new Error(msg);
      }

	      const delta = data.choices?.[0]?.delta || {};

	      // 1) OpenAI 兼容：捕获推理签名（对应 reasoning_content/reasoning）
	      const extractedThoughtSignature =
	        (typeof delta?.thoughtSignature === 'string' && delta.thoughtSignature) ||
	        (typeof delta?.thought_signature === 'string' && delta.thought_signature) ||
	        null;
	      if (extractedThoughtSignature) {
	        latestOpenAIThoughtSignature = extractedThoughtSignature;
	      }

	      // 2) OpenAI 兼容：捕获 tool_calls（含 thoughtSignature / function.arguments 分片）
	      if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
	        latestOpenAIToolCalls = mergeOpenAIToolCallsDelta(latestOpenAIToolCalls, delta.tool_calls);
	      }

	      // 3) 从事件数据中提取内容增量 (delta)
	      const currentEventAnswerDelta = delta?.content;
	      const currentEventReasoningDelta = delta?.reasoning_content || delta?.reasoning || '';

	      // reasoning_content 必须原样累积（用于与 thoughtSignature 配对回传）
	      if (typeof currentEventReasoningDelta === 'string' && currentEventReasoningDelta) {
	        latestOpenAIReasoningContent = mergeStreamingThoughts(latestOpenAIReasoningContent, currentEventReasoningDelta);
	      }

	      const hasToolCallsDelta = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
	      const hasAnyDelta = !!(currentEventAnswerDelta || currentEventReasoningDelta || hasToolCallsDelta);

	      // 只有在有“可展示或结构性”的增量时才继续处理（签名本身可能独立出现：仅保存，不触发 UI 更新）
	      if (hasAnyDelta) {
	          const split = splitDeltaByThinkTags(String(currentEventAnswerDelta || ''), false);

	          // 累积AI的完整响应文本
	          aiResponse += split.answerDelta;

	          // 思考过程同样按“流式增量”合并：
	          // - OpenAI 兼容的 reasoning_content：必须保持原样，不做 <think> 标签拆分；
	          // - content 内的 <think> 片段：仅用于 UI 展示（不计入 reasoning_content 回传）。
	          if (typeof currentEventReasoningDelta === 'string' && currentEventReasoningDelta) {
	            aiThoughtsRaw = mergeStreamingThoughts(aiThoughtsRaw, currentEventReasoningDelta);
	          } else if (split.thoughtDelta) {
	            aiThoughtsRaw = mergeStreamingThoughts(aiThoughtsRaw, split.thoughtDelta);
	          }

	          // 若思考流仍未闭合，避免正文暂存残留 <think>
	          if (split.thoughtDelta && !split.answerDelta) {
            aiResponse = aiResponse; // no-op, 保持逻辑对齐
          }
          const thinkExtraction = extractThinkingFromText(aiResponse);
          aiResponse = thinkExtraction.cleanText;
          // 同 Gemini：避免每帧 mergeThoughts() 触发 trim() 破坏流式思考文本中的换行/空白。
          if (thinkExtraction.thoughtText) {
            aiThoughtsRaw = mergeThoughts(aiThoughtsRaw, thinkExtraction.thoughtText);
          }

          // 【关键逻辑】检查这是否是流式响应的第一个数据块
      const nowHasAnswerContent = (typeof aiResponse === 'string') && aiResponse.trim() !== '';
      if (!hasStartedResponse) {
              // 首次收到可见内容：移除占位 loading 提示（此时 UI 状态已从“等待首 token”切换为正式输出）
              if (loadingMessage && loadingMessage.parentNode) loadingMessage.remove();
              
              // 标记响应已经开始，后续数据块将走更新逻辑
              hasStartedResponse = true;
          // 流式开始：更醒目的输入容器提示
          try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}
              
	              if (currentAiMessageId) {
	                  // 原地替换：首帧直接更新到既有 AI 消息上（不创建新节点）
	                  const regenContainer = getUiContainer();
	                  const anchor = regenContainer
	                    ? captureReadingAnchorForRegenerate(regenContainer, currentAiMessageId, attemptState)
	                    : null;
	                  try {
	                    messageProcessor.updateAIMessage(
	                      currentAiMessageId,
	                      aiResponse,
	                      aiThoughtsRaw,
	                      null
	                    );
	                    if (!hasClearedBoundSignatureForRegenerate) {
	                      hasClearedBoundSignatureForRegenerate = clearBoundSignatureForRegenerate(currentAiMessageId, attemptState);
	                    }
	                    applyApiMetaToMessage(currentAiMessageId, usedApiConfig);
	                  } catch (e) {
	                    console.warn('原地替换 AI 消息失败，将回退为追加新消息:', e);
	                    currentAiMessageId = null;
	                  } finally {
	                    if (regenContainer) {
	                      restoreReadingAnchor(regenContainer, anchor);
	                    }
	                  }
	              }

              if (!currentAiMessageId) {
                // 【创建消息】调用 appendMessage 来创建新的AI消息DOM元素
                // 这是获取唯一 messageId 的关键步骤
                const threadHistoryPatch = buildThreadHistoryPatch(threadContext);
                const historyParentId = threadContext
                  ? (threadContext.parentMessageIdForAi
                    || threadContext.lastMessageId
                    || threadContext.rootMessageId
                    || threadContext.anchorMessageId)
                  : null;
                const shouldRenderDom = !threadContext || isThreadUiActive(threadContext);
                if (threadContext && !shouldRenderDom) {
                  const createdNode = createThreadAiMessageHistoryOnly({
                    content: aiResponse,
                    thoughts: aiThoughtsRaw,
                    historyParentId,
                    historyPatch: threadHistoryPatch
                  });
                  if (createdNode) {
                    currentAiMessageId = createdNode.id;
                    if (attemptState) {
                      attemptState.aiMessageId = currentAiMessageId;
                    }
                    applyApiMetaToMessage(currentAiMessageId, usedApiConfig);
                    updateThreadLastMessage(threadContext, currentAiMessageId);
                  }
                } else {
                  const threadOptions = threadContext
                    ? {
                        container: threadContext.container,
                        historyParentId,
                        preserveCurrentNode: true,
                        historyPatch: threadHistoryPatch
                      }
                    : null;
                  const newAiMessageDiv = messageProcessor.appendMessage(
                      aiResponse,     // 传入初始的文本内容
                      'ai',           // 指定发送者为 'ai'
                      false,          // false: 需要在聊天历史中创建节点
                      null,           // fragment: null, 直接添加到DOM
                      null,           // imagesHTML: null
                      aiThoughtsRaw,  // initialThoughtsRaw: 传入初始的思考内容
                      null,           // messageIdToUpdate: null, 因为是创建新消息
                      null,
                      threadOptions
                  );
                  
                  // 从新创建的DOM元素中获取并保存 messageId
                  if (newAiMessageDiv) {
                      currentAiMessageId = newAiMessageDiv.getAttribute('data-message-id');
                      // 将本次 AI 消息与 attempt 绑定，便于按消息粒度中止/清理
                      if (attemptState) {
                        attemptState.aiMessageId = currentAiMessageId;
                      }
                      // 记录 API 元信息并渲染 footer
                      applyApiMetaToMessage(currentAiMessageId, usedApiConfig, newAiMessageDiv);
                      updateThreadLastMessage(threadContext, currentAiMessageId);
                  }
                }
                
	                // 自动滚动到聊天底部
	                const scrollContainer = getUiContainer();
	                if (scrollContainer) {
	                  scrollToBottom(scrollContainer);
	                }
              }

	              // 记录“正文已出现”：若首帧只包含思考过程，则保持 false，待正文首次出现时强制刷新一次 UI。
	              hasEverShownAnswerContent = nowHasAnswerContent;

	          } else if (currentAiMessageId) {
	              // 【更新消息】如果不是第一个数据块，并且我们已经有了 messageId
	              // 则调用 updateAIMessage 来更新已存在的消息内容
	              const forceUiUpdate = nowHasAnswerContent && !hasEverShownAnswerContent;
	              if (forceUiUpdate) {
	                // 正文首次出现：优先让 UI 立刻落地（同时触发思考框自动折叠）
	                hasEverShownAnswerContent = true;
	              }

	              uiUpdateThrottler.enqueue(
	                {
	                  messageId: currentAiMessageId,
	                  answer: aiResponse,
	                  thoughts: aiThoughtsRaw,
	                  groundingMetadata: null
	                },
	                { force: forceUiUpdate }
	              );
	              // scrollToBottom() 会在 updateAIMessage 内部被调用，这里无需重复调用
	          }
      }
    }
  }

  /**
   * 处理API的非流式响应
   * @private
   * @param {Response} response - Fetch API 响应对象
   * @param {HTMLElement} loadingMessage - 加载状态消息元素
   * @param {Object} usedApiConfig - 本次使用的 API 配置
   * @param {{id:string, aiMessageId?:string}|null} attemptState - 当前请求的 attempt 状态对象
   * @returns {Promise<void>}
   */
  async function handleNonStreamResponse(response, loadingMessage, usedApiConfig, attemptState) {
    // 非流式场景：响应头已收到，但需要完整下载/解析 body，可能会明显等待。
    updateLoadingStatus(
      loadingMessage,
      '正在下载并解析完整回复（非流式）...',
      { stage: 'non_stream_read_body', apiBase: usedApiConfig?.baseUrl || '', modelName: usedApiConfig?.modelName || '' }
    );

    const threadContext = attemptState?.threadContext || null;
    const getUiContainer = () => {
      if (threadContext) return resolveThreadUiContainer(threadContext);
      return chatContainer;
    };

    function applyApiMetaToMessage(messageId, apiConfig, messageDiv) {
      try {
        if (!messageId) return;
        const node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageId);
        if (node) {
          node.apiUuid = apiConfig?.id || null;
          node.apiDisplayName = apiConfig?.displayName || '';
          node.apiModelId = apiConfig?.modelName || '';
        }
        const safeMessageId = escapeMessageIdForSelector(messageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const fallbackEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
          : null;
        renderApiFooter(messageDiv || fallbackEl, node);
      } catch (e) {
        console.warn('记录/渲染API信息失败:', e);
      }
    }

    function renderApiFooter(messageElement, nodeLike) {
      try {
        if (!messageElement || !nodeLike) return;
        let footer = messageElement.querySelector('.api-footer');
        if (!footer) {
          footer = document.createElement('div');
          footer.classList.add('api-footer');
          messageElement.appendChild(footer);
        }
        const allConfigs = (apiManager.getAllConfigs && apiManager.getAllConfigs()) || [];
        let label = '';
        let matchedConfig = null;
        if (nodeLike.apiUuid) {
          matchedConfig = allConfigs.find(c => c.id === nodeLike.apiUuid) || null;
        }
        if (!label && matchedConfig && typeof matchedConfig.displayName === 'string' && matchedConfig.displayName.trim()) {
          label = matchedConfig.displayName.trim();
        }
        if (!label && matchedConfig && typeof matchedConfig.modelName === 'string' && matchedConfig.modelName.trim()) {
          label = matchedConfig.modelName.trim();
        }
        if (!label) label = (nodeLike.apiDisplayName || '').trim();
        if (!label) label = (nodeLike.apiModelId || '').trim();
        const hasThoughtSignature = !!nodeLike.thoughtSignature;

        // footer：带 Thought Signature 的消息使用 "signatured · 模型名" 文本标记
        let displayLabel = label || '';
        if (hasThoughtSignature) {
          displayLabel = label ? `signatured · ${label}` : 'signatured';
        }
        footer.textContent = displayLabel;

        const titleDisplayName = matchedConfig?.displayName || nodeLike.apiDisplayName || '-';
        const titleModelId = matchedConfig?.modelName || nodeLike.apiModelId || '-';
        const thoughtFlag = hasThoughtSignature ? ' | thought_signature: stored' : '';
        footer.title = `API uuid: ${nodeLike.apiUuid || '-'} | displayName: ${titleDisplayName} | model: ${titleModelId}${thoughtFlag}`;
      } catch (e) {
        console.warn('渲染API footer失败:', e);
      }
    }

    let answer = '';
    let thoughts = '';
    // 用于承载“推理签名”（Thought Signature / thoughtSignature）：
    // - Gemini：part-level thought_signature（用于回传给 Gemini 维持多轮推理上下文）
    // - OpenAI 兼容：message-level thoughtSignature（用于与 reasoning_content/tool_calls 配对回传，避免 “signature required”）
    let thoughtSignature = null;
    // 签名来源：用于避免跨 API（Gemini/OpenAI 兼容）误回传导致上游报错
    let thoughtSignatureSource = null;
    // OpenAI 兼容：必须原样保存的 reasoning_content（不要与 thoughts 混用，避免 UI 合并逻辑改变文本导致签名失效）
    let reasoningContentRaw = '';
    // OpenAI 兼容：工具调用（若存在则与 thoughtSignature 一并回传）
    let toolCalls = null;
    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      const text = await response.text().catch(() => '');
      throw new Error(text || '解析响应失败');
    }

    // 错误处理（通用）
    if (json && json.error) {
      const msg = json.error.message || 'API 返回错误';
      throw new Error(msg);
    }

    const isGeminiApi = response.url.includes('generativelanguage.googleapis.com') || usedApiConfig?.baseUrl === 'genai';
    if (isGeminiApi) {
      // 优先检测 Gemini 返回的「安全拦截但 HTTP 为 200」场景，交给上层自动重试逻辑处理
      const safetyBlock = detectGeminiSafetyBlock(json, { hasExistingContent: false });
      if (safetyBlock && safetyBlock.blocked) {
        console.warn('Gemini 响应被安全策略拦截（非流式，HTTP 200）:', safetyBlock.message);
        throw new Error(safetyBlock.message);
      }

      // Google GenAI 非流式格式（支持代码执行、内联图片与思维链签名）
      const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
      const candidate = candidates[0] || null;
      const parts = candidate?.content?.parts || [];
      const inlineImages = [];

      for (const part of parts) {
        // 捕获非函数调用场景下的 Thought Signature：通常位于最后一个 part
        let extractedSignature = null;
        if (typeof part?.thought_signature === 'string' && part.thought_signature) {
          extractedSignature = part.thought_signature;
        } else if (typeof part?.thoughtSignature === 'string' && part.thoughtSignature) {
          // 兼容驼峰命名
          extractedSignature = part.thoughtSignature;
        } else {
          const extraContent = part?.extra_content || part?.extraContent;
          const googleMeta = extraContent && (extraContent.google || extraContent.Google);
          if (googleMeta) {
            if (typeof googleMeta.thought_signature === 'string' && googleMeta.thought_signature) {
              extractedSignature = googleMeta.thought_signature;
            } else if (typeof googleMeta.thoughtSignature === 'string' && googleMeta.thoughtSignature) {
              extractedSignature = googleMeta.thoughtSignature;
            }
          }
        }
        if (extractedSignature) {
          thoughtSignature = extractedSignature;
          thoughtSignatureSource = 'gemini';
        }

        if (typeof part?.text === 'string') {
          if (part.thought) thoughts += part.text; else answer += part.text;
          continue;
        }

        // 可执行代码块 -> Markdown 代码块
        if (part.executableCode && typeof part.executableCode.code === 'string') {
          const lang = (part.executableCode.language || 'python').toString().toLowerCase();
          const code = part.executableCode.code;
          answer += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
          continue;
        }

        // 代码执行结果 -> Markdown 代码块
        if (part.codeExecutionResult && typeof part.codeExecutionResult.output === 'string') {
          const outcome = part.codeExecutionResult.outcome || '';
          const outcomeLabel = outcome ? ` (${outcome})` : '';
          const output = part.codeExecutionResult.output;
          answer += `\n\`\`\`text\n# 代码执行结果${outcomeLabel}\n${output}\n\`\`\`\n`;
          continue;
        }

        // 内联图片 -> 记录待保存的信息，稍后统一下载为本地文件并转为内联 img 元素
        const inline = part.inlineData || part.inline_data;
        if (inline && inline.mimeType && inline.data) {
          if (String(inline.mimeType).startsWith('image/')) {
            inlineImages.push({
              mimeType: inline.mimeType,
              base64Data: inline.data
            });
          }
        }
      }

      if (inlineImages.length > 0) {
        // 逐张图片优先尝试落盘为本地文件，失败时回退为 dataURL
        const resolvedUrls = await Promise.all(
          inlineImages.map(async (img) => {
            const fileUrl = await saveInlineImageToLocalFile(img.mimeType, img.base64Data);
            if (fileUrl) return fileUrl;
            return `data:${img.mimeType};base64,${img.base64Data}`;
          })
        );

        const inlineHtmlChunks = resolvedUrls.map((url) => {
          const safeUrl = (url || '').replace(/"/g, '&quot;');
          const title = '模型生成图片';
          const safeTitle = title.replace(/"/g, '&quot;');
          return `\n<img class="ai-inline-image" src="${safeUrl}" alt="${safeTitle}" />\n`;
        });
        answer += inlineHtmlChunks.join('');
      }
    } else {
      // OpenAI 兼容 非流式
      const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
      const message = choice?.message || {};
      if (typeof message?.content === 'string') answer = message.content;
      if (typeof message?.reasoning_content === 'string') {
        reasoningContentRaw = message.reasoning_content;
        thoughts = message.reasoning_content;
      } else if (typeof message?.reasoning === 'string') {
        reasoningContentRaw = message.reasoning;
        thoughts = message.reasoning;
      }

      // 捕获 OpenAI 兼容 thoughtSignature（对应 reasoning_content 的签名）
      const extractedThoughtSignature =
        (typeof message?.thoughtSignature === 'string' && message.thoughtSignature) ||
        (typeof message?.thought_signature === 'string' && message.thought_signature) ||
        null;
      if (extractedThoughtSignature) {
        thoughtSignature = extractedThoughtSignature;
        thoughtSignatureSource = 'openai';
      }

      // 捕获 tool_calls（如有），并原样保存（含 tool_calls[i].thoughtSignature）
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls;
        // 如果没有 message-level thoughtSignature，但 tool_calls 带签名，也应标记来源为 openai
        if (!thoughtSignatureSource) thoughtSignatureSource = 'openai';
      }
    }

    // 额外提取 <think> 包裹的思考摘要，避免混入正文
    // 注意：OpenAI 兼容的 reasoning_content 需要“原样回传”，因此这里仅影响 UI 展示的 thoughts，不修改 reasoningContentRaw。
    if (typeof answer === 'string') {
      const thinkExtraction = extractThinkingFromText(answer);
      answer = thinkExtraction.cleanText;
      thoughts = mergeThoughts(thoughts, thinkExtraction.thoughtText);
    }

    // 移除 loading 并渲染最终消息
    if (loadingMessage && loadingMessage.parentNode) loadingMessage.remove();
    try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}

    // “原地替换”模式：attemptState.aiMessageId 会在 sendMessageCore 阶段预先绑定到目标消息。
    // 这里优先尝试更新既有 AI 消息；若失败再回退为创建新消息（向后兼容）。
    const existingMessageId = attemptState?.aiMessageId || null;
    if (existingMessageId) {
      try {
        const existingNode = chatHistoryManager.chatHistory.messages.find(m => m.id === existingMessageId);
        const safeMessageId = escapeMessageIdForSelector(existingMessageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const existingEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
          : null;
        if (existingNode && existingNode.role === 'assistant' && existingEl && existingEl.classList.contains('ai-message')) {
          const regenContainer = getUiContainer();
          const anchor = regenContainer
            ? captureReadingAnchorForRegenerate(regenContainer, existingMessageId, attemptState)
            : null;
          try {
            messageProcessor.updateAIMessage(existingMessageId, answer || '', thoughts || '', null);
            // 重新生成（原地替换）：一旦开始写回新内容，旧签名就不再匹配，必须先清空
            clearBoundSignatureForRegenerate(existingMessageId, attemptState);
            applyApiMetaToMessage(existingMessageId, usedApiConfig, existingEl);
            // 在历史节点上记录推理签名，并刷新 footer 标记
            if (thoughtSignature) {
              try {
                existingNode.thoughtSignature = thoughtSignature;
                if (thoughtSignatureSource) existingNode.thoughtSignatureSource = thoughtSignatureSource;
                renderApiFooter(existingEl, existingNode);
              } catch (e) {
                console.warn('记录推理签名失败（非流式，原地替换）:', e);
              }
            }

            // OpenAI 兼容：保存 reasoning_content / tool_calls，供下次请求回传（避免签名校验失败）
            if (!isGeminiApi) {
              try {
                if (typeof reasoningContentRaw === 'string' && reasoningContentRaw) {
                  existingNode.reasoning_content = reasoningContentRaw;
                }
                if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                  existingNode.tool_calls = toolCalls;
                  // 即使没有 message-level thoughtSignature，只要有 tool_calls（含 tool thoughtSignature），也必须标记来源为 openai，确保后续能回传 tool_calls
                  existingNode.thoughtSignatureSource = 'openai';
                }
              } catch (e) {
                console.warn('记录 OpenAI 兼容推理元信息失败（非流式，原地替换）:', e);
              }
            }
            if (!anchor && regenContainer) {
              scrollToBottom(regenContainer);
            }
            return;
          } finally {
            if (regenContainer) {
              restoreReadingAnchor(regenContainer, anchor);
            }
          }
        }
      } catch (e) {
        console.warn('非流式原地替换失败，将回退为创建新消息:', e);
      }
    }

    // 回退：创建新消息（旧行为）
    const threadHistoryPatch = buildThreadHistoryPatch(threadContext);
    const historyParentId = threadContext
      ? (threadContext.parentMessageIdForAi
        || threadContext.lastMessageId
        || threadContext.rootMessageId
        || threadContext.anchorMessageId)
      : null;
    const shouldRenderDom = !threadContext || isThreadUiActive(threadContext);
    if (threadContext && !shouldRenderDom) {
      const createdNode = createThreadAiMessageHistoryOnly({
        content: answer || '',
        thoughts: thoughts || '',
        historyParentId,
        historyPatch: threadHistoryPatch
      });
      if (createdNode) {
        const messageId = createdNode.id;
        // 绑定本次 AI 消息到 attempt，便于按消息粒度中止/清理
        if (attemptState) {
          attemptState.aiMessageId = messageId;
        }
        applyApiMetaToMessage(messageId, usedApiConfig);
        updateThreadLastMessage(threadContext, messageId);
        if (thoughtSignature) {
          try {
            createdNode.thoughtSignature = thoughtSignature;
            if (thoughtSignatureSource) createdNode.thoughtSignatureSource = thoughtSignatureSource;
          } catch (e) {
            console.warn('记录推理签名失败（非流式，后台线程）:', e);
          }
        }

        // OpenAI 兼容：保存 reasoning_content / tool_calls（仅在非 Gemini 场景）
        if (!isGeminiApi) {
          try {
            if (typeof reasoningContentRaw === 'string' && reasoningContentRaw) {
              createdNode.reasoning_content = reasoningContentRaw;
            }
            if (Array.isArray(toolCalls) && toolCalls.length > 0) {
              createdNode.tool_calls = toolCalls;
              createdNode.thoughtSignatureSource = 'openai';
            }
          } catch (e) {
            console.warn('记录 OpenAI 兼容推理元信息失败（非流式，后台线程）:', e);
          }
        }
      }
      return;
    }

    const threadOptions = threadContext
      ? {
          container: threadContext.container,
          historyParentId,
          preserveCurrentNode: true,
          historyPatch: threadHistoryPatch
        }
      : null;
    const newAiMessageDiv = messageProcessor.appendMessage(
      answer || '',
      'ai',
      false,
      null,
      null,          // 非流式 Gemini 使用内联图片
      thoughts || '',
      null,
      null,
      threadOptions
    );
    if (newAiMessageDiv) {
      const messageId = newAiMessageDiv.getAttribute('data-message-id');
      // 绑定本次 AI 消息到 attempt，便于按消息粒度中止/清理
      if (attemptState) {
        attemptState.aiMessageId = messageId;
      }
      applyApiMetaToMessage(messageId, usedApiConfig, newAiMessageDiv);
      updateThreadLastMessage(threadContext, messageId);
      // 在历史节点上记录推理签名，供后续多轮对话回传使用，并刷新 footer 标记
      if (thoughtSignature) {
        try {
          const node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageId);
          if (node) {
            node.thoughtSignature = thoughtSignature;
            if (thoughtSignatureSource) node.thoughtSignatureSource = thoughtSignatureSource;
            renderApiFooter(newAiMessageDiv, node);
          }
        } catch (e) {
          console.warn('记录推理签名失败（非流式）:', e);
        }
      }

	      // OpenAI 兼容：保存 reasoning_content / tool_calls（仅在非 Gemini 场景）
	      if (!isGeminiApi) {
	        try {
	          const node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageId);
	          if (node) {
	            if (typeof reasoningContentRaw === 'string' && reasoningContentRaw) {
	              node.reasoning_content = reasoningContentRaw;
	            }
	            if (Array.isArray(toolCalls) && toolCalls.length > 0) {
	              node.tool_calls = toolCalls;
	              node.thoughtSignatureSource = 'openai';
	            }
	          }
	        } catch (e) {
	          console.warn('记录 OpenAI 兼容推理元信息失败（非流式）:', e);
	        }
	      }
    }
    const scrollContainer = getUiContainer();
    if (scrollContainer) {
      scrollToBottom(scrollContainer);
    }
  }

  /**
   * 执行快速总结操作
   * @public
   * @param {string} webpageSelection - 网页上选择的文本
   * @param {boolean} forceQuery - 是否强制使用查询模式
   * @returns {Promise<void>}
   */
  async function performQuickSummary(webpageSelection = null, forceQuery = false) {
    const wasTemporaryMode = isTemporaryMode;
    try {
      // 确保提示词设置已加载完成
      await new Promise(resolve => {
        const checkSettings = () => {
          const prompts = promptSettingsManager.getPrompts();
          // 检查提示词设置是否已完全加载
          if (prompts && prompts.summary && prompts.summary.model) {
            resolve();
          } else {
            setTimeout(checkSettings, 100);
          }
        };
        checkSettings();
      });

      // 检查焦点是否在侧栏内
      const isSidebarFocused = document.hasFocus();
      const sidebarSelection = window.getSelection().toString().trim();

      // 获取选中的文本内容
      const selectedText = (isSidebarFocused && sidebarSelection) ?
        sidebarSelection :
        webpageSelection?.trim() || '';

      // 获取页面类型
      // 获取当前提示词设置
      const prompts = promptSettingsManager.getPrompts();

      if (selectedText) {
        // 检查是否需要清空聊天记录
        // 统一改为通过 settingsManager 获取，避免分散读取存储
        const clearOnSearch = settingsManager?.getSetting('clearOnSearch');
        if (clearOnSearch !== false) { // 默认为true
          await chatHistoryUI.clearChatHistory();
        }

        // 根据模型名称决定使用哪个提示词
        // forceQuery为true时, 强制使用 'query' 提示词
        const promptType = forceQuery ? 'query' : 'selection';
        const prompt = prompts[promptType].prompt.replace('<SELECTION>', selectedText);

        await sendMessage({
          originalMessageText: prompt,
          specificPromptType: promptType,
          promptMeta: { selectionText: selectedText },
          api: prompts[promptType]?.model
        });
      } else {
        if (wasTemporaryMode) {
          exitTemporaryMode();
        }
        await chatHistoryUI.clearChatHistory();

        const promptType = 'summary';
        messageInput.textContent = prompts[promptType].prompt;
        // 发送消息时指定提示词类型并传入 API 偏好
        await sendMessage({ specificPromptType: promptType, api: prompts[promptType]?.model });
      }
    } catch (error) {
      console.error('获取选中文本失败:', error);
    } finally {
      // 如果之前是临时模式，恢复
      if (wasTemporaryMode) {
        enterTemporaryMode();
      }
    }
  }

  /**
   * 中止当前请求
   * @public
   * @param {HTMLElement|string} [target] - 可选：要中止的目标消息元素或其 data-message-id；缺省时中止所有请求
   */
  function abortCurrentRequest(target) {
    if (!activeAttempts.size) return false;

    let abortedAny = false;
    const isElementTarget = target && typeof target === 'object' && target.nodeType === 1;
    const targetElement = isElementTarget ? target : null;
    const targetId = typeof target === 'string'
      ? target
      : (isElementTarget ? target.getAttribute('data-message-id') : null);

    if (targetElement || targetId) {
      // 按消息粒度中止：仅终止与指定消息/占位符绑定的那一路请求
      for (const attempt of activeAttempts.values()) {
        const matchesById = targetId && attempt.aiMessageId && attempt.aiMessageId === targetId;
        const matchesByLoading = targetElement && attempt.loadingMessage === targetElement;
        if (matchesById || matchesByLoading) {
          attempt.manualAbort = true;
          try { attempt.controller?.abort(); } catch (e) { console.error('中止当前请求失败:', e); }
          abortedAny = true;
        }
      }

      // 如果未能定位到对应 attempt，则退回为中止最近一次请求（向后兼容旧行为）
      if (!abortedAny) {
        const lastAttempt = Array.from(activeAttempts.values()).slice(-1)[0];
        if (lastAttempt) {
          lastAttempt.manualAbort = true;
          try { lastAttempt.controller?.abort(); } catch (e) { console.error('中止当前请求失败:', e); }
          abortedAny = true;
        }
      }
    } else {
      // 无显式目标：用于“清空聊天”等场景，直接中止所有进行中的请求
      for (const attempt of activeAttempts.values()) {
        if (attempt.finished) continue;
        attempt.manualAbort = true;
        try { attempt.controller?.abort(); } catch (e) { console.error('中止当前请求失败:', e); }
        abortedAny = true;
      }

      if (abortedAny) {
        // 全局中止时，立即清理整体 UI 状态，防止残留 glow / updating
        isProcessingMessage = false;
        shouldAutoScroll = false;
        try {
          const loadingMessages = chatContainer.querySelectorAll('.loading-message');
          loadingMessages.forEach(el => el.remove());

          const updatingMessages = chatContainer.querySelectorAll('.ai-message.updating, .ai-message.regenerating');
          updatingMessages.forEach(el => {
            el.classList.remove('updating');
            el.classList.remove('regenerating');
          });

          GetInputContainer().classList.remove('auto-scroll-glow');
          GetInputContainer().classList.remove('auto-scroll-glow-active');
        } catch (e) {
          console.error('中止后清理占位消息失败:', e);
        }
      }
    }

    return abortedAny;
  }

  /**
   * 设置是否发送聊天历史
   * @public
   * @param {boolean} value - 是否发送聊天历史
   */
  function setSendChatHistory(value) {
    shouldSendChatHistory = value;
  }

  function setAutoRetry(value) {
    autoRetryEnabled = !!value;
  }

  /**
   * 设置当前会话ID
   * @public
   * @param {string} id - 会话ID
   */
  function setCurrentConversationId(id) {
    currentConversationId = id;
    // console.log(`消息发送器: 设置当前会话ID为 ${id}`);

    // 同步到“会话-标签页存在性”服务：用于聊天记录面板提示“该会话已在其它标签页打开”
    // 设计说明：
    // - setCurrentConversationId 是当前工程里变更会话ID的统一入口（加载历史/新建会话/分支/清空等最终都会调用）；
    // - 把上报逻辑放在这里，可以确保不会遗漏任何会话切换场景，且对其它模块保持低耦合（可选服务，失败不影响主流程）。
    try {
      services.conversationPresence?.setActiveConversationId?.(id);
    } catch (_) {}
  }

  /**
   * 获取当前会话ID
   * @public
   * @returns {string|null} 当前会话ID
   */
  function getCurrentConversationId() {
    return currentConversationId;
  }

  /**
   * 获取当前临时模式状态
   * @public
   * @returns {boolean} 是否处于临时模式
   */
  function getTemporaryModeState() {
    return isTemporaryMode;
  }

  /**
   * 切换临时模式
   * @public
   */
  function toggleTemporaryMode() {
    if (isTemporaryMode) {
      exitTemporaryMode();
    } else {
      enterTemporaryMode();
    }
  }

  // 公开的API
  return {
    sendMessage,
    sendWithApiConfig,
    performQuickSummary,
    generateConversationTitleForMessages,
    abortCurrentRequest,
    enterTemporaryMode,
    exitTemporaryMode,
    toggleTemporaryMode,
    getTemporaryModeState,
    setSendChatHistory,
    setAutoRetry,
    setCurrentConversationId,
    getCurrentConversationId,
    getShouldAutoScroll,
    setShouldAutoScroll
  };
} 
