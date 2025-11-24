/**
 * 消息发送和处理模块
 * 
 * 负责管理消息的构建、发送和处理响应的整个生命周期。
 * 这个模块是应用程序的核心部分，处理从用户输入到AI响应显示的完整流程。
 */
import { composeMessages } from './message_composer.js';

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
  const messageInput = dom.messageInput; // 保持兼容：占位符/样式仍可直接操作
  const imageContainer = dom.imageContainer; // 将逐步迁移到 inputController
  const scrollToBottom = utils.scrollToBottom;
  const settingsManager = services.settingsManager;
  const promptSettingsManager = services.promptSettingsManager;
  const uiManager = services.uiManager;
  const showNotification = utils.showNotification;

  // 私有状态
  let isProcessingMessage = false;
  let shouldAutoScroll = true;
  let activeAttempt = null;
  let isTemporaryMode = false;
  let pageContent = null;
  let shouldSendChatHistory = true;
  let autoRetryEnabled = false;
  // 自动重试配置：指数退避，最多 5 次
  const MAX_AUTO_RETRY_ATTEMPTS = 5;
  const AUTO_RETRY_BASE_DELAY_MS = 500;
  const AUTO_RETRY_MAX_DELAY_MS = 8000;

  function getAutoRetryDelayMs(attemptIndex = 0) {
    const normalizedAttempt = Math.max(0, attemptIndex);
    const rawDelay = AUTO_RETRY_BASE_DELAY_MS * Math.pow(2, normalizedAttempt);
    return Math.min(AUTO_RETRY_MAX_DELAY_MS, Math.round(rawDelay));
  }
  let currentConversationId = null;
  let aiThoughtsRaw = '';
  let currentAiMessageId = null;

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
    } catch (error) {
      console.error('清空消息输入框和图片容器失败:', error);
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
    try {
      document.dispatchEvent(new CustomEvent('TEMP_MODE_CHANGED', { detail: { isOn: false } }));
    } catch (_) {}
  }

  /**
   * 准备和发送消息（带可选 API 选择参数）
   * @public
   * @param {Object} [options] - 可选参数对象
   * @param {Array<string>} [options.injectedSystemMessages] - 重新生成时保留的系统消息
   * @param {string} [options.specificPromptType] - 指定使用的提示词类型
   * @param {string} [options.originalMessageText] - 原始消息文本，用于恢复输入框内容
   * @param {boolean} [options.regenerateMode] - 是否为重新生成模式
   * @param {string} [options.messageId] - 重新生成模式下的消息ID
   * @param {Object|string} [options.api] - API 选择参数：可为完整配置对象、配置 id/displayName/modelName、'selected'、或 {favoriteIndex}
   * @param {Object} [options.resolvedApiConfig] - 已解析好的 API 配置（优先于 api 参数，完全绕过内部选择策略）
   * @param {boolean} [options.forceSendFullHistory] - 是否强制发送完整历史
   * @param {Object|null} [options.pageContentSnapshot] - 若提供则使用该网页内容快照，避免再次获取
   * @param {Array<Object>|null} [options.conversationSnapshot] - 若提供则使用该会话历史快照（数组 of nodes）构建消息
   * @returns {Promise<{ ok: true, apiConfig: Object } | { ok: false, error: Error, apiConfig: Object, retryHint: Object, retry: (delayMs?: number, override?: Object) => Promise<any> }>} 结果对象（供外部无状态重试）
   */
  async function sendMessage(options = {}) {
    // 验证API配置
    if (!validateApiConfig()) return;

    // !!! 重置累积的思考内容和当前AI消息ID !!!
    aiThoughtsRaw = ''; 
    currentAiMessageId = null;

    // 从options中提取重新生成所需的变量
    const {
      injectedSystemMessages: existingInjectedSystemMessages = [],
      specificPromptType = null,
      originalMessageText = null,
      regenerateMode = false,
      messageId = null,
      forceSendFullHistory = false,
      api = null,
      resolvedApiConfig = null,
      pageContentSnapshot = null,
      conversationSnapshot = null
    } = options;

    const autoRetrySetting = settingsManager?.getSetting?.('autoRetry');
    if (typeof autoRetrySetting === 'boolean') {
      autoRetryEnabled = autoRetrySetting;
    }

    const autoRetryAttempt = (typeof options.__autoRetryAttempt === 'number' && options.__autoRetryAttempt >= 0)
      ? options.__autoRetryAttempt
      : 0;

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

    // 获取当前提示词设置
    const promptsConfig = promptSettingsManager.getPrompts();
    const currentPromptType = specificPromptType || messageProcessor.getPromptTypeFromContent(messageText, promptsConfig);
    // 提前创建 loadingMessage 配合finally使用
    let loadingMessage;
    let pageContentResponse = null;
    let pageContentLength = 0;
    let conversationChain = null;
    let preferredApiConfig = null;
    let effectiveApiConfig = null;

    const beginAttempt = () => {
      if (activeAttempt) {
        activeAttempt.manualAbort = true;
        try { activeAttempt.controller.abort(); } catch (_) {}
      }
      const attemptState = {
        controller: new AbortController(),
        manualAbort: false,
        finished: false,
        loadingMessage: null
      };
      activeAttempt = attemptState;
      return attemptState;
    };

    const finalizeAttempt = (attemptState) => {
      if (!attemptState || attemptState.finished) return;
      attemptState.finished = true;

      const isStillActive = activeAttempt === attemptState;
      if (isStillActive) {
        activeAttempt = null;
        isProcessingMessage = false;
        shouldAutoScroll = false;
        GetInputContainer().classList.remove('auto-scroll-glow');
        GetInputContainer().classList.remove('auto-scroll-glow-active');
        const lastMessage = chatContainer.querySelector('.ai-message:last-child');
        if (lastMessage) {
          lastMessage.classList.remove('updating');
        }
      } else if (attemptState.loadingMessage && attemptState.loadingMessage.parentNode) {
        attemptState.loadingMessage.remove();
      }
    };

    let attempt = null;

    try {
      // 开始处理消息
      isProcessingMessage = true;
      shouldAutoScroll = true;

      attempt = beginAttempt();
      const signal = attempt.controller.signal;

      // 当开始生成时，给聊天容器添加 glow 效果
      GetInputContainer().classList.add('auto-scroll-glow');

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
        userMessageDiv = messageProcessor.appendMessage(
          messageText,
          'user',
          false,
          null,
          inputController ? inputController.getImagesHTML() : imageContainer.innerHTML
        );
      }

      // 清空输入区域
      if (!regenerateMode) {
        clearInputs();
      }
      
      // 添加加载状态消息
      loadingMessage = messageProcessor.appendMessage('正在处理...', 'ai', true);
      attempt.loadingMessage = loadingMessage;
      loadingMessage.classList.add('loading-message');
      // 让“等待回复”占位消息也带有 updating 状态，便于右键菜单显示“停止更新”
      loadingMessage.classList.add('updating');

      // 如果不是临时模式，获取网页内容
      if (!isTemporaryMode) {
        if (pageContentSnapshot) {
          pageContentResponse = pageContentSnapshot;
        } else {
          loadingMessage.textContent = '正在获取网页内容...';
          pageContentResponse = await getPageContent();
        }
        if (pageContentResponse) {
          pageContentLength = state.pageInfo?.content?.length || 0;
        } else {
          console.error('获取网页内容失败。');
        }
      }
      
      // 更新加载状态：正在构建消息
      loadingMessage.textContent = '正在构建消息...';

      // 构建消息数组（改为纯函数 composer）
      conversationChain = Array.isArray(conversationSnapshot) && conversationSnapshot.length > 0
        ? conversationSnapshot
        : getCurrentConversationChain();
      // 解析 api 参数（若提供）。发送层不再做任何策略推断
      if (api != null && typeof apiManager.resolveApiParam === 'function') {
        try { preferredApiConfig = apiManager.resolveApiParam(api); } catch (_) { preferredApiConfig = null; }
      }

      const configForMaxHistory = preferredApiConfig || apiManager.getSelectedConfig();
      const sendChatHistoryFlag = (shouldSendChatHistory && currentPromptType !== 'image') || forceSendFullHistory;
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
        maxHistory: configForMaxHistory?.maxChatHistory ?? 500
      });

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

      // 更新加载状态：正在发送请求
      loadingMessage.textContent = '正在发送请求...';

      // 构造API请求体
      const requestBody = apiManager.buildRequest({
        messages: messages,
        config: config
      });

      // 发送API请求
      const response = await apiManager.sendRequest({
        requestBody: requestBody,
        config: effectiveApiConfig,
        signal: signal
      });
      
      // 更新加载状态：等待AI响应
      loadingMessage.textContent = '正在等待回复...';

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API错误 (${response.status}): ${error}`);
      }

      // 根据配置选择流式/非流式处理
      const isGeminiApi = effectiveApiConfig?.baseUrl === 'genai';
      const useStreaming = isGeminiApi
        ? (effectiveApiConfig.useStreaming !== false)
        : !!(requestBody && requestBody.stream);

      if (useStreaming) {
        await handleStreamResponse(response, loadingMessage, effectiveApiConfig);
      } else {
        await handleNonStreamResponse(response, loadingMessage, effectiveApiConfig);
      }

      // 消息处理完成后，自动保存会话
      if (currentConversationId) {
        await chatHistoryUI.saveCurrentConversation(true); // 更新现有会话记录
      } else {
        await chatHistoryUI.saveCurrentConversation(false); // 新会话，生成新的 conversation id
        // 获取新创建的会话ID并更新本地变量
        currentConversationId = chatHistoryUI.getCurrentConversationId();
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
      const retryHint = {
        injectedSystemMessages: existingInjectedSystemMessages,
        specificPromptType,
        originalMessageText: messageText,
        regenerateMode: true,
        messageId,
        forceSendFullHistory,
        pageContentSnapshot: pageContentResponse || null,
        conversationSnapshot: Array.isArray(conversationChain) ? conversationChain : null,
        // 透传外部策略决定的API（若有）
        resolvedApiConfig,
        api
      };
      const retry = (delayMs = 0, override = {}) => new Promise((resolve) => {
        setTimeout(async () => {
          resolve(await sendMessage({ ...retryHint, ...override }));
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

      let messageElement = null;
      if (loadingMessage && loadingMessage.parentNode) {
        messageElement = loadingMessage;
        messageElement.textContent = errorMessageText;
      } else {
        messageElement = messageProcessor.appendMessage(errorMessageText, 'ai', true);
      }

      if (messageElement) {
        messageElement.classList.add('error-message');
        messageElement.classList.remove('loading-message');
        messageElement.classList.remove('updating');
        scrollToBottom();
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

  // 消息构造逻辑已迁移到 message_composer.js 的纯函数 composeMessages

  /**
   * 处理API的流式响应
   * @private
   * @param {Response} response - Fetch API 响应对象
   * @param {HTMLElement} loadingMessage - 加载状态消息元素
   * @returns {Promise<void>}
   */
  async function handleStreamResponse(response, loadingMessage, usedApiConfig) {
    function applyApiMetaToMessage(messageId, apiConfig, messageDiv) {
      try {
        if (!messageId) return;
        const node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageId);
        if (node) {
          node.apiUuid = apiConfig?.id || null;
          node.apiDisplayName = apiConfig?.displayName || '';
          node.apiModelId = apiConfig?.modelName || '';
        }
        renderApiFooter(messageDiv || chatContainer.querySelector(`[data-message-id="${messageId}"]`), node);
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
    // 累积AI的主回答文本（仅文本部分，包含代码块、内联图片等 Markdown/HTML 内容）
    let aiResponse = '';
    // 标记是否为 Gemini 流式接口
    const isGeminiApi = response.url.includes('generativelanguage.googleapis.com') && !response.url.includes('openai');
    // SSE 行缓冲
    let incomingDataBuffer = ''; 
    const decoder = new TextDecoder();
    let currentEventDataLines = []; // 当前事件中的所有 data: 行内容
    // 记录当前流式响应中最新的 Gemini 思维链签名（Thought Signature）
    let latestGeminiThoughtSignature = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Process any buffered complete line at the end of the stream
        if (incomingDataBuffer.length > 0) {
             processLine(incomingDataBuffer); // Process the last buffered line
             incomingDataBuffer = ''; 
        }
        // If there's pending event data, try to process it as the final event
        if (currentEventDataLines.length > 0) {
          processEvent();
        }
        break; 
      }

      incomingDataBuffer += decoder.decode(value, { stream: true });

      let lineEndIndex;
      while ((lineEndIndex = incomingDataBuffer.indexOf('\n')) >= 0) {
        const line = incomingDataBuffer.substring(0, lineEndIndex);
        incomingDataBuffer = incomingDataBuffer.substring(lineEndIndex + 1);
        processLine(line);
      }
    }

    // 流式响应结束后，如果是 Gemini 且解析到了思维链签名，则写入当前 AI 消息节点，并刷新 footer 标记
    if (isGeminiApi && currentAiMessageId && latestGeminiThoughtSignature) {
      try {
        const node = chatHistoryManager.chatHistory.messages.find(m => m.id === currentAiMessageId);
        if (node) {
          // 在历史节点上记录 Thought Signature，供后续多轮对话回传使用
          node.thoughtSignature = latestGeminiThoughtSignature;
          const el = chatContainer.querySelector(`[data-message-id="${currentAiMessageId}"]`);
          if (el) {
            renderApiFooter(el, node);
          }
        }
      } catch (e) {
        console.warn('记录 Gemini 思维链签名失败（流式）:', e);
      }
    }

    function processLine(line) {
      // Trim the line to handle potential CR characters as well (e.g. '\r\n')
      const trimmedLine = line.trim();

      if (trimmedLine === '') { // Empty line: dispatch event
        if (currentEventDataLines.length > 0) {
          processEvent();
        }
      } else if (trimmedLine.startsWith('data:')) {
        // Add content after "data:" (and optional single space) to current event's data lines
        currentEventDataLines.push(trimmedLine.substring(5).trimStart()); 
      } 
      // Ignoring event:, id:, : (comments) as they are not used by current response structures
    }

    function processEvent() {
      // 将当前事件的多行 data 合并为一个 JSON 字符串
      const fullEventData = currentEventDataLines.join('\n'); 
      currentEventDataLines = []; // 重置，准备下一个事件

      if (fullEventData.trim() === '') return; // 空事件直接跳过

      // OpenAI 特有的 [DONE] 结束标记
      if (!isGeminiApi && fullEventData.trim() === '[DONE]') {
        return;
      }

      try {
        const jsonData = JSON.parse(fullEventData);
        if (isGeminiApi) {
          handleGeminiEvent(jsonData);
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
    function handleGeminiEvent(data) {
      if (data.error) {
        const errorMessage = data.error.message || 'Unknown Gemini error';
        console.error('Gemini API error:', data.error);
        // 不要移除 loadingMessage，让上层的 catch 块来处理错误显示
        throw new Error(errorMessage);
      }

      // 本事件的增量内容
      let currentEventAnswerDelta = '';
      let currentEventThoughtsDelta = '';
      let groundingMetadata = null;
      const newInlineImageUrls = [];

      if (data.candidates && data.candidates.length > 0) {
        const candidate = data.candidates[0];
        if (candidate.content && Array.isArray(candidate.content.parts)) {
          candidate.content.parts.forEach(part => {
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
              if (part.thought) {
                currentEventThoughtsDelta += part.text;
              } else {
                currentEventAnswerDelta += part.text;
              }
              return;
            }

            // 2) 可执行代码块 - 转为 Markdown 代码块
            if (part.executableCode && typeof part.executableCode.code === 'string') {
              const lang = (part.executableCode.language || 'python').toString().toLowerCase();
              const code = part.executableCode.code;
              currentEventAnswerDelta += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
              return;
            }

            // 3) 代码执行结果 - 以代码块形式展示
            if (part.codeExecutionResult && typeof part.codeExecutionResult.output === 'string') {
              const outcome = part.codeExecutionResult.outcome || '';
              const outcomeLabel = outcome ? ` (${outcome})` : '';
              const output = part.codeExecutionResult.output;
              currentEventAnswerDelta += `\n\`\`\`text\n# 代码执行结果${outcomeLabel}\n${output}\n\`\`\`\n`;
              return;
            }

            // 4) 内联图片数据 - 转为 dataURL，稍后生成 image-tag
            const inline = part.inlineData || part.inline_data;
            if (inline && inline.mimeType && inline.data) {
              if (String(inline.mimeType).startsWith('image/')) {
                const dataUrl = `data:${inline.mimeType};base64,${inline.data}`;
                newInlineImageUrls.push(dataUrl);
              }
            }
          });
        }
        groundingMetadata = candidate.groundingMetadata;
      }

      // 将本事件中的图片转为内联 img 元素，直接插入到答案增量中
      if (newInlineImageUrls.length > 0) {
        const inlineHtmlChunks = newInlineImageUrls.map((url, index) => {
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
      aiThoughtsRaw = (aiThoughtsRaw || '') + currentEventThoughtsDelta;

      if (!hasStartedResponse) {
        // 首次收到内容（文本或图片）：移除“正在处理...”提示
        if (loadingMessage && loadingMessage.parentNode) loadingMessage.remove();
        hasStartedResponse = true;
        try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}

        const newAiMessageDiv = messageProcessor.appendMessage(
          aiResponse,      // 初始完整回答文本
          'ai',
          false,           // skipHistory = false, 创建历史节点
          null,            // fragment = null
          null,            // inline 模式下不再单独传入图片HTML
          aiThoughtsRaw,   // 初始思考过程
          null             // messageIdToUpdate = null
        );

        if (newAiMessageDiv) {
          currentAiMessageId = newAiMessageDiv.getAttribute('data-message-id');
          // 记录 API 元信息并渲染 footer
          applyApiMetaToMessage(currentAiMessageId, usedApiConfig, newAiMessageDiv);
        }
        scrollToBottom();
      } else if (currentAiMessageId) {
        // 后续事件：直接更新完整文本与思考过程（图片已被转为内联HTML）
        messageProcessor.updateAIMessage(
          currentAiMessageId,
          aiResponse,       // 当前累积完整回答
          aiThoughtsRaw,    // 当前累积思考过程
          groundingMetadata // 引用元数据
        );
        // scrollToBottom() 在 updateAIMessage 内部调用
      }
    }

    /**
     * 处理与OpenAI兼容的API的SSE事件
     * @param {Object} data - 从SSE事件中解析出的JSON对象
     */
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

      // 从事件数据中提取内容增量 (delta)
      let currentEventAnswerDelta = data.choices?.[0]?.delta?.content;
      let currentEventThoughtsDelta = data.choices?.[0]?.delta?.reasoning_content || data.choices?.[0]?.delta?.reasoning || '';
      

      // 只有在有实际内容增量时才继续处理
      if (currentEventAnswerDelta || currentEventThoughtsDelta) {
          // 累积AI的完整响应文本
          aiResponse += currentEventAnswerDelta;
          aiThoughtsRaw = (aiThoughtsRaw || '') + currentEventThoughtsDelta; // Accumulate thoughts separately

          // 【关键逻辑】检查这是否是流式响应的第一个数据块
      if (!hasStartedResponse) {
              // 如果是，则移除 "正在等待回复..." 等加载提示信息
              if (loadingMessage && loadingMessage.parentNode) loadingMessage.remove();
              
              // 标记响应已经开始，后续数据块将走更新逻辑
              hasStartedResponse = true;
          // 流式开始：更醒目的输入容器提示
          try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}
              
              // 【创建消息】调用 appendMessage 来创建新的AI消息DOM元素
              // 这是获取唯一 messageId 的关键步骤
              const newAiMessageDiv = messageProcessor.appendMessage(
                  aiResponse,     // 传入初始的文本内容
                  'ai',           // 指定发送者为 'ai'
                  false,          // false: 需要在聊天历史中创建节点
                  null,           // fragment: null, 直接添加到DOM
                  null,           // imagesHTML: null
                  aiThoughtsRaw,  // initialThoughtsRaw: 传入初始的思考内容
                  null            // messageIdToUpdate: null, 因为是创建新消息
              );
              
              // 从新创建的DOM元素中获取并保存 messageId
              if (newAiMessageDiv) {
                  currentAiMessageId = newAiMessageDiv.getAttribute('data-message-id');
                  // 记录 API 元信息并渲染 footer
                  applyApiMetaToMessage(currentAiMessageId, usedApiConfig, newAiMessageDiv);
              }
              
              // 自动滚动到聊天底部
              scrollToBottom();

          } else if (currentAiMessageId) {
              // 【更新消息】如果不是第一个数据块，并且我们已经有了 messageId
              // 则调用 updateAIMessage 来更新已存在的消息内容
              messageProcessor.updateAIMessage(
                  currentAiMessageId, // <-- 使用之前保存的正确ID
                  aiResponse,         // <-- 传递当前累积的完整文本
                  aiThoughtsRaw,      // thoughtsRaw, 传入当前累积的思考内容
                  null                // groundingMetadata: 传递引用元数据（如果存在）
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
   * @returns {Promise<void>}
   */
  async function handleNonStreamResponse(response, loadingMessage, usedApiConfig) {
    function applyApiMetaToMessage(messageId, apiConfig, messageDiv) {
      try {
        if (!messageId) return;
        const node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageId);
        if (node) {
          node.apiUuid = apiConfig?.id || null;
          node.apiDisplayName = apiConfig?.displayName || '';
          node.apiModelId = apiConfig?.modelName || '';
        }
        renderApiFooter(messageDiv || chatContainer.querySelector(`[data-message-id="${messageId}"]`), node);
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
    // 用于承载 Gemini 3 返回的思维链签名（Thought Signature），仅在 Gemini 响应中填充
    let thoughtSignature = null;
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
      // Google GenAI 非流式格式（支持代码执行、内联图片与思维链签名）
      const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
      const candidate = candidates[0] || null;
      const parts = candidate?.content?.parts || [];
      const inlineImageUrls = [];

      parts.forEach(part => {
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
        }

        if (typeof part?.text === 'string') {
          if (part.thought) thoughts += part.text; else answer += part.text;
          return;
        }

        // 可执行代码块 -> Markdown 代码块
        if (part.executableCode && typeof part.executableCode.code === 'string') {
          const lang = (part.executableCode.language || 'python').toString().toLowerCase();
          const code = part.executableCode.code;
          answer += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
          return;
        }

        // 代码执行结果 -> Markdown 代码块
        if (part.codeExecutionResult && typeof part.codeExecutionResult.output === 'string') {
          const outcome = part.codeExecutionResult.outcome || '';
          const outcomeLabel = outcome ? ` (${outcome})` : '';
          const output = part.codeExecutionResult.output;
          answer += `\n\`\`\`text\n# 代码执行结果${outcomeLabel}\n${output}\n\`\`\`\n`;
          return;
        }

        // 内联图片 -> 转为内联 img 元素
        const inline = part.inlineData || part.inline_data;
        if (inline && inline.mimeType && inline.data) {
          if (String(inline.mimeType).startsWith('image/')) {
            const dataUrl = `data:${inline.mimeType};base64,${inline.data}`;
            inlineImageUrls.push(dataUrl);
          }
        }
      });

      if (inlineImageUrls.length > 0) {
        const inlineHtmlChunks = inlineImageUrls.map((url) => {
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
      if (typeof message?.reasoning_content === 'string') thoughts = message.reasoning_content;
      else if (typeof message?.reasoning === 'string') thoughts = message.reasoning;
    }

    // 移除 loading 并渲染最终消息
    if (loadingMessage && loadingMessage.parentNode) loadingMessage.remove();
    try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}
    const newAiMessageDiv = messageProcessor.appendMessage(
      answer || '',
      'ai',
      false,
      null,
      null,          // 非流式 Gemini 使用内联图片
      thoughts || '',
      null
    );
    if (newAiMessageDiv) {
      const messageId = newAiMessageDiv.getAttribute('data-message-id');
      applyApiMetaToMessage(messageId, usedApiConfig, newAiMessageDiv);
      // 在历史节点上记录 Gemini 思维链签名，供后续多轮对话回传使用，并刷新 footer 标记
      if (isGeminiApi && thoughtSignature) {
        try {
          const node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageId);
          if (node) {
            node.thoughtSignature = thoughtSignature;
            renderApiFooter(newAiMessageDiv, node);
          }
        } catch (e) {
          console.warn('记录 Gemini 思维链签名失败（非流式）:', e);
        }
      }
    }
    scrollToBottom();
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
      const contentType = await getDocumentType();
      const isPDF = contentType === 'application/pdf';

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

        await sendMessage({ originalMessageText: prompt, specificPromptType: promptType, api: prompts[promptType]?.model });
      } else {
        if (wasTemporaryMode) {
          exitTemporaryMode();
        }
        await chatHistoryUI.clearChatHistory();

        // 为PDF文件使用自定义的PDF提示词
        const promptType = isPDF ? 'pdf' : 'summary';
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
   * 获取页面类型
   * @private
   * @returns {Promise<string|null>} 页面内容类型
   */
  async function getDocumentType() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_DOCUMENT_TYPE'
      });
      return response?.contentType;
    } catch (error) {
      console.error('获取页面类型失败:', error);
      return null;
    }
  }

  /**
   * 中止当前请求
   * @public
   */
  function abortCurrentRequest() {
    if (activeAttempt?.controller) {
      activeAttempt.manualAbort = true;
      try { activeAttempt.controller.abort(); } catch (e) { console.error('中止当前请求失败:', e); }
      activeAttempt = null;
      isProcessingMessage = false;
      shouldAutoScroll = false;
      // UI 清理：移除“正在更新”的占位消息与状态
      try {
        // 移除所有 loading 占位消息（尚未开始输出首字时存在）
        const loadingMessages = chatContainer.querySelectorAll('.loading-message');
        loadingMessages.forEach(el => el.remove());

        // 移除可能残留的 updating 状态，避免右键菜单误判
        const updatingMessages = chatContainer.querySelectorAll('.ai-message.updating');
        updatingMessages.forEach(el => el.classList.remove('updating'));

        // 同步移除输入容器 glow 效果
        GetInputContainer().classList.remove('auto-scroll-glow');
        GetInputContainer().classList.remove('auto-scroll-glow-active');
      } catch (e) {
        console.error('中止后清理占位消息失败:', e);
      }
      return true;
    }
    return false;
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
