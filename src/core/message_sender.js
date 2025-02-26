/**
 * 消息发送和处理模块
 * 
 * 负责管理消息的构建、发送和处理响应的整个生命周期。
 * 这个模块是应用程序的核心部分，处理从用户输入到AI响应显示的完整流程。
 */

/**
 * 创建消息发送器
 * @param {Object} options - 配置选项
 * @param {Object} options.apiManager - API管理器实例
 * @param {Object} options.messageProcessor - 消息处理器实例
 * @param {Object} options.imageHandler - 图片处理器实例
 * @param {Object} options.chatHistoryUI - 聊天历史UI实例
 * @param {Function} options.getCurrentConversationChain - 获取当前会话链的函数
 * @param {HTMLElement} options.chatContainer - 聊天容器元素
 * @param {HTMLElement} options.messageInput - 消息输入框元素
 * @param {HTMLElement} options.imageContainer - 图片容器元素
 * @param {Function} options.scrollToBottom - 滚动到底部的函数
 * @param {Function} options.getPrompts - 获取提示词设置的函数
 * @param {Object} options.uiManager - UI管理器实例
 * @returns {Object} 消息发送器实例
 */
export function createMessageSender(options) {
  // 从选项中提取所需依赖
  const {
    apiManager,
    messageProcessor,
    imageHandler,
    chatHistoryUI,
    getCurrentConversationChain,
    chatContainer,
    messageInput,
    imageContainer,
    scrollToBottom,
    getPrompts,
    uiManager
  } = options;

  // 私有状态
  let isProcessingMessage = false;
  let shouldAutoScroll = true;
  let currentController = null;
  let isTemporaryMode = false;
  let pageContent = null;
  let shouldSendChatHistory = true;
  let currentConversationId = null;

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
    messageInput.innerHTML = '';
    imageContainer.innerHTML = '';
    // 重置输入框高度
    uiManager.resetInputHeight();
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
      return response;
    } catch (error) {
      console.error('获取网页内容失败:', error);
      return null;
    }
  }

  /**
   * 进入临时模式，不获取网页内容
   * @public
   */
  function enterTemporaryMode() {
    isTemporaryMode = true;
    messageInput.classList.add('temporary-mode');
    document.body.classList.add('temporary-mode');
    messageInput.setAttribute('placeholder', '临时模式 - 不获取网页内容');
  }

  /**
   * 退出临时模式
   * @public
   */
  function exitTemporaryMode() {
    isTemporaryMode = false;
    messageInput.classList.remove('temporary-mode');
    document.body.classList.remove('temporary-mode');
    messageInput.setAttribute('placeholder', '输入消息...');
  }

  /**
   * 准备和发送消息
   * @public
   * @param {Object} [options] - 可选参数对象，用于重新生成消息时传递上下文
   * @param {Array<string>} [options.injectedSystemMessages] - 重新生成时保留的系统消息
   * @param {string} [options.specificPromptType] - 指定使用的提示词类型
   * @param {Object} [options.specificApiConfig] - 指定使用的API配置
   * @param {string} [options.originalMessageText] - 原始消息文本，用于恢复输入框内容
   * @returns {Promise<void>}
   */
  async function sendMessage(options = {}) {
    // 验证API配置
    if (!validateApiConfig()) return;

    // 从options中提取重新生成所需的变量
    const {
      injectedSystemMessages: existingInjectedSystemMessages = [],
      specificPromptType = null,
      specificApiConfig = null,
      originalMessageText = null
    } = options;

    const imageTags = imageContainer.querySelectorAll('.image-tag');
    // 如果是重新生成，使用原始消息文本；否则从输入框获取
    let messageText = originalMessageText || messageInput.textContent;
    const imageContainsScreenshot = imageContainer.querySelector('img[alt="page-screenshot.png"]');

    // 如果消息为空且没有图片标签，则不发送消息
    const isEmptyMessage = !messageText && imageTags.length === 0;
    if (isEmptyMessage) return;

    // 获取当前提示词设置
    const prompts = getPrompts();
    
    // 如果只有图片没有文本，使用图片专用提示词
    const shouldUseImagePrompt = imageTags.length > 0 && messageText.trim() === '';
    if (shouldUseImagePrompt) {
      messageText = prompts.image.prompt;
    }
    
    // 获取提示词类型 - 如果指定了类型则使用指定的类型
    const currentPromptType = specificPromptType || 
                             messageProcessor.getPromptTypeFromContent(messageText, prompts);

    // 提前创建 loadingMessage 配合finally使用
    let loadingMessage;

    try {
      // 开始处理消息
      isProcessingMessage = true;
      shouldAutoScroll = true;

      // 如果存在之前的请求，先中止它
      if (currentController) {
        currentController.abort();
        currentController = null;
      }

      // 创建新的 AbortController
      currentController = new AbortController();
      const signal = currentController.signal;

      // 当开始生成时，给聊天容器添加 glow 效果
      chatContainer.classList.add('auto-scroll-glow');

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

      // 添加用户消息，同时包含文本和图片区域
      let userMessageDiv;
      if (!isEmptyMessage) {
        userMessageDiv = messageProcessor.appendMessage(
          messageText, 
          'user', 
          false, 
          null, 
          imageContainer.innerHTML
        );
        
        // 保存元数据到用户消息，用于后续重新生成
        if (injectedSystemMessages.length > 0) {
          userMessageDiv.setAttribute('data-injected-system-messages', JSON.stringify(injectedSystemMessages));
        }
        if (currentPromptType) {
          userMessageDiv.setAttribute('data-prompt-type', currentPromptType);
        }
      }

      // 清空输入区域
      clearInputs();
      
      // 添加加载状态消息
      loadingMessage = messageProcessor.appendMessage('正在处理...', 'ai', true);
      loadingMessage.classList.add('loading-message');

      // 如果不是临时模式，获取网页内容
      if (!isTemporaryMode) {
        loadingMessage.textContent = '正在获取网页内容...';
        const pageContentResponse = await getPageContent();
        if (pageContentResponse) {
          pageContent = pageContentResponse;
          // 创建字数统计元素
          const footer = document.createElement('div');
          footer.classList.add('content-length-footer');
          const contentLength = pageContent.content ? pageContent.content.length : 0;
          footer.textContent = `↑ ${contentLength.toLocaleString()}`;
          // 添加到用户消息下方
          userMessageDiv?.appendChild(footer);
        } else {
          pageContent = null;
          console.error('获取网页内容失败。');
        }
      } else {
        pageContent = null;  // 临时模式下不使用网页内容
      }

      // 构建消息数组
      const messages = await buildMessages(
        prompts,
        injectedSystemMessages,
        pageContent,
        imageContainsScreenshot,
        currentPromptType
      );

      // 获取API配置
      // 优先使用指定的配置，其次使用提示词类型对应的模型配置，最后使用当前选中的配置
      const config = specificApiConfig || 
                    apiManager.getModelConfig(currentPromptType, prompts);
      
      // 如果用户消息存在，保存API配置信息到用户消息
      if (userMessageDiv && config) {
        // 只存储必要的配置信息，避免保存API密钥
        const configToSave = {
          baseUrl: config.baseUrl,
          modelName: config.modelName,
          temperature: config.temperature,
          customParams: config.customParams
        };
        userMessageDiv.setAttribute('data-api-config', JSON.stringify(configToSave));
      }

      // 更新加载状态消息
      loadingMessage.textContent = '正在等待 AI 回复...';

      // 构造API请求体
      const requestBody = apiManager.buildRequest({
        messages: messages,
        config: config
      });

      // 发送API请求
      const response = await apiManager.sendRequest({
        requestBody: requestBody,
        config: config,
        signal: signal
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API错误 (${response.status}): ${error}`);
      }

      // 处理流式响应
      await handleStreamResponse(response, loadingMessage);

      // 消息处理完成后，自动保存会话
      if (currentConversationId) {
        await chatHistoryUI.saveCurrentConversation(true); // 更新现有会话记录
      } else {
        await chatHistoryUI.saveCurrentConversation(false); // 新会话，生成新的 conversation id
        // 获取新创建的会话ID并更新本地变量
        currentConversationId = chatHistoryUI.getCurrentConversationId();
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('用户手动停止更新');
        return;
      }
      console.error('发送消息失败:', error);
      // 更新加载状态消息显示错误
      if (loadingMessage) {
        loadingMessage.textContent = '发送失败: ' + error.message;
        loadingMessage.classList.add('error-message');
      }
    } finally {
      // 无论成功还是失败，都重置处理状态
      isProcessingMessage = false;
      shouldAutoScroll = false;
      // 当生成结束时，移除 glow 效果
      chatContainer.classList.remove('auto-scroll-glow');
      // 当生成结束时，移除 loading 效果
      const lastMessage = chatContainer.querySelector('.ai-message:last-child');
      if (lastMessage) {
        lastMessage.classList.remove('updating');
      }
    }
  }

  /**
   * 构建消息数组
   * @private
   * @param {Object} prompts - 提示词设置
   * @param {Array<string>} injectedSystemMessages - 注入的系统消息
   * @param {Object|null} pageContent - 页面内容
   * @param {boolean} imageContainsScreenshot - 是否包含截图
   * @param {string} currentPromptType - 当前提示词类型
   * @returns {Array<Object>} 消息数组
   */
  async function buildMessages(prompts, injectedSystemMessages, pageContent, imageContainsScreenshot, currentPromptType) {
    const messages = [];

    const pageContentPrompt = pageContent
      ? `\n\n当前网页内容：\n标题：${pageContent.title}\nURL：${pageContent.url}\n内容：${pageContent.content}`
      : '';

    // 组合系统消息+注入的系统消息+网页内容
    let systemMessageContent = prompts.system.prompt;

    if (imageContainsScreenshot) {
      systemMessageContent += "\n用户附加了当前页面的屏幕截图";
    }
    systemMessageContent += "\n" + injectedSystemMessages.join('\n');
    systemMessageContent += pageContentPrompt;

    // 构建系统消息对象
    const systemMessage = {
      role: "system",
      content: systemMessageContent
    };
    
    // 将系统消息添加到消息数组
    messages.push(systemMessage);

    // 获取当前会话链
    const conversationChain = getCurrentConversationChain();

    // 根据设置决定是否发送聊天历史
    const sendChatHistory = shouldSendChatHistory && 
      currentPromptType !== 'selection' && 
      currentPromptType !== 'image';
      
    if (sendChatHistory) {
      messages.push(...conversationChain.map(node => ({
        role: node.role,
        content: node.content
      })));
    } else {
      // 只发送最后一条消息
      if (conversationChain.length > 0) {
        const lastMessage = conversationChain[conversationChain.length - 1];
        messages.push({
          role: lastMessage.role,
          content: lastMessage.content
        });
      }
    }

    return messages;
  }

  /**
   * 处理API的流式响应
   * @private
   * @param {Response} response - Fetch API 响应对象
   * @param {HTMLElement} loadingMessage - 加载状态消息元素
   * @returns {Promise<void>}
   */
  async function handleStreamResponse(response, loadingMessage) {
    const reader = response.body.getReader();
    let hasStartedResponse = false;
    let aiResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = new TextDecoder().decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const content = line.slice(6);
          if (content.trim() === '[DONE]') continue;
          try {
            const data = JSON.parse(content);
            const deltaContent = data.choices?.[0]?.delta?.content || 
                                data.choices?.[0]?.delta?.reasoning_content;
            if (deltaContent) {
              if (!hasStartedResponse) {
                // 收到首批令牌：移除加载消息并立即滚动到底部
                loadingMessage.remove();
                hasStartedResponse = true;
                scrollToBottom();
              }
              aiResponse += deltaContent;
              aiResponse = aiResponse.replace(/\nabla/g, '\\nabla');
              updateAIMessage(aiResponse, data.choices?.[0]?.groundingMetadata);
            }
          } catch (e) {
            console.error('解析响应出错:', e);
          }
        }
      }
    }
  }

  /**
   * 更新AI消息内容
   * @private
   * @param {string} aiResponse - 消息文本内容
   * @param {Object|null} groundingMetadata - 引用元数据对象
   */
  function updateAIMessage(aiResponse, groundingMetadata) {
    messageProcessor.updateAIMessage(aiResponse, groundingMetadata);
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
      const prompts = getPrompts();

      if (selectedText) {
        // 检查是否需要清空聊天记录
        const result = await chrome.storage.sync.get(['clearOnSearch']);
        if (result.clearOnSearch !== false) { // 默认为true
          await chatHistoryUI.clearChatHistory();
        }

        // 根据模型名称决定使用哪个提示词
        // forceQuery为true时, 强制使用 'query' 提示词
        const promptType = forceQuery ? 'query' : 
          ((prompts.selection.model || '').endsWith('-search') ? 'selection' : 'query');
        const prompt = prompts[promptType].prompt.replace('<SELECTION>', selectedText);
        messageInput.textContent = prompt;

        // 发送消息
        await sendMessage({ specificPromptType: promptType });
      } else {
        if (wasTemporaryMode) {
          exitTemporaryMode();
        }
        await chatHistoryUI.clearChatHistory();

        // 为PDF文件使用自定义的PDF提示词
        const promptType = isPDF ? 'pdf' : 'summary';
        messageInput.textContent = prompts[promptType].prompt;
        // 发送消息时指定提示词类型
        await sendMessage({ specificPromptType: promptType });
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
      currentController.abort();
      currentController = null;
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

  /**
   * 设置当前会话ID
   * @public
   * @param {string} id - 会话ID
   */
  function setCurrentConversationId(id) {
    currentConversationId = id;
    console.log(`消息发送器: 设置当前会话ID为 ${id}`);
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
    performQuickSummary,
    abortCurrentRequest,
    enterTemporaryMode,
    exitTemporaryMode,
    toggleTemporaryMode,
    getTemporaryModeState,
    setSendChatHistory,
    setCurrentConversationId,
    getCurrentConversationId,
    getShouldAutoScroll,
    setShouldAutoScroll
  };
} 