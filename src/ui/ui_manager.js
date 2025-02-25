/**
 * UI管理模块
 * 负责管理用户界面元素的交互，如设置菜单、面板切换、输入处理等
 */

/**
 * 创建UI管理器
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.messageInput - 消息输入框元素
 * @param {HTMLElement} options.settingsButton - 设置按钮元素
 * @param {HTMLElement} options.settingsMenu - 设置菜单元素
 * @param {HTMLElement} options.chatContainer - 聊天容器元素
 * @param {HTMLElement} options.sendButton - 发送按钮元素
 * @param {HTMLElement} options.inputContainer - 输入容器元素
 * @param {HTMLElement} options.promptSettings - 提示词设置面板元素
 * @param {HTMLElement} options.promptSettingsToggle - 提示词设置开关元素
 * @param {HTMLElement} options.collapseButton - 收起按钮元素
 * @param {Object} options.chatHistoryUI - 聊天历史UI对象
 * @param {Object} options.imageHandler - 图片处理器对象
 * @param {Function} options.setShouldAutoScroll - 设置是否自动滚动的函数
 * @param {Function} options.renderFavoriteApis - 渲染收藏API列表的函数
 * @returns {Object} UI管理器实例
 */
export function createUIManager(options) {
  // 解构配置选项
  const {
    messageInput,
    settingsButton,
    settingsMenu,
    chatContainer,
    sendButton,
    inputContainer,
    promptSettings,
    promptSettingsToggle,
    collapseButton,
    chatHistoryUI,
    imageHandler,
    setShouldAutoScroll,
    renderFavoriteApis
  } = options;

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
   * 更新发送按钮状态
   */
  function updateSendButtonState() {
    const hasContent = messageInput.textContent.trim() || inputContainer.querySelector('.image-tag');
    sendButton.disabled = !hasContent;
  }

  /**
   * 设置菜单开关函数
   * @param {boolean|undefined} show - 是否显示菜单，不传则切换状态
   */
  function toggleSettingsMenu(show) {
    if (show === undefined) {
      // 如果没有传参数，就切换当前状态
      settingsMenu.classList.toggle('visible');
    } else {
      // 否则设置为指定状态
      if (show) {
        settingsMenu.classList.add('visible');
      } else {
        settingsMenu.classList.remove('visible');
      }
    }

    // 每次打开菜单时重新渲染收藏的API列表
    if (settingsMenu.classList.contains('visible') && renderFavoriteApis) {
      renderFavoriteApis();
    }
  }

  /**
   * 关闭互斥面板函数
   */
  function closeExclusivePanels() {
    // 定义需要互斥的面板ID列表
    const panels = ['api-settings', 'prompt-settings'];
    chatHistoryUI.closeChatHistoryPanel();
    panels.forEach(pid => {
      const panel = document.getElementById(pid);
      if (panel && panel.classList.contains('visible')) {
        panel.classList.remove('visible');
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
      e.preventDefault(); // 阻止默认粘贴行为

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
      } else {
        // 修改：处理纯文本粘贴，避免插入富文本
        const text = e.clipboardData.getData('text/plain');
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const textNode = document.createTextNode(text);
          range.insertNode(textNode);
          // 移动光标到新插入的文本节点之后
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    });

    // 修改拖放处理
    messageInput.addEventListener('drop', (e) => imageHandler.handleImageDrop(e, messageInput));
    chatContainer.addEventListener('drop', (e) => imageHandler.handleImageDrop(e, chatContainer));
  }

  /**
   * 设置设置菜单事件监听器
   */
  function setupSettingsMenuEventListeners() {
    // 修改点击事件监听器
    document.addEventListener('click', (e) => {
      // 如果点击的不是设置按钮本身和设置菜单，就关闭菜单
      if (!settingsButton.contains(e.target) && !settingsMenu.contains(e.target)) {
        toggleSettingsMenu(false);
      }
    });

    // 确保设置按钮的点击事件在文档点击事件之前处理
    settingsButton.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettingsMenu();
    });

    // 添加输入框的事件监听器
    messageInput.addEventListener('focus', () => {
      toggleSettingsMenu(false);
    });

    // 设置按钮悬停事件
    settingsButton.addEventListener('mouseenter', () => {
      toggleSettingsMenu(true);
    });

    // 设置按钮和菜单的鼠标离开事件
    const handleMouseLeave = (e) => {
      const toElement = e.relatedTarget;
      if (!settingsButton.contains(toElement) && !settingsMenu.contains(toElement)) {
        toggleSettingsMenu(false);
      }
    };

    settingsButton.addEventListener('mouseleave', handleMouseLeave);
    settingsMenu.addEventListener('mouseleave', handleMouseLeave);
  }

  /**
   * 设置面板切换事件监听器
   */
  function setupPanelEventListeners() {
    // 显示/隐藏提示词设置面板
    promptSettingsToggle.addEventListener('click', () => {
      const wasVisible = promptSettings.classList.contains('visible');
      closeExclusivePanels();

      if (!wasVisible) {
        promptSettings.classList.toggle('visible');
      }
    });

    // 添加收起按钮点击事件
    collapseButton.addEventListener('click', () => {
      window.parent.postMessage({
        type: 'CLOSE_SIDEBAR'
      }, '*');
    });
  }

  /**
   * 添加聊天容器事件监听器
   */
  function setupChatContainerEventListeners() {
    // 修改滚轮事件监听
    chatContainer.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) { // 向上滚动
        setShouldAutoScroll(false);
      } else if (e.deltaY > 0) { // 向下滚动时检查底部距离
        const threshold = 50; // 距离底部小于50px认为接近底部
        const distanceFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
        if (distanceFromBottom < threshold) {
          setShouldAutoScroll(true);
        }
      }
    });

    // 添加点击事件监听
    chatContainer.addEventListener('click', () => {
      // 聊天区域点击时让输入框失去焦点
      messageInput.blur();
    });

    // 阻止聊天区域的图片默认行为
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
    closeExclusivePanels
  };
} 