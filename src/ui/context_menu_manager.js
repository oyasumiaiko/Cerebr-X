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
 * @param {Object} options.chatHistory - 聊天历史数据对象
 * @param {HTMLElement} options.forkConversationButton - 创建分支对话按钮
 * @param {Function} options.createForkConversation - 创建分支对话函数
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
    sendMessage,
    chatHistory,
    forkConversationButton,
    createForkConversation
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

    // 只在最后一条消息时显示"重新生成"按钮
    const userMessages = Array.from(chatContainer.querySelectorAll('.user-message'));
    const aiMessages = Array.from(chatContainer.querySelectorAll('.ai-message'));
    const isLastMessage = (
      messageElement === userMessages[userMessages.length - 1] || 
      messageElement === aiMessages[aiMessages.length - 1]
    );
    regenerateButton.style.display = isLastMessage ? 'flex' : 'none';
    // 始终显示创建分支对话按钮，但只有在有足够消息时才可用
    if (forkConversationButton) {
      const messageCount = chatContainer.querySelectorAll('.message').length;
      if (messageCount > 1) {
        forkConversationButton.style.display = 'flex';
        forkConversationButton.classList.remove('disabled');
      } else {
        forkConversationButton.style.display = 'flex';
        forkConversationButton.classList.add('disabled');
      }
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
    // 获取所有消息
    const messages = chatContainer.querySelectorAll('.message');
    if (messages.length > 0) {
      // 先找到最后一条用户消息和可能存在的AI回复
      let lastUserMessage = null;
      let lastAiMessage = null;
      
      // 从后向前遍历找到最后一对消息
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].classList.contains('ai-message') && !lastAiMessage) {
          lastAiMessage = messages[i];
        } else if (messages[i].classList.contains('user-message') && !lastUserMessage) {
          lastUserMessage = messages[i];
          break; // 找到最后一条用户消息后停止
        }
      }
      
      // 如果有AI消息，先删除它
      if (lastAiMessage) {
        await deleteMessageContent(lastAiMessage);
      }
      
      // 如果找到了用户消息，直接使用它重新生成AI回复
      if (lastUserMessage) {
        try {
          // 获取消息ID和原始文本
          const messageId = lastUserMessage.getAttribute('data-message-id');
          const originalMessageText = lastUserMessage.getAttribute('data-original-text');
          
          if (!messageId || !chatHistory?.messages) {
            console.error('未找到消息ID或聊天历史');
            return;
          }
          
          // 从聊天历史中找到对应消息节点
          const messageNode = chatHistory.messages.find(msg => msg.id === messageId);
          
          if (!messageNode) {
            console.error('在聊天历史中未找到对应消息');
            return;
          }

          // 使用regenerateMode标志告诉message_sender这是重新生成操作
          sendMessage({
            originalMessageText,
            regenerateMode: true,
            messageId
          });
        } catch (err) {
          console.error('准备重新生成消息时出错:', err);
        }
      }
      
      hideContextMenu();
    }
  }

  /**
   * 创建分支对话
   * 截取从开始到当前选中消息的对话，创建一个新的会话
   */
  function forkConversation() {
    if (currentMessageElement) {
      const messageId = currentMessageElement.getAttribute('data-message-id');
      if (!messageId || !chatHistory || !chatHistory.messages) {
        console.error('无法创建分支对话: 缺少必要信息');
        hideContextMenu();
        return;
      }
      
      // 调用外部提供的创建分支函数
      createForkConversation(messageId);
      hideContextMenu();
    }
  }

  /**
   * 设置事件监听器
   */
  function setupEventListeners() {
    // 监听消息（用户或 AI）右键点击
    chatContainer.addEventListener('contextmenu', (e) => {
      // 检查是否有文本被选中
      const selectedText = window.getSelection().toString();
      
      // 如果有选中文本或按住了Ctrl、Shift或Alt键，则显示默认菜单
      if (selectedText || e.ctrlKey || e.shiftKey || e.altKey) {
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

    // 添加创建分支对话按钮点击事件
    if (forkConversationButton) {
      forkConversationButton.addEventListener('click', () => {
        if (!forkConversationButton.classList.contains('disabled')) {
          forkConversation();
        }
      });
    }

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
    forkConversation,
    getCurrentMessage: () => currentMessageElement
  };
} 