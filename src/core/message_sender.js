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
  let currentController = null;
  let isTemporaryMode = false;
  let pageContent = null;
  let shouldSendChatHistory = true;
  let autoRetryEnabled = false;
  const MAX_AUTO_RETRY_ATTEMPTS = 3;
  const AUTO_RETRY_DELAY_MS = 1000;
  const manuallyAbortedControllers = new WeakSet();
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

    const autoRetryAttempt = (typeof options.__autoRetryAttempt === 'number' && options.__autoRetryAttempt >= 0)
      ? options.__autoRetryAttempt
      : 0;

    let attemptController = null;
    let attemptSignal = null;

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

    try {
      // 开始处理消息
      isProcessingMessage = true;
      shouldAutoScroll = true;

      // 如果存在之前的请求，先中止它
      if (currentController) {
        manuallyAbortedControllers.add(currentController);
        currentController.abort();
        currentController = null;
      }

      // 创建新的 AbortController
      attemptController = new AbortController();
      currentController = attemptController;
      attemptSignal = attemptController.signal;

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
      const conversationChain = Array.isArray(conversationSnapshot) && conversationSnapshot.length > 0
        ? conversationSnapshot
        : getCurrentConversationChain();
      // 解析 api 参数（若提供）。发送层不再做任何策略推断
      let preferredApiConfig = null;
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
      const effectiveApiConfig = config;

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
        signal: attemptSignal
      });
      
      // 更新加载状态：等待AI响应
      loadingMessage.textContent = '正在等待回复...';

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API错误 (${response.status}): ${error}`);
      }

      // 处理流式响应（传入本次使用的 API 配置以便记录与渲染footer）
      await handleStreamResponse(response, loadingMessage, effectiveApiConfig);

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
      const wasManualAbort = isAbortError && attemptController && manuallyAbortedControllers.has(attemptController);

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
        if (typeof showNotification === 'function') {
          const displayAttempt = autoRetryAttempt + 1;
          showNotification(`发送失败，正在自动重试 (${displayAttempt}/${MAX_AUTO_RETRY_ATTEMPTS})`);
        }
        return retry(AUTO_RETRY_DELAY_MS, { __autoRetryAttempt: autoRetryAttempt + 1 });
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
        showNotification('自动重试失败，已达到最大尝试次数');
      }

      return { ok: false, error, apiConfig: (resolvedApiConfig || preferredApiConfig || apiManager.getSelectedConfig()), retryHint, retry };
    } finally {
      const shouldCleanupUi = currentController === attemptController || currentController === null;
      if (shouldCleanupUi) {
        if (currentController === attemptController) {
          currentController = null;
        }
        // 无论成功还是失败，都重置处理状态
        isProcessingMessage = false;
        shouldAutoScroll = false;
        // 当生成结束时，移除 glow 效果
        GetInputContainer().classList.remove('auto-scroll-glow');
        GetInputContainer().classList.remove('auto-scroll-glow-active');
        // 当生成结束时，移除 loading 效果
        const lastMessage = chatContainer.querySelector('.ai-message:last-child');
        if (lastMessage) {
          lastMessage.classList.remove('updating');
        }
      }
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
        if (nodeLike.apiUuid) {
          const cfg = allConfigs.find(c => c.id === nodeLike.apiUuid);
          if (cfg && cfg.modelName) label = cfg.modelName;
        }
        if (!label) label = (nodeLike.apiDisplayName || '').trim();
        if (!label) label = (nodeLike.apiModelId || '').trim();
        footer.textContent = label || '';
        footer.title = `API uuid: ${nodeLike.apiUuid || '-'} | displayName: ${nodeLike.apiDisplayName || '-'} | model: ${nodeLike.apiModelId || '-'}`;
      } catch (e) {
        console.warn('渲染API footer失败:', e);
      }
    }
    const reader = response.body.getReader();
    let hasStartedResponse = false;
    let aiResponse = ''; // Accumulates the AI's textual response over multiple events
    const isGeminiApi = response.url.includes('generativelanguage.googleapis.com') && !response.url.includes('openai');
    
    let incomingDataBuffer = ''; 
    const decoder = new TextDecoder();
    let currentEventDataLines = []; // Store all "data: xxx" contents for the current event

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
      // Join with newlines as per SSE spec for multi-line data fields
      const fullEventData = currentEventDataLines.join('\n'); 
      currentEventDataLines = []; // Reset for next event

      if (fullEventData.trim() === '') return; // Nothing to process

      // OpenAI specific [DONE] signal check
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

    function handleGeminiEvent(data) {
      if (data.error) {
        const errorMessage = data.error.message || 'Unknown Gemini error';
        console.error('Gemini API error:', data.error);
        // 不要移除 loadingMessage，让上层的 catch 块来处理错误显示
        throw new Error(errorMessage); // Propagates to sendMessage's catch block
      }

      // Accumulators for the current event's content parts
      let currentEventAnswerDelta = '';
      let currentEventThoughtsDelta = '';
      let groundingMetadata = null;

      if (data.candidates && data.candidates.length > 0) {
        const candidate = data.candidates[0];
        if (candidate.content && candidate.content.parts) {
          candidate.content.parts.forEach(part => {
            if (part.text) {
              if (part.thought) {
                currentEventThoughtsDelta += part.text;
              } else {
                currentEventAnswerDelta += part.text;
              }
            }
          });
        }
        groundingMetadata = candidate.groundingMetadata;
      }
      
      // Only proceed if there's actual content (answer or thoughts)
      if (currentEventAnswerDelta || currentEventThoughtsDelta) {
        // Update global accumulators
        aiResponse += currentEventAnswerDelta; // aiResponse now specifically tracks the main answer
        aiThoughtsRaw = (aiThoughtsRaw || '') + currentEventThoughtsDelta; // Accumulate thoughts separately

        if (!hasStartedResponse) {
          if (loadingMessage && loadingMessage.parentNode) loadingMessage.remove();
          hasStartedResponse = true;
          // 流式开始：更醒目的输入容器提示
          try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}
          
          // First event with content: create the message element
          // Pass both accumulated answer and thoughts to appendMessage
          const newAiMessageDiv = messageProcessor.appendMessage(
            aiResponse, // Initial answer content
            'ai',
            false, // skipHistory = false, to create history node
            null,  // fragment = null
            null,  // imagesHTML = null
            aiThoughtsRaw, // Initial thoughts content
            null   // messageIdToUpdate = null for new message
          );
          if (newAiMessageDiv) {
            currentAiMessageId = newAiMessageDiv.getAttribute('data-message-id');
            // 记录 API 元信息并渲染 footer
            applyApiMetaToMessage(currentAiMessageId, usedApiConfig, newAiMessageDiv);
          }
          scrollToBottom();
        } else if (currentAiMessageId) {
          // Subsequent events: update the existing message element
          messageProcessor.updateAIMessage(
            currentAiMessageId, 
            aiResponse, // Full current answer
            aiThoughtsRaw, // Full current thoughts
            groundingMetadata // Pass grounding metadata for each update
          );
          // scrollToBottom() is called within updateAIMessage
        }
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
    if (currentController) {
      manuallyAbortedControllers.add(currentController);
      currentController.abort();
      currentController = null;
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
