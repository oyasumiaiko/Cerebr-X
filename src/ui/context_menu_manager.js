/**
 * 上下文菜单管理模块
 * 负责处理消息和代码块的右键菜单功能
 */

/**
 * 创建上下文菜单管理器
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.contextMenu - 上下文菜单元素
 * @param {HTMLElement} appContext.dom.copyMessageButton - 复制消息按钮
 * @param {HTMLElement} appContext.dom.copyCodeButton - 复制代码按钮
 * @param {HTMLElement} appContext.dom.stopUpdateButton - 停止更新按钮
 * @param {HTMLElement} appContext.dom.regenerateButton - 重新生成按钮
 * @param {HTMLElement} appContext.dom.deleteMessageButton - 删除消息按钮
 * @param {HTMLElement} appContext.dom.clearChatContextButton - 清空聊天按钮
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {Function} appContext.services.messageSender.abortCurrentRequest - 中止当前请求函数
 * @param {Function} appContext.services.chatHistoryUI.deleteMessageFromUIAndHistory - 删除消息内容函数
 * @param {Function} appContext.services.chatHistoryUI.clearChatHistory - 清空聊天历史函数
 * @param {Function} appContext.services.messageSender.sendMessage - 发送消息函数
 * @param {Object} appContext.services.chatHistoryManager.chatHistory - 聊天历史数据对象
 * @param {HTMLElement} appContext.dom.forkConversationButton - 创建分支对话按钮
 * @param {Function} appContext.services.chatHistoryUI.createForkConversation - 创建分支对话函数
 * @returns {Object} 上下文菜单管理器实例
 */
export function createContextMenuManager(appContext) {
  // 解构配置选项
  const {
    dom,
    services,
    utils // 新增: 解构 utils
  } = appContext;

  // DOM elements from appContext.dom
  const contextMenu = dom.contextMenu;
  const copyMessageButton = dom.copyMessageButton;
  const copyCodeButton = dom.copyCodeButton;
  const stopUpdateButton = dom.stopUpdateButton;
  const regenerateButton = dom.regenerateButton;
  const deleteMessageButton = dom.deleteMessageButton;
  const clearChatContextButton = dom.clearChatContextButton;
  const chatContainer = dom.chatContainer;
  const forkConversationButton = dom.forkConversationButton;
  const copyAsImageButton = dom.copyAsImageButton; // Assuming it's in dom

  // Services from appContext.services
  const messageSender = services.messageSender;
  const chatHistoryUI = services.chatHistoryUI;
  const chatHistoryManager = services.chatHistoryManager;
  const chatHistory = chatHistoryManager.chatHistory; // The actual history data object

  // Private state
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
    stopUpdateButton.onclick = () => {
      if (messageSender) messageSender.abortCurrentRequest();
      hideContextMenu();
    };

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
          // 如果用户消息后面没有AI消息，也视为最后一条可操作消息
          if (!lastAiMessage && i === messages.length -1) {
            // No AI message after this user message, allow regenerate
          } else if (lastAiMessage && messages[i+1] !== lastAiMessage) {
            // User message found, but the AI message after it is not the *last* AI message overall.
            // This case implies we are not at the absolute end of convo, so reset lastAiMessage to ensure we only delete the one immediately following this user message if any.
            lastAiMessage = null; 
          }
          break; // 找到最后一条用户消息后停止
        }
      }
      
      // 如果有AI消息，先删除它 (ensure deleteMessageContent is from chatHistoryUI or similar)
      if (lastAiMessage) {
        if (chatHistoryUI && typeof chatHistoryUI.deleteMessageFromUIAndHistory === 'function') {
          await chatHistoryUI.deleteMessageFromUIAndHistory(lastAiMessage);
        } else {
          console.warn('deleteMessageFromUIAndHistory function not available on chatHistoryUI');
          lastAiMessage.remove(); // Fallback to just removing from DOM
        }
      }
      
      // 如果找到了用户消息，直接使用它重新生成AI回复
      if (lastUserMessage) {
        try {
          // 获取消息ID和原始文本
          const messageId = lastUserMessage.getAttribute('data-message-id');
          const originalMessageText = lastUserMessage.getAttribute('data-original-text');
          const imageHTML = lastUserMessage.querySelector('.image-previews-container')?.innerHTML || ''; // Get existing images if any
          
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
          messageSender.sendMessage({
            originalMessageText,
            imageHTML, // Pass image HTML if it should be part of regeneration
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
      chatHistoryUI.createForkConversation(messageId);
      hideContextMenu();
    }
  }

  /**
   * 将消息元素复制为图片并复制到剪贴板
   */
  async function copyMessageAsImage() {
    if (currentMessageElement) {
      try {
        // 显示加载状态
        const originalText = copyAsImageButton.innerHTML;
        copyAsImageButton.innerHTML = '<i class="far fa-spinner fa-spin"></i> 处理中...';

        // 移除临时添加内边距的代码
        // const originalPadding = currentMessageElement.style.padding;
        // currentMessageElement.style.padding = '15px'; 
        
        // --- 1. 使用 dom-to-image 生成原始 Canvas ---
        const originalCanvas = await domtoimage.toCanvas(currentMessageElement, {
          // 不指定背景色，尝试捕获实际背景
        });

        // --- 2. 创建带边距的新 Canvas ---
        const padding = 15; // 设置边距大小 (像素)
        const newWidth = originalCanvas.width + 2 * padding;
        const newHeight = originalCanvas.height + 2 * padding;

        const newCanvas = document.createElement('canvas');
        newCanvas.width = newWidth;
        newCanvas.height = newHeight;
        const ctx = newCanvas.getContext('2d');

        // --- 3. 填充新 Canvas 背景色 ---
        // 尝试获取元素的计算背景色，如果透明或无效，则默认为白色
        let bgColor = window.getComputedStyle(currentMessageElement).backgroundColor;
        if (!bgColor || bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') {
          bgColor = '#ffffff'; // 默认白色背景
        }
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, newWidth, newHeight);

        // --- 4. 将原始 Canvas 绘制到新 Canvas 中央 ---
        ctx.drawImage(originalCanvas, padding, padding);

        // --- 4.5. 强制去除 Alpha 通道 ---
        const imageData = ctx.getImageData(0, 0, newWidth, newHeight);
        const data = imageData.data; // Uint8ClampedArray [R, G, B, A, ...]
        for (let i = 0; i < data.length; i += 4) {
          data[i + 3] = 255; // 设置 Alpha 为 255 (完全不透明)
        }
        ctx.putImageData(imageData, 0, 0);
        // --- Alpha 处理结束 ---

        // --- 5. 将新 Canvas 转换为 Blob ---
        newCanvas.toBlob(async (blob) => {
          if (!blob) {
             console.error('Failed to convert canvas to Blob.');
             copyAsImageButton.innerHTML = '<i class="far fa-times"></i> 失败';
             setTimeout(() => {
               copyAsImageButton.innerHTML = '<i class="far fa-image"></i> 复制为图片'; 
               hideContextMenu();
             }, 1000);
             return;
          }
          // --- 6. 后续处理 Blob --- 
          try {
            // 使用Clipboard API复制图片
            await navigator.clipboard.write([
              new ClipboardItem({
                'image/png': blob
              })
            ]);
            
            // 显示成功提示
            copyAsImageButton.innerHTML = '<i class="far fa-check"></i> 已复制';
            setTimeout(() => {
              copyAsImageButton.innerHTML = originalText; // 恢复按钮原始文本
              hideContextMenu();
            }, 1000);
          } catch (err) {
            console.error('复制图片到剪贴板失败:', err);
            // 如果复制失败，提供下载选项
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `消息截图_${new Date().toISOString().replace(/:/g, '-')}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            copyAsImageButton.innerHTML = '<i class="far fa-download"></i> 已下载';
            setTimeout(() => {
              copyAsImageButton.innerHTML = originalText; // 恢复按钮原始文本
              hideContextMenu();
            }, 1000);
          }
          // --- Blob 处理结束 ---
        }, 'image/png'); // 指定输出格式

      } catch (err) {
        console.error('生成图片过程中出错:', err); 
        copyAsImageButton.innerHTML = '<i class="far fa-times"></i> 失败';
        setTimeout(() => {
          copyAsImageButton.innerHTML = '<i class="far fa-image"></i> 复制为图片'; 
          hideContextMenu();
        }, 1000);
      }
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
      if (currentMessageElement && utils && typeof utils.deleteMessageContent === 'function') {
        utils.deleteMessageContent(currentMessageElement);
      } else {
        console.error('删除消息功能不可用或消息元素未找到。');
      }
    });
    regenerateButton.addEventListener('click', regenerateMessage);
    clearChatContextButton.addEventListener('click', async () => {
      await clearChatHistory();
      hideContextMenu();
    });
    
    // 添加复制为图片按钮点击事件
    copyAsImageButton.addEventListener('click', copyMessageAsImage);

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
    copyMessageAsImage,
    regenerateMessage,
    forkConversation,
    getCurrentMessage: () => currentMessageElement
  };
} 