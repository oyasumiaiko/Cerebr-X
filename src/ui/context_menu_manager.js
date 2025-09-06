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
  const editMessageButton = document.getElementById('edit-message');

  // Services from appContext.services
  const messageSender = services.messageSender;
  const chatHistoryUI = services.chatHistoryUI;
  const chatHistoryManager = services.chatHistoryManager;
  const chatHistory = chatHistoryManager.chatHistory; // The actual history data object

  // Private state
  let currentMessageElement = null;
  let currentCodeBlock = null;
  let isEditing = false;

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
    // 除了当前消息为 updating 外，只要有任意 AI 消息处于 updating（包括“正在等待回复”的占位消息），也显示“停止更新”
    const anyUpdating = !!chatContainer.querySelector('.ai-message.updating, .loading-message.updating');
    if (messageElement.classList.contains('updating') || anyUpdating) {
      stopUpdateButton.style.display = 'flex';
    } else {
      stopUpdateButton.style.display = 'none';
    }
    // 每次打开菜单时刷新 click 处理，保证调用最新的 messageSender.abortCurrentRequest()
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
      
      // 如果有AI消息，先删除它
      if (lastAiMessage) {
        await utils.deleteMessageContent(lastAiMessage);
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
          // 优先使用该提示词类型的偏好模型（若设置）
          const prompts = appContext.services.promptSettingsManager.getPrompts();
          let apiParam = 'follow_current';
          try {
            const promptType = appContext.services.messageProcessor.getPromptTypeFromContent(originalMessageText, prompts) || 'none';
            const modelPref = (prompts[promptType]?.model || '').trim();
            apiParam = modelPref || 'follow_current';
          } catch (_) { apiParam = 'follow_current'; }

          messageSender.sendMessage({
            originalMessageText,
            imageHTML, // Pass image HTML if it should be part of regeneration
            regenerateMode: true,
            messageId,
            api: apiParam
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
    // 重新编辑消息
    editMessageButton.addEventListener('click', () => {
      if (!currentMessageElement || isEditing) return;
      startInlineEdit(currentMessageElement);
      hideContextMenu();
    });
    // 修复：使用 messageSender.abortCurrentRequest()，避免未定义的 abortCurrentRequest 引发错误
    stopUpdateButton.addEventListener('click', () => {
      if (messageSender) messageSender.abortCurrentRequest();
      hideContextMenu();
    });
    deleteMessageButton.addEventListener('click', () => {
      if (currentMessageElement) {
        utils.deleteMessageContent(currentMessageElement);
      } else {
        console.error('消息元素未找到。');
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
   * 开始就地编辑消息
   * @param {HTMLElement} messageElement
   */
  function startInlineEdit(messageElement) {
    const messageId = messageElement.getAttribute('data-message-id');
    if (!messageId) return;
    isEditing = true;
    try { messageElement.classList.add('editing'); } catch (_) {}

    // 定义延迟定位函数：在DOM更新后再滚动，避免初算不准
    const scheduleScrollAfterSetup = () => {
      try {
        const container = chatContainer;
        if (!container || typeof messageElement.offsetTop !== 'number') return;
        requestAnimationFrame(() => {
          const topPadding = 12;
          const messageTop = messageElement.offsetTop;
          const desiredTop = Math.max(0, messageTop - topPadding);
          if (messageTop < container.scrollTop + topPadding) {
            container.scrollTo({ top: desiredTop, behavior: 'smooth' });
          }
        });
      } catch (e) { console.error('滚动消息到可视区域失败:', e); }
    };

    // 定位文本容器
    const textDiv = messageElement.querySelector('.text-content');
    if (!textDiv) { isEditing = false; return; }

    // 原始HTML和纯文本
    const originalHtml = textDiv.innerHTML;
    const originalText = messageElement.getAttribute('data-original-text') || textDiv.textContent || '';
    const imageContainerInMessage = messageElement.querySelector('.image-content');
    const originalImagesHTML = imageContainerInMessage ? imageContainerInMessage.innerHTML : '';
    // 委托删除图片（适配历史DOM中未绑定事件的删除按钮）
    const delegatedDeleteHandler = (e) => {
      const deleteBtn = e.target.closest && e.target.closest('.delete-btn');
      if (!deleteBtn) return;
      e.preventDefault();
      e.stopPropagation();
      const tag = deleteBtn.closest('.image-tag');
      if (tag) tag.remove();
    };

    // 记录变更前的原始消息尺寸（避免后续DOM修改影响测量）
    const originalMsgRect = messageElement.getBoundingClientRect();
    const originalMessageWidth = messageElement.clientWidth || Math.round(originalMsgRect.width) || 0;
    const originalMessageHeight = messageElement.offsetHeight || Math.round(originalMsgRect.height) || 0;

    // 构建编辑器容器
    const editorWrapper = document.createElement('div');
    editorWrapper.className = 'inline-editor-wrapper';

    const textarea = document.createElement('textarea');
    textarea.className = 'inline-editor-textarea';
    textarea.value = originalText;

    const actionBar = document.createElement('div');
    actionBar.className = 'inline-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'inline-editor-save';
    saveBtn.innerHTML = '<i class="far fa-check"></i><span>保存</span>';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'inline-editor-cancel';
    cancelBtn.innerHTML = '<i class="far fa-times"></i><span>取消</span>';

    actionBar.appendChild(saveBtn);
    actionBar.appendChild(cancelBtn);
    editorWrapper.appendChild(textarea);
    editorWrapper.appendChild(actionBar);

    // 替换显示
    textDiv.style.display = 'none';
    messageElement.insertBefore(editorWrapper, textDiv.nextSibling);

    // 使用进入编辑前记录的 .message 尺寸设置编辑器大小（高度将被 CSS 的 min/max 约束）
    const baseWidth = Math.max(0, originalMessageWidth);
    const baseHeight = Math.max(0, originalMessageHeight);

    if (baseHeight > 0) {
      textarea.style.height = baseHeight + 'px';
    }
    textarea.style.overflow = 'auto';
    // 宽度：以原消息宽度为基准，并设置最小 70vw，上限 100%
    if (baseWidth > 0) {
      textarea.style.width = baseWidth + 'px';
    } else {
      textarea.style.width = '';
    }
    textarea.style.maxWidth = '100%';
    textarea.focus();
    // DOM完成后再定位，确保计算准确，并在顶部留出微小空隙
    scheduleScrollAfterSetup();
    // 确保编辑器自身从顶部开始显示，并将光标移动到开头
    setTimeout(() => {
      try {
        textarea.scrollTop = 0;
        if (typeof textarea.setSelectionRange === 'function') {
          textarea.setSelectionRange(0, 0);
        } else {
          textarea.selectionStart = 0;
          textarea.selectionEnd = 0;
        }
      } catch (_) {}
    }, 0);

    // 快捷键：Enter 保存，Shift+Enter 换行，Ctrl+Enter 保存并重新生成，Ctrl+S 保存，Ctrl+Q 取消
    textarea.addEventListener('keydown', async (e) => {
      const key = (e.key || '').toLowerCase();
      if (key === 'enter') {
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const newText = textarea.value;
          await applyInlineEdit(messageElement, messageId, newText);
          cleanup();
          await regenerateMessage();
        } else {
          saveBtn.click();
        }
      } else if ((e.ctrlKey || e.metaKey) && key === 's') {
        e.preventDefault();
        saveBtn.click();
      } else if ((e.ctrlKey || e.metaKey) && key === 'q') {
        e.preventDefault();
        cancelBtn.click();
      }
    });

    // 允许在编辑时通过粘贴添加图片
    textarea.addEventListener('paste', (e) => {
      try {
        const items = Array.from(e.clipboardData?.items || []);
        const imageItem = items.find(it => it.type && it.type.startsWith('image/'));
        if (!imageItem) return;
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          // 确保消息内存在图片容器
          let imgContainer = messageElement.querySelector('.image-content');
          if (!imgContainer) {
            imgContainer = document.createElement('div');
            imgContainer.className = 'image-content';
            messageElement.insertBefore(imgContainer, textDiv); // 放在文本上方
          }
          const tag = appContext.services.imageHandler.createImageTag(reader.result, file.name);
          imgContainer.appendChild(tag);
        };
        reader.readAsDataURL(file);
      } catch (err) {
        console.error('编辑时粘贴图片失败:', err);
      }
    });

    // 绑定事件
    try { messageElement.addEventListener('click', delegatedDeleteHandler); } catch (_) {}
    saveBtn.addEventListener('click', async () => {
      const newText = textarea.value;
      await applyInlineEdit(messageElement, messageId, newText);
      cleanup();
    });
    cancelBtn.addEventListener('click', () => {
      textDiv.style.display = '';
      editorWrapper.remove();
      // 还原图片区域
      try {
        const imgContainer = messageElement.querySelector('.image-content');
        if (imgContainer) {
          imgContainer.innerHTML = originalImagesHTML;
          // 重新绑定预览
          imgContainer.querySelectorAll('img').forEach(img => {
            img.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              appContext.services.imageHandler.showImagePreview(img.src);
            });
          });
        }
      } catch (e) { console.error('恢复图片区域失败:', e); }
      isEditing = false;
      try { messageElement.classList.remove('editing'); } catch (_) {}
      try { messageElement.removeEventListener('click', delegatedDeleteHandler); } catch (_) {}
    });

    function cleanup() {
      textDiv.style.display = '';
      editorWrapper.remove();
      isEditing = false;
      try { messageElement.classList.remove('editing'); } catch (_) {}
      try { messageElement.removeEventListener('click', delegatedDeleteHandler); } catch (_) {}
    }
  }

  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(400, textarea.scrollHeight) + 'px';
  }

  /**
   * 应用就地编辑结果：更新UI与历史
   */
  async function applyInlineEdit(messageElement, messageId, newText) {
    try {
      // 更新历史节点
      const node = chatHistory.messages.find(m => m.id === messageId);
      if (!node) { console.error('未找到消息历史节点'); return; }
      // 从 DOM 读取当前图片（允许在编辑过程中删除或添加）
      const currentImageTags = Array.from(messageElement.querySelectorAll('.image-content .image-tag'));
      const images = currentImageTags.map(tag => {
        const base64Data = tag.getAttribute('data-image') || tag.querySelector('img')?.src || '';
        return base64Data ? { type: 'image_url', image_url: { url: base64Data } } : null;
      }).filter(Boolean);

      if (Array.isArray(node.content)) {
        const hasText = typeof newText === 'string' && newText.trim() !== '';
        const newParts = [...images];
        if (hasText) {
          newParts.push({ type: 'text', text: newText });
        }
        node.content = newParts;
      } else {
        // 非数组：升级为多模态结构（根据当前图片与文本）
        const hasText = typeof newText === 'string' && newText.trim() !== '';
        if (images.length > 0) {
          node.content = hasText ? [...images, { type: 'text', text: newText }] : images;
        } else {
          node.content = newText;
        }
      }

      // 更新 DOM 显示
      const textDiv = messageElement.querySelector('.text-content');
      if (textDiv) {
        if (messageElement.classList.contains('user-message')) {
          // 用户消息：保持原始文本展示，不进行 Markdown 渲染
          textDiv.innerText = newText;
        } else {
          // AI 消息：使用 Markdown 渲染
          const processed = appContext.services.messageProcessor.processMathAndMarkdown(newText);
          textDiv.innerHTML = processed;
        }
      }
      // 存储原始文本以便复制功能
      messageElement.setAttribute('data-original-text', newText);

      // 保存会话
      await chatHistoryUI.saveCurrentConversation(true);
    } catch (e) {
      console.error('应用编辑结果失败:', e);
    }
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