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
   * @param {string} [options.originalMessageText] - 原始消息文本，用于恢复输入框内容
   * @param {boolean} [options.regenerateMode] - 是否为重新生成模式
   * @param {string} [options.messageId] - 重新生成模式下的消息ID（通常是用户消息的ID）
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
        const aiEl = chatContainer.querySelector(`[data-message-id="${attemptState.aiMessageId}"]`);
        if (aiEl) {
          aiEl.classList.remove('updating');
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

      // 构造API请求体（可能包含异步图片加载，例如从 file:// 读取本地文件后转为 Base64）
      const requestBody = await apiManager.buildRequest({
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

  /**
   * 解析消息末尾的并行生成标记，例如 "...问题文本[x3]"。
   * @param {string} text - 原始消息文本
   * @returns {{ baseText: string, parallelCount: number }} - 去除标记后的文本与并行次数（默认 1）
   */
  function parseParallelMultiplier(text) {
    const raw = (text || '').trimEnd();
    const MAX_PARALLEL_COUNT = 10;
    // 匹配形如 "[x2]" "[x3]" "[x5]" 的后缀（不区分大小写）
    const match = raw.match(/^(.*)\[x(\d+)\]\s*$/i);
    if (!match) {
      return { baseText: raw, parallelCount: 1 };
    }
    const base = match[1].trimEnd();
    const n = parseInt(match[2], 10);
    // 仅允许 2~10 路并行，超过范围视为 max 路并行但仍移除后缀，避免污染提示词
    if (!Number.isFinite(n) || n < 2 ) {
      return { baseText: base, parallelCount: 1 };
    }
    if (n > MAX_PARALLEL_COUNT) {
      return { baseText: base, parallelCount: MAX_PARALLEL_COUNT };
    }
    return { baseText: base, parallelCount: n };
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

    // 推断本次要使用的原始文本：优先使用调用方传入的 originalMessageText，
    // 否则从当前输入框中获取。
    let rawText;
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

    const { baseText, parallelCount } = parseParallelMultiplier(rawText);
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
          regenerateMode: true
        };
        tasks.push(sendMessageCore(taskOptions));
      }
      return Promise.allSettled(tasks);
    }

    // 场景二：普通发送（从输入框发送一条新用户消息，末尾带 [xN]）
    // 第一步：启动第一路核心请求，让它负责插入用户消息与第一条 AI 回复
    const firstOptions = {
      ...opts,
      originalMessageText: baseText
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
        messageId: baseUserMessageId
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
    // 累积 AI 的主回答文本（仅文本部分，包含代码块、内联图片等 Markdown/HTML 内容）
    let aiResponse = '';
    // 累积当前流中的思考过程文本（Gemini / OpenAI reasoning）
    let aiThoughtsRaw = '';
    // 标记是否为 Gemini 流式接口
    const isGeminiApi = response.url.includes('generativelanguage.googleapis.com') && !response.url.includes('openai');
    // SSE 行缓冲
    let incomingDataBuffer = ''; 
    const decoder = new TextDecoder();
    let currentEventDataLines = []; // 当前事件中的所有 data: 行内容
    // 记录当前流式响应中最新的 Gemini 思维链签名（Thought Signature）
    let latestGeminiThoughtSignature = null;
    // 当前流对应的 AI 消息 ID（与 attempt 绑定）
    let currentAiMessageId = null;

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
              if (part.thought) {
                currentEventThoughtsDelta += part.text;
              } else {
                currentEventAnswerDelta += part.text;
              }
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
          // 将本次 AI 消息与 attempt 绑定，便于按消息粒度中止/清理
          if (attemptState) {
            attemptState.aiMessageId = currentAiMessageId;
          }
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
                  // 将本次 AI 消息与 attempt 绑定，便于按消息粒度中止/清理
                  if (attemptState) {
                    attemptState.aiMessageId = currentAiMessageId;
                  }
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
   * @param {{id:string, aiMessageId?:string}|null} attemptState - 当前请求的 attempt 状态对象
   * @returns {Promise<void>}
   */
  async function handleNonStreamResponse(response, loadingMessage, usedApiConfig, attemptState) {
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
      // 绑定本次 AI 消息到 attempt，便于按消息粒度中止/清理
      if (attemptState) {
        attemptState.aiMessageId = messageId;
      }
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

          const updatingMessages = chatContainer.querySelectorAll('.ai-message.updating');
          updatingMessages.forEach(el => el.classList.remove('updating'));

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
