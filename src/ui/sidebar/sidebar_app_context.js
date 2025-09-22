/**
 * 构建侧边栏 appContext 以及与 DOM/工具相关的辅助函数。
 * 将原本集中在 sidebar.js 中的初始化逻辑拆分出来，
 * 便于后续进一步分离服务初始化与事件绑定责任。
 */

/**
 * 创建侧边栏 appContext 基础结构。
 * @param {boolean} isStandalone - 当前是否处于独立页面模式。
 * @returns {Object} appContext - 含 DOM 引用、状态、服务占位与工具集的上下文。
 */
export function createSidebarAppContext(isStandalone) {
  const apiSettingsToggle = document.getElementById('api-settings-toggle');

  const dom = {
    chatContainer: document.getElementById('chat-container'),
    messageInput: document.getElementById('message-input'),
    contextMenu: document.getElementById('context-menu'),
    copyMessageButton: document.getElementById('copy-message'),
    stopUpdateButton: document.getElementById('stop-update'),
    clearChatContextButton: document.getElementById('clear-chat-context'),
    settingsButton: document.getElementById('settings-button'),
    settingsMenu: document.getElementById('settings-menu'),
    themeSwitch: document.getElementById('theme-switch'),
    themeSelect: document.getElementById('theme-select'),
    sidebarWidth: document.getElementById('sidebar-width'),
    fontSize: document.getElementById('font-size'),
    widthValue: document.getElementById('width-value'),
    fontSizeValue: document.getElementById('font-size-value'),
    collapseButton: document.getElementById('collapse-button'),
    fullscreenToggle: document.getElementById('fullscreen-toggle'),
    sendButton: document.getElementById('send-button'),
    sendChatHistorySwitch: document.getElementById('send-chat-history-switch'),
    showReferenceSwitch: document.getElementById('show-reference-switch'),
    copyCodeButton: document.getElementById('copy-code'),
    imageContainer: document.getElementById('image-container'),
    promptSettingsToggle: document.getElementById('prompt-settings-toggle'),
    promptSettingsPanel: document.getElementById('prompt-settings'),
    inputContainer: document.getElementById('input-container'),
    regenerateButton: document.getElementById('regenerate-message'),
    autoScrollSwitch: document.getElementById('auto-scroll-switch'),
    autoRetrySwitch: document.getElementById('auto-retry-switch'),
    clearOnSearchSwitch: document.getElementById('clear-on-search-switch'),
    scaleFactor: document.getElementById('scale-factor'),
    scaleValue: document.getElementById('scale-value'),
    chatHistoryMenuItem: document.getElementById('chat-history-menu'),
    deleteMessageButton: document.getElementById('delete-message'),
    quickSummary: document.getElementById('quick-summary'),
    clearChat: document.getElementById('clear-chat'),
    debugTreeButton: document.getElementById('debug-chat-tree-btn'),
    screenshotButton: document.getElementById('screenshot-button'),
    sidebarPositionSwitch: document.getElementById('sidebar-position-switch'),
    forkConversationButton: document.getElementById('fork-conversation'),
    copyAsImageButton: document.getElementById('copy-as-image'),
    emptyStateHistory: document.getElementById('empty-state-history'),
    emptyStateSummary: document.getElementById('empty-state-summary'),
    emptyStateTempMode: document.getElementById('empty-state-temp-mode'),
    emptyStateLoadUrl: document.getElementById('empty-state-load-url'),
    emptyStateScreenshot: document.getElementById('empty-state-screenshot'),
    emptyStateExtract: document.getElementById('empty-state-extract'),
    statusDot: document.getElementById('status-dot'),
    stopAtTopSwitch: document.getElementById('stop-at-top-switch'),
    repomixButton: document.getElementById('empty-state-repomix'),
    apiSettingsPanel: document.getElementById('api-settings'),
    apiSettingsToggle,
    apiSettingsText: apiSettingsToggle?.querySelector('span') || null,
    apiSettingsBackButton: document.querySelector('#api-settings .back-button'),
    apiCardsContainer: document.querySelector('#api-settings .api-cards'),
    previewModal: document.querySelector('.image-preview-modal'),
    previewImage: document.querySelector('.image-preview-modal img'),
    previewCloseButton: document.querySelector('.image-preview-modal .image-preview-close'),
    promptSettingsBackButton: document.querySelector('#prompt-settings .back-button'),
    resetPromptsButton: document.getElementById('reset-prompts'),
    savePromptsButton: document.getElementById('save-prompts'),
    selectionPrompt: document.getElementById('selection-prompt'),
    systemPrompt: document.getElementById('system-prompt'),
    pdfPrompt: document.getElementById('pdf-prompt'),
    summaryPrompt: document.getElementById('summary-prompt'),
    queryPrompt: document.getElementById('query-prompt'),
    imagePrompt: document.getElementById('image-prompt'),
    screenshotPrompt: document.getElementById('screenshot-prompt'),
    extractPrompt: document.getElementById('extract-prompt'),
    urlRulesPrompt: document.getElementById('url-rules-prompt'),
    urlRulesList: document.getElementById('url-rules-list'),
    showThoughtProcessSwitch: document.getElementById('show-thought-process-switch'),
    resetSettingsButton: document.getElementById('reset-settings-button'),
    settingsBackButton: document.querySelector('#settings-menu .back-button'),
    openStandalonePage: document.getElementById('open-standalone-page'),
    modeIndicator: document.getElementById('mode-indicator')
  };

  return {
    dom,
    services: {},
    state: {
      isStandalone,
      isFullscreen: false,
      isComposing: false,
      pageInfo: isStandalone ? { url: '', title: '独立聊天', standalone: true } : null,
      memoryManagement: {
        IDLE_CLEANUP_INTERVAL: 5 * 60 * 1000,
        FORCED_CLEANUP_INTERVAL: 30 * 60 * 1000,
        USER_IDLE_THRESHOLD: 3 * 60 * 1000,
        lastUserActivity: Date.now(),
        isEnabled: true
      }
    },
    utils: {}
  };
}

/**
 * 向 appContext 注入常用工具函数。
 * @param {Object} appContext - 侧边栏上下文对象。
 */
/**
 * 将常用的工具/便捷函数挂载到 appContext.utils，供其他模块复用。
 * @param {ReturnType<typeof createSidebarAppContext>} appContext - 已初始化的上下文。
 */
export function registerSidebarUtilities(appContext) {
  function updateInputContainerHeightVar() {
    const input = appContext.dom.inputContainer || document.getElementById('input-container');
    const root = document.documentElement;
    if (input && root) {
      const rect = input.getBoundingClientRect();
      root.style.setProperty('--input-container-height', `${Math.ceil(rect.height)}px`);
    }
  }

  appContext.utils.updateInputContainerHeightVar = updateInputContainerHeightVar;

  appContext.utils.scrollToBottom = () => {
    const settingsManager = appContext.services.settingsManager;
    const messageSender = appContext.services.messageSender;
    const chatContainer = appContext.dom.chatContainer;

    if (settingsManager?.getSetting('autoScroll') === false) return;
    if (!messageSender?.getShouldAutoScroll()) return;

    requestAnimationFrame(() => {
      const stopAtTop = settingsManager?.getSetting('stopAtTop') === true;
      let top = chatContainer.scrollHeight;
      const aiMessages = chatContainer.querySelectorAll('.message.ai-message');
      if (aiMessages.length > 0) {
        const latestAiMessage = aiMessages[aiMessages.length - 1];
        const rect = latestAiMessage.getBoundingClientRect();
        if (stopAtTop) {
          top = latestAiMessage.offsetTop - 8;
          messageSender.setShouldAutoScroll(false);
        } else {
          const computedStyle = window.getComputedStyle(latestAiMessage);
          const marginBottom = parseInt(computedStyle.marginBottom, 10);
          top = latestAiMessage.offsetTop + rect.height - marginBottom;
        }
      }
      chatContainer.scrollTo({ top, behavior: 'smooth' });
    });
  };

  appContext.utils.closeExclusivePanels = () => {
    return appContext.services.uiManager?.closeExclusivePanels();
  };

  appContext.utils.deleteMessageContent = async (messageElement) => {
    if (!messageElement) return;
    const messageId = messageElement.getAttribute('data-message-id');
    messageElement.remove();

    const chatHistoryManager = appContext.services.chatHistoryManager;
    const contextMenuManager = appContext.services.contextMenuManager;
    const chatHistoryUI = appContext.services.chatHistoryUI;

    if (!messageId) {
      console.warn('删除消息：占位或临时消息缺少ID，已直接移除');
      contextMenuManager?.hideContextMenu();
      return;
    }

    const success = chatHistoryManager.deleteMessage(messageId);
    if (!success) {
      console.error('删除消息失败: 未找到对应的消息节点');
    } else {
      await chatHistoryUI.saveCurrentConversation(true);
    }
    contextMenuManager?.hideContextMenu();
  };

  /**
   * 在页面底部展示轻量提示，同时支持自动消失动画。
   * @param {string} message - 展示文案。
   * @param {number} [duration=2000] - 持续毫秒数。
   */
  appContext.utils.showNotification = (message, duration = 2000) => {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'notification';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const content = document.createElement('div');
    content.className = 'notification__content';
    content.textContent = message;

    const progress = document.createElement('div');
    progress.className = 'notification__progress';
    toast.style.setProperty('--toast-duration', `${duration}ms`);

    toast.appendChild(content);
    toast.appendChild(progress);
    container.appendChild(toast);

    const removeToast = () => {
      if (!toast) return;
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 500);
    };
    setTimeout(removeToast, duration);
  };

  appContext.utils.requestScreenshot = () => {
    if (appContext.state.isStandalone) {
      appContext.utils.showNotification('独立聊天页面不支持网页截图');
      return;
    }
    window.parent.postMessage({ type: 'CAPTURE_SCREENSHOT' }, '*');
  };

  appContext.utils.waitForScreenshot = () => {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        const screenshotImg = appContext.dom.imageContainer?.querySelector('img[alt="page-screenshot.png"]');
        if (screenshotImg) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - startTime > 5000) {
          clearInterval(interval);
          console.warn('等待截屏图片超时');
          resolve();
        }
      }, 100);
    });
  };

  appContext.utils.addImageToContainer = (imageData, fileName) => {
    const imageTag = appContext.services.imageHandler.createImageTag(imageData, fileName);
    appContext.dom.imageContainer.appendChild(imageTag);
    appContext.dom.messageInput.dispatchEvent(new Event('input'));
  };
}

/**
 * 根据独立页面模式对界面进行调整。
 * @param {Object} appContext - 侧边栏上下文对象。
 */
/**
 * 根据是否处于独立页面模式，调整界面元素的显隐与样式。
 * @param {ReturnType<typeof createSidebarAppContext>} appContext - 侧边栏上下文。
 */
export function applyStandaloneAdjustments(appContext) {
  if (!appContext.state.isStandalone) {
    return;
  }

  document.body.classList.add('standalone-mode');
  document.documentElement.classList.add('standalone-mode');

  document.documentElement.style.setProperty('--cerebr-sidebar-width', 'calc(100vw - 40px)');

  const standaloneInfo = { url: '', title: '独立聊天', standalone: true };
  appContext.state.pageInfo = standaloneInfo;
  window.cerebr.pageInfo = standaloneInfo;

  const elementsToHide = [
    appContext.dom.collapseButton,
    appContext.dom.statusDot,
    appContext.dom.screenshotButton,
    appContext.dom.fullscreenToggle,
    appContext.dom.quickSummary,
    appContext.dom.emptyStateSummary,
    appContext.dom.emptyStateLoadUrl,
    appContext.dom.emptyStateScreenshot,
    appContext.dom.emptyStateExtract,
    appContext.dom.emptyStateTempMode,
    appContext.dom.repomixButton
  ];

  elementsToHide.forEach((el) => {
    if (el) {
      el.style.display = 'none';
    }
  });

  if (appContext.dom.openStandalonePage) {
    appContext.dom.openStandalonePage.style.display = 'none';
  }

  const widthSlider = document.getElementById('sidebar-width');
  widthSlider?.closest('.menu-item')?.classList.add('standalone-hidden');

  const positionToggle = document.getElementById('sidebar-position-switch');
  positionToggle?.closest('.menu-item')?.classList.add('standalone-hidden');
}
