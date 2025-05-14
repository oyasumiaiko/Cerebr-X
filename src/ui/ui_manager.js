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
 * @param {HTMLElement} appContext.dom.promptSettingsToggle - 提示词设置开关元素
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
  const sendButton = dom.sendButton;
  const inputContainer = dom.inputContainer;
  const promptSettingsPanel = dom.promptSettingsPanel; // Renamed from promptSettings
  const promptSettingsToggle = dom.promptSettingsToggle;
  const collapseButton = dom.collapseButton;
  const imageContainer = dom.imageContainer; // Added for updateSendButtonState
  // other DOM elements like sidebar, topBar, imagePreviewModal etc. can be accessed via dom if needed

  // Services from appContext.services
  const chatHistoryUI = services.chatHistoryUI; // For closing its panel
  const imageHandler = services.imageHandler;
  const messageSender = services.messageSender; // For setShouldAutoScroll
  const apiManager = services.apiManager; // For renderFavoriteApis
  const settingsManager = services.settingsManager; // For toggleSettingsPanel
  const promptSettingsManager = services.promptSettingsManager; // For togglePromptSettingsPanel
  const mainApiSettingsManager = services.apiManager; // For toggling API settings panel

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
    sendButton.disabled = !hasText && !hasImage;
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

    if (appContext.dom.settingsMenu.classList.contains('visible') && apiManager && typeof apiManager.renderFavoriteApis === 'function') {
      apiManager.renderFavoriteApis();
    }
  }

  /**
   * 关闭互斥面板函数
   */
  function closeExclusivePanels() {
    // 定义需要互斥的面板ID列表
    const panelsToCloseDirectly = ['prompt-settings', 'api-settings']; // REMOVED 'settings-menu'
    
    // Close panels managed by their respective services if they have a close method
    if (chatHistoryUI && typeof chatHistoryUI.closeChatHistoryPanel === 'function') {
      chatHistoryUI.closeChatHistoryPanel();
    }
    if (promptSettingsManager && typeof promptSettingsManager.closePanel === 'function') {
      promptSettingsManager.closePanel();
    } else if (appContext.dom.promptSettingsPanel) { // Use appContext.dom reference
      appContext.dom.promptSettingsPanel.classList.remove('visible');
    }

    if (apiManager && typeof apiManager.closePanel === 'function') {
      apiManager.closePanel();
    } else if (appContext.dom.apiSettingsPanel) { // Use appContext.dom reference
      appContext.dom.apiSettingsPanel.classList.remove('visible');
    }

    // REMOVE block for settingsManager and settingsMenu from here
    // if (settingsManager && typeof settingsManager.closePanel === 'function') {
    //   settingsManager.closePanel();
    // } else if (appContext.dom.settingsMenu) { 
    //   appContext.dom.settingsMenu.classList.remove('visible');
    // }
    
    // Fallback for any other panels by ID if not covered by services
    panelsToCloseDirectly.forEach(pid => {
      const panel = document.getElementById(pid);
      if (panel && panel.classList.contains('visible')) {
        // Check if a dedicated service method already handled it
        let handledByService = false;
        if (pid === 'prompt-settings' && promptSettingsManager?.closePanel) {
          handledByService = true; 
        } else if (pid === 'api-settings' && apiManager?.closePanel) {
          handledByService = true;
        } 
        // REMOVE: else if (pid === 'settings-menu' && settingsManager?.closePanel) { 
        //   handledByService = true; 
        // }

        if (!handledByService) {
           // Corrected logic: only check for panels that are still in panelsToCloseDirectly
           // and are not handled by their specific service's closePanel method.
           if (panelsToCloseDirectly.includes(pid) && 
               !((pid === 'prompt-settings' && promptSettingsManager?.closePanel) || 
                 (pid === 'api-settings' && apiManager?.closePanel))) {
               panel.classList.remove('visible');
           }
        }
      }
    });
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
    // Remove or comment out the click listener if hover is the primary interaction
    /*
    if (dom.settingsButton && dom.settingsMenu) {
        dom.settingsButton.addEventListener('click', (e) => {
            e.stopPropagation(); 
            const isVisible = dom.settingsMenu.classList.contains('visible');
            if (isVisible) {
                closeExclusivePanels(); 
            } else {
                closeExclusivePanels();
                dom.settingsMenu.classList.add('visible');
                if (apiManager && typeof apiManager.renderFavoriteApis === 'function') {
                    apiManager.renderFavoriteApis();
                }
            }
        });
    }
    */

    // Hover behavior for settings menu
    if (dom.settingsButton && dom.settingsMenu) {
        const openSettingsMenu = () => {
            clearTimeout(settingsMenuTimeout);
            // Ensure other exclusive panels are closed before opening this one
            // Call a more targeted close if closeExclusivePanels is too broad for just hover
            // For now, assuming closeExclusivePanels handles this fine.
            const otherPanelsOpen = 
                (document.getElementById('chat-history-panel') && document.getElementById('chat-history-panel').classList.contains('visible')) ||
                (dom.apiSettingsPanel && dom.apiSettingsPanel.classList.contains('visible')) ||
                (dom.promptSettingsPanel && dom.promptSettingsPanel.classList.contains('visible'));

            if (otherPanelsOpen) {
                 closeExclusivePanels(); // Close others if they are open
            }

            dom.settingsMenu.classList.add('visible');
            if (apiManager && typeof apiManager.renderFavoriteApis === 'function') {
                apiManager.renderFavoriteApis();
            }
        };

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

    if (messageInput) {
        messageInput.addEventListener('focus', () => {
            closeExclusivePanels(); // Close panels when user focuses on input
        });
    }
  }

  /**
   * 设置面板切换事件监听器
   */
  function setupPanelEventListeners() {
    // Prompt Settings Panel Toggle
    if (promptSettingsToggle && promptSettingsManager && typeof promptSettingsManager.togglePanel === 'function') {
      promptSettingsToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        promptSettingsManager.togglePanel();
      });
    } else if (promptSettingsToggle && dom.promptSettingsPanel) { 
        promptSettingsToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasVisible = dom.promptSettingsPanel.classList.contains('visible');
            closeExclusivePanels();
            if (!wasVisible) {
                dom.promptSettingsPanel.classList.toggle('visible');
            }
        });
    }

    // API Settings Panel Toggle
    if (dom.apiSettingsToggle && apiManager && typeof apiManager.togglePanel === 'function') {
        dom.apiSettingsToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            apiManager.togglePanel();
        });
    } 

    // Chat History Panel Toggle
    if (dom.chatHistoryToggle && chatHistoryUI && typeof chatHistoryUI.toggleChatHistoryPanel === 'function') {
        dom.chatHistoryToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            chatHistoryUI.toggleChatHistoryPanel();
        });
    }

    // Collapse Sidebar Button
    if (collapseButton) {
        collapseButton.addEventListener('click', () => {
            window.parent.postMessage({
                type: 'CLOSE_SIDEBAR'
            }, '*');
        });
    }
  }

  /**
   * 添加聊天容器事件监听器
   */
  function setupChatContainerEventListeners() {
    // Scroll event for auto-scroll logic
    if (chatContainer && messageSender && typeof messageSender.setShouldAutoScroll === 'function') {
        chatContainer.addEventListener('wheel', (e) => {
          if (e.deltaY < 0) { // Scrolling up
            messageSender.setShouldAutoScroll(false);
          } else if (e.deltaY > 0) { // Scrolling down
            const threshold = 100; // Px from bottom to re-enable auto-scroll
            const distanceFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
            if (distanceFromBottom < threshold) {
              messageSender.setShouldAutoScroll(true);
            }
          }
        }, { passive: true });

        // Click event to disable auto-scroll
        chatContainer.addEventListener('click', (e) => {
          messageSender.setShouldAutoScroll(false);
        });
    }

    // Prevent default image click behavior in chat
    chatContainer.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG') {
        e.preventDefault();
        e.stopPropagation();
      }
    });
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
    setupPanelEventListeners();
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