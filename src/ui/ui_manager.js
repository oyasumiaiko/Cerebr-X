/**
 * UI管理模块
 * 负责管理用户界面元素的交互，如设置菜单、面板切换、输入处理等
 */

/**
 * 创建UI管理器
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.messageInput - 消息输入框元素
 * @param {HTMLElement} appContext.dom.settingsButton - 设置按钮元素
 * @param {HTMLElement} appContext.dom.settingsMenu - 设置菜单元素
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {HTMLElement} appContext.dom.sendButton - 发送按钮元素
 * @param {HTMLElement} appContext.dom.inputContainer - 输入容器元素
 * @param {HTMLElement} appContext.dom.promptSettings - 提示词设置面板元素
 * @param {HTMLElement} appContext.dom.collapseButton - 收起按钮元素
 * @param {Object} appContext.services.chatHistoryUI - 聊天历史UI对象
 * @param {Object} appContext.services.imageHandler - 图片处理器对象
 * @param {Function} appContext.services.messageSender.setShouldAutoScroll - 设置是否自动滚动的函数
 * @param {Function} appContext.services.apiManager.renderFavoriteApis - 渲染收藏API列表的函数
 * @returns {Object} UI管理器实例
 */
export function createUIManager(appContext) {
  // 解构配置选项
  const {
    dom,
    services,
    // utils // For showNotification, scrollToBottom if needed directly
  } = appContext;

  // DOM elements from appContext.dom
  const messageInput = dom.messageInput;
  // settingsButton and settingsMenu are for the main settings panel, managed by settingsManager
  // const settingsButton = dom.settingsToggle; // Use settingsToggle for consistency
  // const settingsMenu = dom.settingsPanel;    // Use settingsPanel
  const chatContainer = dom.chatContainer;
  const threadContainer = dom.threadContainer;
  const sendButton = dom.sendButton;
  const inputContainer = dom.inputContainer;
  const collapseButton = dom.collapseButton;
  const imageContainer = dom.imageContainer; // Added for updateSendButtonState
  // other DOM elements like sidebar, topBar, imagePreviewModal etc. can be accessed via dom if needed

  // Services from appContext.services
  const chatHistoryUI = services.chatHistoryUI; // For closing its panel
  const imageHandler = services.imageHandler;
  const messageSender = services.messageSender; // For setShouldAutoScroll
  const apiManager = services.apiManager; // For renderFavoriteApis
  const settingsManager = services.settingsManager; // 预留：后续需要时再使用

  let settingsMenuTimeout = null; // Timeout for hover-based closing

  /**
   * 自动调整文本框高度
   * @param {HTMLElement} textarea - 文本输入元素
   */
  function adjustTextareaHeight(textarea) {
    textarea.style.height = 'auto';
    const maxHeight = 200;
    const scrollHeight = textarea.scrollHeight;
    textarea.style.height = Math.min(scrollHeight, maxHeight) + 'px';
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  /**
   * 重置输入框高度
   * 在发送消息后调用此方法重置输入框高度
   */
  function resetInputHeight() {
    if (messageInput) {
      adjustTextareaHeight(messageInput);
    }
  }

  /**
   * 更新发送按钮状态
   */
  function updateSendButtonState() {
    const hasText = messageInput.textContent.trim();
    const hasImage = dom.imageContainer?.querySelector('.image-tag');
    const hasInput = !!hasText || !!hasImage;
    sendButton.disabled = !hasInput;
    if (inputContainer) {
      inputContainer.classList.toggle('has-input', hasInput);
    }
  }

  /**
   * 设置菜单开关函数
   * @param {boolean|undefined} show - 是否显示菜单，不传则切换状态
   */
  function toggleSettingsMenu(show) {
    if (!appContext.dom.settingsMenu) {
        console.error("settingsMenu DOM element is not defined in appContext.dom");
        return;
    }

    if (show === undefined) {
      appContext.dom.settingsMenu.classList.toggle('visible');
    } else {
      if (show) {
        appContext.dom.settingsMenu.classList.add('visible');
      } else {
        appContext.dom.settingsMenu.classList.remove('visible');
      }
    }

    if (appContext.dom.settingsMenu.classList.contains('visible')) {
      apiManager.renderFavoriteApis();
    }
  }

  /**
   * 关闭互斥面板函数
   */
  function closeExclusivePanels() {
    // 说明：
    // - “提示词设置 / API 设置”已并入聊天记录面板的标签页，不再作为独立遮罩层管理；
    // - 因此互斥面板只剩下聊天记录面板本身（设置菜单不参与互斥）。
    if (chatHistoryUI?.closeChatHistoryPanel) {
      chatHistoryUI.closeChatHistoryPanel();
    } else {
      const chatPanel = document.getElementById('chat-history-panel');
      if (chatPanel && chatPanel.classList.contains('visible')) {
        chatPanel.classList.remove('visible');
        chatPanel.style.display = 'none';
      }
    }
  }

  /**
   * 设置输入相关事件监听器
   */
  function setupInputEventListeners() {
    // 监听输入框变化
    messageInput.addEventListener('input', function () {
      adjustTextareaHeight(this);
      updateSendButtonState();

      // 处理 placeholder 的显示
      if (this.textContent.trim() === '') {
        // 如果内容空且没有图片标签，清空内容以显示 placeholder
        while (this.firstChild) {
          this.removeChild(this.firstChild);
        }
      }
    });

    messageInput.addEventListener('focus', () => {
      if (inputContainer) {
        inputContainer.classList.add('has-focus');
      }
    });

    messageInput.addEventListener('blur', () => {
      if (!inputContainer) return;
      inputContainer.classList.remove('has-focus');
    });

    // 片粘贴功能
    messageInput.addEventListener('paste', async (e) => {

      const items = Array.from(e.clipboardData.items);
      const imageItem = items.find(item => item.type.startsWith('image/'));

      if (imageItem) {
        // 处理图片粘贴
        const file = imageItem.getAsFile();
        const reader = new FileReader();
        reader.onload = async () => {
          imageHandler.addImageToContainer(reader.result, file.name);
        };
        reader.readAsDataURL(file);
      }
      // 粘贴后调整输入框高度
      adjustTextareaHeight(this);
    });

    // 修改拖放处理
    messageInput.addEventListener('drop', (e) => imageHandler.handleImageDrop(e, messageInput));
    chatContainer.addEventListener('drop', (e) => imageHandler.handleImageDrop(e, chatContainer));
  }

  /**
   * 设置设置菜单事件监听器
   */
  function setupSettingsMenuEventListeners() {
    // Hover behavior for settings menu
    if (dom.settingsButton && dom.settingsMenu) {
        const openSettingsMenu = () => {
            clearTimeout(settingsMenuTimeout);
            // 设置菜单不参与互斥：打开它不应关闭其他面板
            dom.settingsMenu.classList.add('visible');
            apiManager.renderFavoriteApis();
        };

        
        appContext.dom.promptSettingsToggle.addEventListener('click', async (e) => {
          e.stopPropagation();

          const chatHistoryUI = services.chatHistoryUI;
          const targetTab = 'prompt-settings';

          const isPanelOpen = !!chatHistoryUI?.isChatHistoryPanelOpen?.();
          const activeTab = chatHistoryUI?.getActiveTabName?.();

          // 行为对齐旧交互：
          // - 若已在“提示词设置”标签页，再点一次则关闭面板；
          // - 否则打开聊天记录面板并跳转到对应标签页。
          if (isPanelOpen && activeTab === targetTab) {
            closeExclusivePanels();
            return;
          }

          if (!isPanelOpen) {
            closeExclusivePanels();
            await chatHistoryUI?.showChatHistoryPanel?.(targetTab);
          } else {
            await chatHistoryUI?.activateTab?.(targetTab);
          }

        });

        if (appContext.dom.preferencesSettingsToggle) {
          appContext.dom.preferencesSettingsToggle.addEventListener('click', async (e) => {
            e.stopPropagation();

            const chatHistoryUI = services.chatHistoryUI;
            const targetTab = 'settings';

            const isPanelOpen = !!chatHistoryUI?.isChatHistoryPanelOpen?.();
            const activeTab = chatHistoryUI?.getActiveTabName?.();

            // 行为对齐旧交互：
            // - 若已在“偏好设置”标签页，再点一次则关闭面板；
            // - 否则打开聊天记录面板并跳转到对应标签页。
            if (isPanelOpen && activeTab === targetTab) {
              closeExclusivePanels();
              return;
            }

            if (!isPanelOpen) {
              closeExclusivePanels();
              await chatHistoryUI?.showChatHistoryPanel?.(targetTab);
            } else {
              await chatHistoryUI?.activateTab?.(targetTab);
            }
          });
        }

        const scheduleCloseSettingsMenu = () => {
            clearTimeout(settingsMenuTimeout);
            settingsMenuTimeout = setTimeout(() => {
                dom.settingsMenu.classList.remove('visible');
            }, 300); // 300ms delay before closing
        };

        dom.settingsButton.addEventListener('mouseenter', openSettingsMenu);
        dom.settingsButton.addEventListener('mouseleave', scheduleCloseSettingsMenu);

        dom.settingsMenu.addEventListener('mouseenter', () => {
            clearTimeout(settingsMenuTimeout); // Mouse entered menu, cancel scheduled close
        });
        dom.settingsMenu.addEventListener('mouseleave', () => {
            scheduleCloseSettingsMenu();
        });

        // Keep this: 阻止菜单内部点击事件冒泡，防止触发外部的关闭逻辑
        dom.settingsMenu.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    // The global document click listener is in sidebar.js for closing by clicking outside.

    // 不再在输入框获得焦点时强制关闭其他面板，避免与面板互斥逻辑产生冲突
  }

  /**
   * 添加消息容器事件监听器（主消息与线程消息共用）
   * @param {HTMLElement} container - 消息滚动容器
   */
  function setupScrollableContainerEventListeners(container) {
    const AUTO_SCROLL_THRESHOLD = 100;
    const ALT_SCROLL_MULTIPLIER = 5; // 固定 5 倍滚动速度，避免动态加速带来的不可控跳跃；如需调节手感只改这里。

    /**
     * 将滚轮事件的 delta 值统一转换为像素单位
     * @param {number} value - 原始 delta 数值
     * @param {number} mode - deltaMode 常量
     * @returns {number} 像素值
     */
    const normalizeWheelDelta = (value, mode) => {
      if (!value) return 0;
      if (mode === 1) { // DOM_DELTA_LINE
        const computedStyle = window.getComputedStyle(container);
        const lineHeight = parseFloat(computedStyle.lineHeight);
        if (Number.isFinite(lineHeight)) {
          return value * lineHeight;
        }
        const fontSize = parseFloat(computedStyle.fontSize) || 16;
        return value * fontSize * 1.2;
      }
      if (mode === 2) { // DOM_DELTA_PAGE
        return value * container.clientHeight;
      }
      return value;
    };

    // 按住 Alt 时使用加速滚动，提高浏览长对话的效率
    container.addEventListener('wheel', (e) => {
      let effectiveDeltaY = e.deltaY;

      if (e.altKey) {
        e.preventDefault();
        const acceleratedDeltaY = normalizeWheelDelta(e.deltaY, e.deltaMode) * ALT_SCROLL_MULTIPLIER;
        const acceleratedDeltaX = normalizeWheelDelta(e.deltaX, e.deltaMode) * ALT_SCROLL_MULTIPLIER;

        if (acceleratedDeltaY) {
          container.scrollTop += acceleratedDeltaY;
          effectiveDeltaY = acceleratedDeltaY;
        } else {
          effectiveDeltaY = 0;
        }

        if (acceleratedDeltaX) {
          container.scrollLeft += acceleratedDeltaX;
        }
      }

      if (effectiveDeltaY < 0) {
        messageSender.setShouldAutoScroll(false);
        return;
      }

      if (effectiveDeltaY > 0) {
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceFromBottom < AUTO_SCROLL_THRESHOLD) {
          messageSender.setShouldAutoScroll(true);
        } else if (e.altKey) {
          messageSender.setShouldAutoScroll(false);
        }
      }
    }, { passive: false });

    container.addEventListener('mousedown', (e) => {
      if (e.offsetX < container.clientWidth) { 
         messageSender.setShouldAutoScroll(false);
      }
    });

    // Prevent default image click behavior in chat
    container.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG' && e.target.closest('.message-content__ai_message_content_img')) {
        e.preventDefault(); // 阻止图片链接跳转等默认行为
        // e.stopPropagation(); // 暂时移除，观察是否解决了自动滚动问题。如果需要阻止其他冒泡行为，可以再加回来。
        // 可以考虑在这里添加其他图片交互，如新标签页打开
        // window.open(e.target.src, '_blank');
      }
    });
  }

  /**
   * 添加聊天容器事件监听器
   */
  function setupChatContainerEventListeners() {
    // 移除外层条件检查，如果 chatContainer 或 messageSender 无效，将直接报错
    setupScrollableContainerEventListeners(chatContainer);
    if (threadContainer) {
      setupScrollableContainerEventListeners(threadContainer);
    }
  }

  /**
   * 设置焦点相关事件监听器
   */
  function setupFocusEventListeners() {
    // 监听输入框的焦点状态
    messageInput.addEventListener('focus', () => {
      // 输入框获得焦点，阻止事件冒泡
      messageInput.addEventListener('click', (e) => e.stopPropagation());
    });

    messageInput.addEventListener('blur', () => {
      // 输入框失去焦点时，移除点击事件监听
      messageInput.removeEventListener('click', (e) => e.stopPropagation());
    });
  }

  /**
   * 初始化UI管理器
   */
  function init() {
    setupInputEventListeners();
    setupSettingsMenuEventListeners();
    setupChatContainerEventListeners();
    setupFocusEventListeners();
    
    // 初始更新发送按钮状态
    updateSendButtonState();
  }

  // 公开的API
  return {
    init,
    adjustTextareaHeight,
    updateSendButtonState,
    toggleSettingsMenu,
    closeExclusivePanels,
    resetInputHeight
  };
} 
