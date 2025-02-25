/**
 * 上下文菜单管理模块
 * 负责处理消息和代码块的右键菜单功能
 */

/**
 * 创建上下文菜单管理器
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.contextMenu - 上下文菜单元素
 * @param {HTMLElement} options.copyMessageButton - 复制消息按钮
 * @param {HTMLElement} options.copyCodeButton - 复制代码按钮
 * @param {HTMLElement} options.stopUpdateButton - 停止更新按钮
 * @param {HTMLElement} options.regenerateButton - 重新生成按钮
 * @param {HTMLElement} options.deleteMessageButton - 删除消息按钮
 * @param {HTMLElement} options.clearChatContextButton - 清空聊天按钮
 * @param {HTMLElement} options.chatContainer - 聊天容器元素
 * @param {Function} options.abortCurrentRequest - 中止当前请求函数
 * @param {Function} options.deleteMessageContent - 删除消息内容函数
 * @param {Function} options.clearChatHistory - 清空聊天历史函数
 * @param {Function} options.sendMessage - 发送消息函数
 * @returns {Object} 上下文菜单管理器实例
 */
export function createContextMenuManager(options) {
  // 解构配置选项
  const {
    contextMenu,
    copyMessageButton,
    copyCodeButton,
    stopUpdateButton,
    regenerateButton,
    deleteMessageButton,
    clearChatContextButton,
    chatContainer,
    abortCurrentRequest,
    deleteMessageContent,
    clearChatHistory,
    sendMessage
  } = options;

  // 私有状态
  let currentMessageElement = null;
  let currentCodeBlock = null;

  /**
   * 显示上下文菜单
   * @param {MouseEvent} e - 鼠标事件
   * @param {HTMLElement} messageElement - 消息元素
   */
  function showContextMenu(e, messageElement) {
    e.preventDefault();
    currentMessageElement = messageElement;

    // 设置菜单位置
    contextMenu.style.display = 'block';

    // 获取点击的代码块元素
    const codeBlock = e.target.closest('pre code');

    // 根据消息状态显示或隐藏停止更新按钮
    if (messageElement.classList.contains('updating')) {
      stopUpdateButton.style.display = 'flex';
    } else {
      stopUpdateButton.style.display = 'none';
    }

    // 根据是否点击代码块显示或隐藏复制代码按钮
    if (codeBlock) {
      copyCodeButton.style.display = 'flex';
      currentCodeBlock = codeBlock;
    } else {
      copyCodeButton.style.display = 'none';
      currentCodeBlock = null;
    }

    // 调整菜单位置，确保菜单不超出视口
    const menuWidth = contextMenu.offsetWidth;
    const menuHeight = contextMenu.offsetHeight;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight;
    }
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';

    // 只在右键点击最后一条用户消息时显示"重新生成"按钮
    if (messageElement.classList.contains('user-message')) {
      // 获取所有用户消息
      const userMessages = chatContainer.querySelectorAll('.user-message');
      if (userMessages.length > 0 && messageElement === userMessages[userMessages.length - 1]) {
        regenerateButton.style.display = 'flex';
      } else {
        regenerateButton.style.display = 'none';
      }
    } else {
      regenerateButton.style.display = 'none';
    }
  }

  /**
   * 隐藏上下文菜单
   */
  function hideContextMenu() {
    contextMenu.style.display = 'none';
    currentMessageElement = null;
  }

  /**
   * 复制消息内容
   */
  function copyMessageContent() {
    if (currentMessageElement) {
      // 获取存储的原始文本
      const originalText = currentMessageElement.getAttribute('data-original-text');
      navigator.clipboard.writeText(originalText).then(() => {
        hideContextMenu();
      }).catch(err => {
        console.error('复制失败:', err);
      });
    }
  }

  /**
   * 复制代码块内容
   */
  function copyCodeContent() {
    if (currentCodeBlock) {
      const codeContent = currentCodeBlock.textContent;
      navigator.clipboard.writeText(codeContent).then(() => {
        hideContextMenu();
      }).catch(err => {
        console.error('复制失败:', err);
      });
    }
  }

  /**
   * 重新生成消息
   */
  async function regenerateMessage() {
    const messages = chatContainer.querySelectorAll('.message');
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      // 如果最后一条消息是助手消息，则删除
      if (lastMessage.classList.contains('ai-message')) {
        await deleteMessageContent(lastMessage);
      }
      // 调用发送消息接口，重新生成助手回复
      sendMessage();
      hideContextMenu();
    }
  }

  /**
   * 设置事件监听器
   */
  function setupEventListeners() {
    // 监听消息（用户或 AI）右键点击
    chatContainer.addEventListener('contextmenu', (e) => {
      // 如果按住了Ctrl、Shift或Alt键，则显示默认菜单
      if (e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      // 允许用户和 AI 消息都触发右键菜单
      const messageElement = e.target.closest('.message');
      if (messageElement) {
        e.preventDefault();
        showContextMenu(e, messageElement);
      }
    });

    // 按钮点击处理
    copyMessageButton.addEventListener('click', copyMessageContent);
    copyCodeButton.addEventListener('click', copyCodeContent);
    stopUpdateButton.addEventListener('click', () => {
      abortCurrentRequest();
      hideContextMenu();
    });
    deleteMessageButton.addEventListener('click', () => {
      deleteMessageContent(currentMessageElement);
    });
    regenerateButton.addEventListener('click', regenerateMessage);
    clearChatContextButton.addEventListener('click', async () => {
      await clearChatHistory();
      hideContextMenu();
    });

    // 点击其他地方隐藏菜单
    document.addEventListener('click', (e) => {
      if (!contextMenu.contains(e.target)) {
        hideContextMenu();
      }
    });

    // 滚动时隐藏菜单
    chatContainer.addEventListener('scroll', hideContextMenu);
  }

  /**
   * 初始化上下文菜单管理器
   */
  function init() {
    setupEventListeners();
  }

  // 公开的API
  return {
    init,
    hideContextMenu,
    showContextMenu,
    copyMessageContent,
    copyCodeContent,
    regenerateMessage,
    getCurrentMessage: () => currentMessageElement
  };
} 