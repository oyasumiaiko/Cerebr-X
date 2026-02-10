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
    const ALT_SCROLL_ANIMATION_MS = 110; // Alt+滚轮平滑动画时长（ms），兼顾 120Hz 下的顺滑与响应速度。
    let altScrollAnimRaf = null;
    let altScrollAnimStartAt = 0;
    let altScrollAnimFromTop = 0;
    let altScrollAnimFromLeft = 0;
    let altScrollAnimToTop = 0;
    let altScrollAnimToLeft = 0;
    let nestedAltScrollAnimRaf = null;
    let nestedAltScrollAnimStartAt = 0;
    let nestedAltScrollAnimFromTop = 0;
    let nestedAltScrollAnimFromLeft = 0;
    let nestedAltScrollAnimToTop = 0;
    let nestedAltScrollAnimToLeft = 0;
    let nestedAltScrollTarget = null;

    const clampNumber = (value, min, max) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return min;
      return Math.min(max, Math.max(min, numeric));
    };

    const stopAltScrollAnimation = () => {
      if (altScrollAnimRaf) {
        cancelAnimationFrame(altScrollAnimRaf);
        altScrollAnimRaf = null;
      }
      altScrollAnimStartAt = 0;
      const currentTop = Math.max(0, container.scrollTop || 0);
      const currentLeft = Math.max(0, container.scrollLeft || 0);
      altScrollAnimFromTop = currentTop;
      altScrollAnimFromLeft = currentLeft;
      altScrollAnimToTop = currentTop;
      altScrollAnimToLeft = currentLeft;
    };

    const stopNestedAltScrollAnimation = () => {
      if (nestedAltScrollAnimRaf) {
        cancelAnimationFrame(nestedAltScrollAnimRaf);
        nestedAltScrollAnimRaf = null;
      }
      nestedAltScrollAnimStartAt = 0;
      if (!nestedAltScrollTarget) return;
      const currentTop = Math.max(0, nestedAltScrollTarget.scrollTop || 0);
      const currentLeft = Math.max(0, nestedAltScrollTarget.scrollLeft || 0);
      nestedAltScrollAnimFromTop = currentTop;
      nestedAltScrollAnimFromLeft = currentLeft;
      nestedAltScrollAnimToTop = currentTop;
      nestedAltScrollAnimToLeft = currentLeft;
    };

    const runAltScrollAnimationFrame = (timestamp) => {
      if (!altScrollAnimRaf) return;
      if (!altScrollAnimStartAt) altScrollAnimStartAt = timestamp;
      const elapsed = timestamp - altScrollAnimStartAt;
      const progress = clampNumber(elapsed / ALT_SCROLL_ANIMATION_MS, 0, 1);
      // 使用缓出曲线，起步快、收尾稳，避免“黏滞感”。
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextTop = altScrollAnimFromTop + (altScrollAnimToTop - altScrollAnimFromTop) * eased;
      const nextLeft = altScrollAnimFromLeft + (altScrollAnimToLeft - altScrollAnimFromLeft) * eased;
      container.scrollTop = nextTop;
      container.scrollLeft = nextLeft;

      if (progress >= 1 || (Math.abs(altScrollAnimToTop - nextTop) < 0.5 && Math.abs(altScrollAnimToLeft - nextLeft) < 0.5)) {
        container.scrollTop = altScrollAnimToTop;
        container.scrollLeft = altScrollAnimToLeft;
        altScrollAnimRaf = null;
        altScrollAnimStartAt = 0;
        altScrollAnimFromTop = altScrollAnimToTop;
        altScrollAnimFromLeft = altScrollAnimToLeft;
        return;
      }

      altScrollAnimRaf = requestAnimationFrame(runAltScrollAnimationFrame);
    };

    const animateAltScrollBy = (deltaY, deltaX) => {
      const currentTop = Math.max(0, container.scrollTop || 0);
      const currentLeft = Math.max(0, container.scrollLeft || 0);
      const maxTop = Math.max(0, (container.scrollHeight || 0) - (container.clientHeight || 0));
      const maxLeft = Math.max(0, (container.scrollWidth || 0) - (container.clientWidth || 0));
      // 连续滚轮时以“当前计划终点”为基准累加，避免动画进行中丢输入。
      const baseTop = altScrollAnimRaf ? altScrollAnimToTop : currentTop;
      const baseLeft = altScrollAnimRaf ? altScrollAnimToLeft : currentLeft;
      const targetTop = clampNumber(baseTop + (Number.isFinite(deltaY) ? deltaY : 0), 0, maxTop);
      const targetLeft = clampNumber(baseLeft + (Number.isFinite(deltaX) ? deltaX : 0), 0, maxLeft);

      altScrollAnimFromTop = currentTop;
      altScrollAnimFromLeft = currentLeft;
      altScrollAnimToTop = targetTop;
      altScrollAnimToLeft = targetLeft;
      altScrollAnimStartAt = 0;
      if (!altScrollAnimRaf) {
        altScrollAnimRaf = requestAnimationFrame(runAltScrollAnimationFrame);
      }
      return targetTop;
    };

    const runNestedAltScrollAnimationFrame = (timestamp) => {
      const target = nestedAltScrollTarget;
      if (!nestedAltScrollAnimRaf || !target) return;
      if (!nestedAltScrollAnimStartAt) nestedAltScrollAnimStartAt = timestamp;
      const elapsed = timestamp - nestedAltScrollAnimStartAt;
      const progress = clampNumber(elapsed / ALT_SCROLL_ANIMATION_MS, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextTop = nestedAltScrollAnimFromTop + (nestedAltScrollAnimToTop - nestedAltScrollAnimFromTop) * eased;
      const nextLeft = nestedAltScrollAnimFromLeft + (nestedAltScrollAnimToLeft - nestedAltScrollAnimFromLeft) * eased;
      target.scrollTop = nextTop;
      target.scrollLeft = nextLeft;

      if (progress >= 1 || (Math.abs(nestedAltScrollAnimToTop - nextTop) < 0.5 && Math.abs(nestedAltScrollAnimToLeft - nextLeft) < 0.5)) {
        target.scrollTop = nestedAltScrollAnimToTop;
        target.scrollLeft = nestedAltScrollAnimToLeft;
        nestedAltScrollAnimRaf = null;
        nestedAltScrollAnimStartAt = 0;
        nestedAltScrollAnimFromTop = nestedAltScrollAnimToTop;
        nestedAltScrollAnimFromLeft = nestedAltScrollAnimToLeft;
        return;
      }

      nestedAltScrollAnimRaf = requestAnimationFrame(runNestedAltScrollAnimationFrame);
    };

    const animateNestedAltScrollBy = (target, deltaY, deltaX) => {
      if (!target) return 0;
      if (nestedAltScrollTarget !== target) {
        stopNestedAltScrollAnimation();
        nestedAltScrollTarget = target;
      }
      const currentTop = Math.max(0, target.scrollTop || 0);
      const currentLeft = Math.max(0, target.scrollLeft || 0);
      const maxTop = Math.max(0, (target.scrollHeight || 0) - (target.clientHeight || 0));
      const maxLeft = Math.max(0, (target.scrollWidth || 0) - (target.clientWidth || 0));
      const baseTop = nestedAltScrollAnimRaf ? nestedAltScrollAnimToTop : currentTop;
      const baseLeft = nestedAltScrollAnimRaf ? nestedAltScrollAnimToLeft : currentLeft;
      const targetTop = clampNumber(baseTop + (Number.isFinite(deltaY) ? deltaY : 0), 0, maxTop);
      const targetLeft = clampNumber(baseLeft + (Number.isFinite(deltaX) ? deltaX : 0), 0, maxLeft);

      nestedAltScrollAnimFromTop = currentTop;
      nestedAltScrollAnimFromLeft = currentLeft;
      nestedAltScrollAnimToTop = targetTop;
      nestedAltScrollAnimToLeft = targetLeft;
      nestedAltScrollAnimStartAt = 0;
      if (!nestedAltScrollAnimRaf) {
        nestedAltScrollAnimRaf = requestAnimationFrame(runNestedAltScrollAnimationFrame);
      }
      return targetTop;
    };

    /**
     * 将滚轮事件的 delta 值统一转换为像素单位
     * @param {number} value - 原始 delta 数值
     * @param {number} mode - deltaMode 常量
     * @param {HTMLElement} [targetElement=container] - 目标滚动容器
     * @returns {number} 像素值
     */
    const normalizeWheelDelta = (value, mode, targetElement = container) => {
      if (!value) return 0;
      if (mode === 1) { // DOM_DELTA_LINE
        const computedStyle = window.getComputedStyle(targetElement);
        const lineHeight = parseFloat(computedStyle.lineHeight);
        if (Number.isFinite(lineHeight)) {
          return value * lineHeight;
        }
        const fontSize = parseFloat(computedStyle.fontSize) || 16;
        return value * fontSize * 1.2;
      }
      if (mode === 2) { // DOM_DELTA_PAGE
        return value * targetElement.clientHeight;
      }
      return value;
    };

    const resolveAltWheelNestedScrollable = (eventTarget) => {
      if (!eventTarget || typeof eventTarget.closest !== 'function') return null;
      // 仅在划词气泡内启用该分流，避免影响主聊天区常规 Alt+滚轮行为。
      const bubbleHost = eventTarget.closest('.selection-thread-bubble');
      if (!bubbleHost) return null;
      let current = eventTarget instanceof Element ? eventTarget : eventTarget?.parentElement;
      while (current && current !== container) {
        const style = window.getComputedStyle(current);
        const overflowY = (style.overflowY || '').toLowerCase();
        const allowsScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
        const canScroll = (current.scrollHeight - current.clientHeight) > 1;
        if (allowsScroll && canScroll) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };

    // 按住 Alt 时使用加速滚动，提高浏览长对话的效率
    container.addEventListener('wheel', (e) => {
      const nestedScrollable = e.altKey ? resolveAltWheelNestedScrollable(e.target) : null;
      if (nestedScrollable) {
        // 在气泡预览内按 Alt+滚轮时，优先滚动气泡内部，不让主聊天容器抢滚动。
        e.preventDefault();
        const acceleratedDeltaY = normalizeWheelDelta(e.deltaY, e.deltaMode, nestedScrollable) * ALT_SCROLL_MULTIPLIER;
        const acceleratedDeltaX = normalizeWheelDelta(e.deltaX, e.deltaMode, nestedScrollable) * ALT_SCROLL_MULTIPLIER;
        animateNestedAltScrollBy(nestedScrollable, acceleratedDeltaY, acceleratedDeltaX);
        if (altScrollAnimRaf) {
          stopAltScrollAnimation();
        }
        messageSender.setShouldAutoScroll(false);
        return;
      }

      let effectiveDeltaY = e.deltaY;
      let projectedScrollTop = Math.max(0, container.scrollTop || 0);

      if (e.altKey) {
        e.preventDefault();
        const acceleratedDeltaY = normalizeWheelDelta(e.deltaY, e.deltaMode) * ALT_SCROLL_MULTIPLIER;
        const acceleratedDeltaX = normalizeWheelDelta(e.deltaX, e.deltaMode) * ALT_SCROLL_MULTIPLIER;

        stopNestedAltScrollAnimation();
        projectedScrollTop = animateAltScrollBy(acceleratedDeltaY, acceleratedDeltaX);
        effectiveDeltaY = acceleratedDeltaY || 0;
      } else {
        // 非 Alt 滚动接管时立即中断 Alt 动画，避免双通道滚动叠加。
        if (altScrollAnimRaf) {
          stopAltScrollAnimation();
        }
        if (nestedAltScrollAnimRaf) {
          stopNestedAltScrollAnimation();
        }
      }

      if (effectiveDeltaY < 0) {
        messageSender.setShouldAutoScroll(false);
        return;
      }

      if (effectiveDeltaY > 0) {
        const effectiveScrollTop = e.altKey ? projectedScrollTop : Math.max(0, container.scrollTop || 0);
        const distanceFromBottom = container.scrollHeight - effectiveScrollTop - container.clientHeight;
        if (distanceFromBottom < AUTO_SCROLL_THRESHOLD) {
          messageSender.setShouldAutoScroll(true);
        } else if (e.altKey) {
          messageSender.setShouldAutoScroll(false);
        }
      }
    }, { passive: false });

    container.addEventListener('mousedown', (e) => {
      stopAltScrollAnimation();
      stopNestedAltScrollAnimation();
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
