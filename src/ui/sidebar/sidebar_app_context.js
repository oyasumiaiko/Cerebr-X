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
    emptyStateRandomBackground: document.getElementById('empty-state-random-background'),
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
  appContext.utils.showNotification = (input, legacyDuration) => {
    // 规范通知类型：统一为 'info' | 'warning' | 'error'，兼容 legacy 'success' -> 'info', 'warn' -> 'warning'
    const normalizeType = (t) => {
      if (!t) return 'info';
      const map = { success: 'info', warn: 'warning' };
      const mapped = map[t] || t;
      return (mapped === 'info' || mapped === 'warning' || mapped === 'error') ? mapped : 'info';
    };
    const normalizeOptions = (value, fallbackDuration) => {
      if (typeof value === 'string') {
        const options = { message: value };
        if (typeof fallbackDuration === 'number') options.duration = fallbackDuration;
        return options;
      }
      if (value && typeof value === 'object') {
        return { ...value };
      }
      return { message: '' };
    };

    /** @type {{ message:string, duration?:number, type?:'info'|'warning'|'error'|'success'|'warn', autoClose?:boolean, showProgress?:boolean, progress?:number|null, progressMode?:'determinate'|'indeterminate', onClose?:()=>void, description?:string }} */
    const config = normalizeOptions(input, legacyDuration);
    const {
      message = '',
      description = '',
      type = 'info',
      onClose = null
    } = config;
    let { duration = 2000, autoClose = true, showProgress = false, progress = null, progressMode = 'determinate' } = config;

    if (typeof duration !== 'number' || duration <= 0) {
      duration = 2000;
    }

    if (progress !== null && typeof progress === 'number') {
      showProgress = true;
    }
    if (progressMode === 'indeterminate') {
      showProgress = true;
    }

    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const initialType = normalizeType(type);
    toast.className = `notification notification--${initialType}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const content = document.createElement('div');
    content.className = 'notification__content';
    content.textContent = message;
    toast.appendChild(content);

    let descriptionEl = null;
    if (description) {
      descriptionEl = document.createElement('div');
      descriptionEl.className = 'notification__description';
      descriptionEl.textContent = description;
      toast.appendChild(descriptionEl);
    }

    let progressContainer = null;
    let progressBar = null;

    const ensureProgressElements = () => {
      if (progressContainer) return;
      progressContainer = document.createElement('div');
      progressContainer.className = 'notification__progress';
      progressBar = document.createElement('div');
      progressBar.className = 'notification__progress-bar';
      progressContainer.appendChild(progressBar);
      toast.appendChild(progressContainer);
    };

    const applyProgress = (value, mode = progressMode) => {
      if (!showProgress || value === null || value === undefined) {
        if (progressContainer) {
          progressContainer.remove();
          progressContainer = null;
          progressBar = null;
        }
        toast.classList.remove('notification--has-progress');
        return;
      }

      ensureProgressElements();
      toast.classList.add('notification--has-progress');
      progressBar.classList.remove('notification__progress-bar--indeterminate');

      if (mode === 'indeterminate') {
        progressBar.style.width = '50%';
        progressBar.classList.add('notification__progress-bar--indeterminate');
      } else {
        const clamped = Math.max(0, Math.min(1, Number(value)));
        progressBar.style.width = `${clamped * 100}%`;
      }
    };

    if (showProgress) {
      applyProgress(progress ?? 0, progressMode);
    }

    container.appendChild(toast);

    const state = {
      closed: false,
      autoClose,
      duration,
      type: initialType,
      closeTimer: null,
      progressMode,
      onClose
    };

    const scheduleClose = () => {
      if (!state.autoClose || state.closed) return;
      if (state.closeTimer) clearTimeout(state.closeTimer);
      state.closeTimer = setTimeout(() => handle.close(), state.duration);
    };

    const clearCloseTimer = () => {
      if (state.closeTimer) {
        clearTimeout(state.closeTimer);
        state.closeTimer = null;
      }
    };

    if (state.autoClose) {
      scheduleClose();
    }

    const handle = {
      element: toast,
      update(updateOptions = {}) {
        if (state.closed) return handle;

        if (typeof updateOptions.message === 'string') {
          content.textContent = updateOptions.message;
        }

        if (typeof updateOptions.description === 'string') {
          if (!descriptionEl) {
            descriptionEl = document.createElement('div');
            descriptionEl.className = 'notification__description';
            toast.insertBefore(descriptionEl, progressContainer);
          }
          descriptionEl.textContent = updateOptions.description;
        } else if (updateOptions.description === null && descriptionEl) {
          descriptionEl.remove();
          descriptionEl = null;
        }

        if (updateOptions.type) {
          const nextType = normalizeType(updateOptions.type);
          toast.classList.remove(`notification--${state.type}`);
          state.type = nextType;
          toast.classList.add(`notification--${state.type}`);
        }

        if (typeof updateOptions.autoClose === 'boolean') {
          state.autoClose = updateOptions.autoClose;
          if (!state.autoClose) {
            clearCloseTimer();
          } else {
            scheduleClose();
          }
        }

        if (typeof updateOptions.duration === 'number' && updateOptions.duration > 0) {
          state.duration = updateOptions.duration;
          if (state.autoClose) {
            scheduleClose();
          }
        }

        if (updateOptions.progressMode) {
          state.progressMode = updateOptions.progressMode;
        }

        if (updateOptions.showProgress !== undefined) {
          showProgress = !!updateOptions.showProgress;
          if (!showProgress) {
            applyProgress(null);
          }
        }

        if (updateOptions.progress !== undefined) {
          progress = updateOptions.progress;
          if (typeof progress === 'number' && !showProgress) {
            showProgress = true;
          }
          if (progress === null) {
            showProgress = false;
          }
          if (showProgress) {
            applyProgress(progress, state.progressMode);
          } else {
            applyProgress(null, state.progressMode);
          }
        } else if (showProgress && updateOptions.progressMode) {
          applyProgress(progress ?? 0, state.progressMode);
        }

        if (state.autoClose && updateOptions.progress === 1 && updateOptions.autoClose !== false) {
          scheduleClose();
        }

        return handle;
      },
      close(immediate = false) {
        if (state.closed) return;
        state.closed = true;
        clearCloseTimer();
        toast.classList.add('fade-out');
        const remove = () => {
          toast.remove();
          if (typeof state.onClose === 'function') {
            try { state.onClose(); } catch (err) { console.error('通知关闭回调异常:', err); }
          }
        };
        if (immediate) {
          remove();
        } else {
          setTimeout(remove, 480);
        }
      }
    };

    return handle;
  };

  appContext.utils.requestScreenshot = () => {
    if (appContext.state.isStandalone) {
      // 警告：独立页面不支持截图
      appContext.utils.showNotification({ message: '独立聊天页面不支持网页截图', type: 'warning' });
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
