/**
 * 聊天历史界面管理模块 - 负责聊天历史的UI展示、交互和持久化
 * @module ChatHistoryUI
 */

import { 
  getAllConversationMetadata, 
  getAllConversations, 
  putConversation, 
  deleteConversation, 
  getConversationById,
  releaseConversationMemory,
  getDatabaseStats
} from '../storage/indexeddb_helper.js';

/**
 * 创建聊天历史UI管理器
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.chatContainer - 聊天容器元素
 * @param {HTMLElement} options.chatInputElement - 主聊天输入框元素
 * @param {Function} options.appendMessage - 添加消息的函数
 * @param {Object} options.chatHistory - 聊天历史管理器实例
 * @param {Function} options.clearHistory - 清空聊天历史的函数
 * @param {Function} options.getPrompts - 获取提示词配置的函数
 * @param {Function} options.createImageTag - 创建图片标签的函数
 * @param {Function} options.getCurrentConversationChain - 获取当前会话链的函数
 * @returns {Object} 聊天历史UI管理API
 */
export function createChatHistoryUI(options) {
  const {
    chatContainer,
    chatInputElement,
    appendMessage,
    chatHistory,
    clearHistory,
    getPrompts,
    createImageTag,
    getCurrentConversationChain
  } = options;

  let currentConversationId = null;
  let currentPageInfo = null;
  
  // 内存管理设置 - 始终启用
  let activeConversation = null;       // 当前活动的会话对象
  let maxLoadedConversations = 5;      // 最大加载到内存的会话数
  let loadedConversations = new Map(); // 已加载到内存的会话缓存
  let conversationUsageTimestamp = new Map(); // 记录会话最后使用时间
  
  // 缓存数据库统计信息
  let cachedDbStats = null;
  let lastStatsUpdateTime = 0;
  const STATS_CACHE_DURATION = 5 * 60 * 1000; // 5分钟更新一次统计数据

  // --- 置顶功能相关 ---
  const PINNED_STORAGE_KEY = 'pinnedConversationIds';

  /**
   * 获取已置顶的对话ID列表
   * @returns {Promise<string[]>} 置顶ID数组
   */
  async function getPinnedIds() {
    try {
      const result = await chrome.storage.sync.get([PINNED_STORAGE_KEY]);
      return result[PINNED_STORAGE_KEY] || [];
    } catch (error) {
      console.error('获取置顶 ID 失败:', error);
      return [];
    }
  }

  /**
   * 保存置顶对话ID列表
   * @param {string[]} ids - 要保存的置顶ID数组
   * @returns {Promise<void>}
   */
  async function setPinnedIds(ids) {
    try {
      await chrome.storage.sync.set({ [PINNED_STORAGE_KEY]: ids });
    } catch (error) {
      console.error('保存置顶 ID 失败:', error);
    }
  }

  /**
   * 置顶一个对话
   * @param {string} id - 要置顶的对话ID
   * @returns {Promise<void>}
   */
  async function pinConversation(id) {
    const pinnedIds = await getPinnedIds();
    if (!pinnedIds.includes(id)) {
      pinnedIds.push(id);
      await setPinnedIds(pinnedIds);
    }
  }

  /**
   * 取消置顶一个对话
   * @param {string} id - 要取消置顶的对话ID
   * @returns {Promise<void>}
   */
  async function unpinConversation(id) {
    let pinnedIds = await getPinnedIds();
    if (pinnedIds.includes(id)) {
      pinnedIds = pinnedIds.filter(pinnedId => pinnedId !== id);
      await setPinnedIds(pinnedIds);
    }
  }
  // --- 置顶功能结束 ---

  /**
   * 提取消息的纯文本内容
   * @param {Object} msg - 消息对象
   * @returns {string} 纯文本内容
   */
  function extractMessagePlainText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') {
      return msg.content.trim();
    } else if (Array.isArray(msg.content)) {
      return msg.content.map(part => part.type === 'image_url' ? '[图片]' : part.text?.trim() || '').join(' ');
    }
    return '';
  }

  /**
   * 保存或更新当前对话至持久存储
   * @param {boolean} [isUpdate=false] - 是否为更新操作
   * @returns {Promise<void>}
   */
  async function saveCurrentConversation(isUpdate = false) {
    if (chatHistory.messages.length === 0) return;
    const messages = chatHistory.messages.slice();
    const timestamps = messages.map(msg => msg.timestamp);
    const startTime = Math.min(...timestamps);
    const endTime = Math.max(...timestamps);

    // 提取第一条消息的纯文本内容
    const firstMessageTextContent = extractMessagePlainText(messages.find(msg => extractMessagePlainText(msg) !== ''));
    
    let summary = '';
    if (firstMessageTextContent) {
      // 使用 getPlainText 转换为字符串
      let content = firstMessageTextContent;
      const prompts = getPrompts();
      
      // 替换预设模板为模板名称
      const selectionPrompt = prompts.selection.prompt.split('<SELECTION>');
      const selectionPromptPrefix = selectionPrompt[0].trim();
      if (content.includes(selectionPromptPrefix)) {
        content = content.replace(selectionPromptPrefix, '[搜索]');
        if (selectionPrompt.length > 1) {
          content = content.replace(selectionPrompt[1], '');
        }
      }
      
      const queryPrompt = prompts.query.prompt.split('<SELECTION>');
      const queryPromptPrefix = queryPrompt[0].trim();
      if (content.includes(queryPromptPrefix)) {
        content = content.replace(queryPromptPrefix, '[解释]');
        if (queryPrompt.length > 1) {
          content = content.replace(queryPrompt[1], '');
        }
      }

      if (content.includes(prompts.pdf.prompt)) {
        content = content.replace(prompts.pdf.prompt, '[PDF总结]');
      }
      if (content.includes(prompts.summary.prompt)) {
        content = content.replace(prompts.summary.prompt, '[总结]');
      }
      if (content.includes(prompts.image.prompt)) {
        content = content.replace(prompts.image.prompt, '[解释图片]');
      }
      summary = content.substring(0, 50);
    }

    let urlToSave = '';
    let titleToSave = '';
    let summaryToSave = summary;
    
    // 如果是更新操作并且已存在记录，则固定使用首次保存的 url 和 title
    if (isUpdate && currentConversationId) {
      try {
        // 使用false参数，不加载完整内容，只获取元数据
        const existingConversation = await getConversationById(currentConversationId, false);
        if (existingConversation) {
          urlToSave = existingConversation.url || '';
          titleToSave = existingConversation.title || '';
          
          // 如果原有摘要存在，则保留原有摘要，避免覆盖用户手动重命名的摘要
          if (existingConversation.summary) {
            summaryToSave = existingConversation.summary;
          }
        }
      } catch (error) {
        console.error("获取会话记录失败:", error);
      }
    } else {
      // 如果是首次保存，使用当前页面信息
      urlToSave = currentPageInfo?.url || '';
      titleToSave = currentPageInfo?.title || '';
      
      console.log(`首次保存会话，使用当前页面信息: URL=${urlToSave}, 标题=${titleToSave}`);
    }

    const generateConversationId = () => `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const conversation = {
      id: isUpdate ? (currentConversationId || generateConversationId()) : generateConversationId(),
      url: urlToSave,
      title: titleToSave,
      startTime,
      endTime,
      messages,
      summary: summaryToSave,
      messageCount: messages.length
    };

    // 使用 IndexedDB 存储对话记录
    await putConversation(conversation);
    
    // 更新当前会话ID和活动会话
    currentConversationId = conversation.id;
    activeConversation = conversation;
    
    // 更新内存缓存
    updateConversationInCache(conversation);
    
    console.log(`已${isUpdate ? '更新' : '保存'}对话记录:`, conversation);
  }

  /**
   * 更新会话缓存
   * @param {Object} conversation - 会话对象
   */
  function updateConversationInCache(conversation) {
    // 更新会话缓存和使用时间戳
    loadedConversations.set(conversation.id, conversation);
    conversationUsageTimestamp.set(conversation.id, Date.now());
    
    // 如果已加载的会话超过最大限制，释放最久未使用的会话
    if (loadedConversations.size > maxLoadedConversations) {
      let oldestId = null;
      let oldestTime = Date.now();
      
      // 找出最久未使用的会话
      for (const [id, timestamp] of conversationUsageTimestamp.entries()) {
        // 跳过当前活动会话
        if (id === activeConversation?.id) continue;
        
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestId = id;
        }
      }
      
      // 释放最久未使用的会话内存
      if (oldestId) {
        const oldConversation = loadedConversations.get(oldestId);
        if (oldConversation) {
          // 释放内存但保留在缓存中的引用
          loadedConversations.set(oldestId, releaseConversationMemory(oldConversation));
          console.log(`释放会话内存: ${oldestId}`);
        }
      }
    }
  }

  /**
   * 从缓存获取会话，如果不在缓存中则从数据库加载
   * @param {string} conversationId - 会话ID 
   * @param {boolean} [forceReload=false] - 是否强制从数据库重新加载
   * @returns {Promise<Object>} 会话对象
   */
  async function getConversationFromCacheOrLoad(conversationId, forceReload = false) {
    if (forceReload || !loadedConversations.has(conversationId)) {
      // 从数据库加载并更新缓存
      const conversation = await getConversationById(conversationId);
      if (conversation) {
        updateConversationInCache(conversation);
      }
      return conversation;
    } else {
      // 从缓存获取并更新使用时间戳
      const conversation = loadedConversations.get(conversationId);
      conversationUsageTimestamp.set(conversationId, Date.now());
      
      // 检查是否需要从数据库加载完整内容
      if (conversation && conversation.messages && conversation.messages.some(msg => msg.contentRef && !msg.content)) {
        console.log(`从数据库加载部分内容: ${conversationId}`);
        const fullConversation = await getConversationById(conversationId);
        if (fullConversation) {
          updateConversationInCache(fullConversation);
        }
        return fullConversation;
      }
      
      return conversation;
    }
  }

  /**
   * 加载选中的对话记录到当前聊天窗口
   * @param {Object} conversation - 对话记录对象
   */
  async function loadConversationIntoChat(conversation) {
    // 如果传入的是简化版会话对象（可能只有id），则加载完整版
    let fullConversation = conversation;
    if (!conversation.messages || conversation.messages.length === 0) {
      fullConversation = await getConversationFromCacheOrLoad(conversation.id);
    }
    
    // 设置为当前活动会话
    activeConversation = fullConversation;
    
    // 清空当前聊天容器
    chatContainer.innerHTML = '';
    // 遍历对话中的每条消息并显示
    fullConversation.messages.forEach(msg => {
      const role = msg.role.toLowerCase() === 'assistant' ? 'ai' : msg.role;
      let messageElem = null;

      if (Array.isArray(msg.content)) {
        const imagesHTML = document.createElement('div');
        let textContent = '';

        msg.content.forEach(part => {
          if (part.type === 'text') {
            textContent = part.text;
          } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
            const imageTag = createImageTag(part.image_url.url, null);
            imagesHTML.appendChild(imageTag);
          }
        });

        messageElem = appendMessage(textContent, role, true, null, imagesHTML.innerHTML);
      } else {
        messageElem = appendMessage(msg.content, role, true);
      }
      
      messageElem.setAttribute('data-message-id', msg.id);
    });
    // 恢复加载的对话历史到聊天管理器
    chatHistory.messages = fullConversation.messages.slice();
    // 若存在消息，则设置第一条消息的 id 为根节点
    chatHistory.root = fullConversation.messages.length > 0 ? fullConversation.messages[0].id : null;
    // 将 currentNode 更新为最后一条消息的 id
    chatHistory.currentNode = fullConversation.messages.length > 0 ? fullConversation.messages[fullConversation.messages.length - 1].id : null;
    // 保存加载的对话记录ID，用于后续更新操作
    currentConversationId = fullConversation.id;
    
    // 通知消息发送器当前会话ID已更新
    if (window.cerebr && window.cerebr.messageSender) {
      window.cerebr.messageSender.setCurrentConversationId(currentConversationId);
    }

    // 滚动到底部
    requestAnimationFrame(() => {
      const aiMessages = chatContainer.querySelectorAll('.message.ai-message');
      if (aiMessages.length > 0) {
        const latestAiMessage = aiMessages[aiMessages.length - 1];
        const rect = latestAiMessage.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(latestAiMessage);
        const marginBottom = parseInt(computedStyle.marginBottom, 10);
        const scrollTop = latestAiMessage.offsetTop + rect.height - marginBottom;
        chatContainer.scrollTo({
          top: scrollTop,
          behavior: 'instant'
        });
      }
    });
  }

  /**
   * 清空聊天记录
   * @returns {Promise<void>}
   */
  async function clearChatHistory() {
    // 终止当前请求（若存在）
    if (window.cerebr && window.cerebr.messageSender && typeof window.cerebr.messageSender.abortCurrentRequest === 'function') {
      window.cerebr.messageSender.abortCurrentRequest();
    }
    // 如果有消息，等待保存完成
    if (chatHistory.messages.length > 0) {
      await saveCurrentConversation(true);
    }
    // 清空聊天容器和内存中的聊天记录
    chatContainer.innerHTML = '';
    clearHistory();
    // 重置当前会话ID，确保下次发送新消息创建新会话
    currentConversationId = null;
    activeConversation = null;
    
    // 通知消息发送器当前会话ID已重置
    if (window.cerebr && window.cerebr.messageSender) {
      window.cerebr.messageSender.setCurrentConversationId(null);
    }
  }

  /**
   * 格式化相对时间字符串
   * @param {Date} date - 日期对象
   * @returns {string} 相对时间描述，例如 "5分钟前"、"2小时前"、"3天前"
   */
  function formatRelativeTime(date) {
    const now = new Date();
    const diff = now - date; // 毫秒差
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  }

  /**
   * 根据日期生成分组标签
   * @param {Date} date - 日期对象
   * @returns {string} 分组标签，如 "今天"、"昨天"、"本周"、"上周"、"本月" 或 "YYYY年M月"
   */
  function getGroupLabel(date) {
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return "今天";
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "昨天";
    // 以星期一为一周起点
    const day = now.getDay(); // 0代表星期日
    const diffToMonday = (day === 0 ? 6 : day - 1);
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    if (date >= monday) return "本周";
    const lastMonday = new Date(monday);
    lastMonday.setDate(monday.getDate() - 7);
    if (date >= lastMonday) return "上周";
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
      return "本月";
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  /**
   * 检查聊天历史面板是否打开
   * @returns {boolean} 面板是否打开
   */
  function isChatHistoryPanelOpen() {
    const panel = document.getElementById('chat-history-panel');
    if (panel && panel.classList.contains('visible')) {
      return true;
    }
    return false;
  }

  /**
   * 统一关闭聊天记录面板的函数
   */
  function closeChatHistoryPanel() {
    const panel = document.getElementById('chat-history-panel');
    if (panel && panel.classList.contains('visible')) {
      panel.classList.remove('visible');
      panel.addEventListener('transitionend', function handler(e) {
        if (e.propertyName === 'opacity' && !panel.classList.contains('visible')) {
          panel.style.display = 'none';
          // 尝试将焦点设置回主输入框
          chatInputElement?.focus();
          panel.removeEventListener('transitionend', handler);
        }
      });
    }
  }

  /**
   * 切换聊天历史面板的显示状态
   */
  function toggleChatHistoryPanel() {
    if (isChatHistoryPanelOpen()) {
      closeChatHistoryPanel();
    } else {
      showChatHistoryPanel();
    }
  }

  /**
   * 显示聊天历史项的右键菜单
   * @param {MouseEvent} e - 右键事件
   * @param {string} conversationId - 对话记录ID
   */
  async function showChatHistoryItemContextMenu(e, conversationId) {
    e.preventDefault();
    // 如果已存在菜单，则删除
    const existingMenu = document.getElementById('chat-history-context-menu');
    if (existingMenu) {
      existingMenu.remove();
    }
    // 创建菜单容器
    const menu = document.createElement('div');
    menu.id = 'chat-history-context-menu';
    // 动态设置菜单位置
    menu.style.top = e.clientY + 'px';
    menu.style.left = e.clientX + 'px';
    // 添加 CSS 类，设置其他样式
    menu.classList.add('chat-history-context-menu');

    // --- 添加 置顶/取消置顶 选项 ---
    const pinnedIds = await getPinnedIds();
    const isPinned = pinnedIds.includes(conversationId);
    const pinToggleOption = document.createElement('div');
    pinToggleOption.textContent = isPinned ? '取消置顶' : '置顶';
    pinToggleOption.classList.add('chat-history-context-menu-option');
    pinToggleOption.addEventListener('click', async () => {
      if (isPinned) {
        await unpinConversation(conversationId);
      } else {
        await pinConversation(conversationId);
      }
      menu.remove();
      refreshChatHistory(); // 刷新列表以显示更新后的顺序
    });
    menu.appendChild(pinToggleOption); // 添加到菜单顶部
    // --- 置顶/取消置顶 选项结束 ---

    // 重命名选项
    const renameOption = document.createElement('div');
    renameOption.textContent = '重命名对话';
    renameOption.classList.add('chat-history-context-menu-option');
    renameOption.addEventListener('click', async () => {
      menu.remove(); // 先关闭菜单
      try {
        const conversation = await getConversationFromCacheOrLoad(conversationId);
        if (conversation) {
          const newName = window.prompt('请输入新的对话名称:', conversation.summary || '');
          if (newName !== null && newName.trim() !== '') { // 确保用户输入了内容且没有取消
            conversation.summary = newName.trim();
            await putConversation(conversation); // 保存更新
            updateConversationInCache(conversation); // 更新缓存
            refreshChatHistory(); // 刷新列表显示新名称
            
            // 可选：添加成功提示
            const notification = document.createElement('div');
            notification.className = 'notification';
            notification.textContent = '对话已重命名';
            document.body.appendChild(notification);
            setTimeout(() => {
              notification.classList.add('fade-out');
              setTimeout(() => notification.remove(), 500);
            }, 1500);
          }
        }
      } catch (error) {
        console.error('重命名对话失败:', error);
        // 可选：添加失败提示
        const notification = document.createElement('div');
        notification.className = 'notification error';
        notification.textContent = '重命名失败，请重试';
        document.body.appendChild(notification);
        setTimeout(() => {
          notification.classList.add('fade-out');
          setTimeout(() => notification.remove(), 500);
        }, 2000);
      }
    });
    menu.appendChild(renameOption); // 添加重命名选项

    // 复制聊天记录选项
    const copyOption = document.createElement('div');
    copyOption.textContent = '以 JSON 格式复制';
    copyOption.classList.add('chat-history-context-menu-option');

    copyOption.addEventListener('click', async () => {
      try {
        // 获取完整会话内容
        const conversation = await getConversationFromCacheOrLoad(conversationId);
        if (conversation) {
          // 创建用于复制的格式化数据
          const copyData = {
            id: conversation.id,
            title: conversation.title || '',
            url: conversation.url || '',
            startTime: new Date(conversation.startTime).toLocaleString(),
            endTime: new Date(conversation.endTime).toLocaleString(),
            messages: conversation.messages.map(msg => ({
              role: msg.role,
              content: msg.content,
              timestamp: new Date(msg.timestamp).toLocaleString()
            }))
          };
          
          // 转换为格式化的 JSON 字符串
          const jsonStr = JSON.stringify(copyData, null, 2);
          
          // 复制到剪贴板
          await navigator.clipboard.writeText(jsonStr);
          
          // 显示成功提示
          const notification = document.createElement('div');
          notification.className = 'notification';
          notification.textContent = '聊天记录已复制到剪贴板';
          document.body.appendChild(notification);
          
          // 2秒后删除通知
          setTimeout(() => {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 500);
          }, 2000);
        }
      } catch (error) {
        console.error('复制聊天记录失败:', error);
        // 显示错误提示
        const notification = document.createElement('div');
        notification.className = 'notification error';
        notification.textContent = '复制失败，请重试';
        document.body.appendChild(notification);
        
        setTimeout(() => {
          notification.classList.add('fade-out');
          setTimeout(() => notification.remove(), 500);
        }, 2000);
      }
      menu.remove();
    });

    // 删除选项
    const deleteOption = document.createElement('div');
    deleteOption.textContent = '删除聊天记录';
    deleteOption.classList.add('chat-history-context-menu-option');

    deleteOption.addEventListener('click', async () => {
      await deleteConversation(conversationId);
      menu.remove();

      // 从缓存中移除
      if (loadedConversations.has(conversationId)) {
        loadedConversations.delete(conversationId);
        conversationUsageTimestamp.delete(conversationId);
      }
      // 如果删除的是置顶对话，也从置顶列表中移除
      await unpinConversation(conversationId); 

      // 刷新聊天记录面板
      const panel = document.getElementById('chat-history-panel');
      if (panel) {
        const filterInput = panel.querySelector('input[type="text"]');
        loadConversationHistories(panel, filterInput ? filterInput.value : '');
      }
    });

    menu.appendChild(copyOption);
    menu.appendChild(deleteOption);
    document.body.appendChild(menu);

    // 点击其他地方时移除菜单
    document.addEventListener('click', function onDocClick() {
      if (menu.parentElement) {
        menu.remove();
      }
      document.removeEventListener('click', onDocClick);
    });
  }

  /**
   * Computes the scrollTop value based on whether the filter has changed.
   * @param {string} previousFilter - The previous filter keyword.
   * @param {string} currentFilter - The current filter keyword.
   * @param {number} currentScrollTop - The current scrollTop value.
   * @returns {number} Returns 0 if the filter has changed, otherwise returns currentScrollTop.
  */
  function computeScrollTop(previousFilter, currentFilter, currentScrollTop) {
    return previousFilter === currentFilter ? currentScrollTop : 0;
  }

  /**
   * 比较数值
   * @param {number} value - 要比较的值
   * @param {string} operator - 比较操作符 ('>', '<', '>=', '<=', '=', '==')
   * @param {number} threshold - 阈值
   * @returns {boolean} 比较结果
   */
  function compareCount(value, operator, threshold) {
    switch (operator) {
      case '>': return value > threshold;
      case '<': return value < threshold;
      case '>=': return value >= threshold;
      case '<=': return value <= threshold;
      case '=': // Fallthrough, treat '=' and '==' the same
      case '==': return value === threshold;
      default: return false;
    }
  }

  /**
   * 加载聊天历史记录列表
   * @param {HTMLElement} panel - 聊天历史面板元素
   * @param {string} filterText - 过滤文本
   */
  async function loadConversationHistories(panel, filterText) {
    // 设置当前的过滤条件标识
    panel.dataset.currentFilter = filterText;
    const listContainer = panel.querySelector('#chat-history-list');
    if (!listContainer) return;
    const oldFilter = panel.dataset.prevFilter || "";
    const currentScroll = listContainer.scrollTop || 0;
    const newScrollPos = computeScrollTop(oldFilter, filterText, currentScroll);
    panel.dataset.prevFilter = filterText;
    listContainer.innerHTML = '';
    
    // 解析筛选条件
    const countFilterMatch = filterText.trim().match(/^(>|>=|<|<=|=|==)\s*(\d+)$/);
    let isCountFilter = false;
    let countOperator = null;
    let countThreshold = 0;
    
    if (countFilterMatch) {
      isCountFilter = true;
      countOperator = countFilterMatch[1];
      countThreshold = parseInt(countFilterMatch[2], 10);
    }
    
    // 获取置顶 ID 列表
    const pinnedIds = await getPinnedIds();
    // 获取所有对话元数据
    const allHistoriesMeta = await getAllConversationMetadata();
    // 如果在获取过程中过滤条件已变化，则放弃本次结果
    if (panel.dataset.currentFilter !== filterText) return;

    let historiesToShow = [];
    let sourceHistories = allHistoriesMeta; // 默认使用所有元数据

    if (isCountFilter) {
      // 按数量筛选 - 先筛选再排序
      sourceHistories = allHistoriesMeta.filter(history => 
        compareCount(history.messageCount, countOperator, countThreshold)
      );
      
      if (sourceHistories.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.textContent = `没有消息数量 ${countOperator} ${countThreshold} 的聊天记录`;
        listContainer.appendChild(emptyMsg);
        listContainer.scrollTop = newScrollPos;
        return;
      }
      // 不需要文本高亮，清空 filterText
      filterText = ''; 

    } else if (filterText) {
      // 按文本筛选 - 需要加载完整内容，这个过程在下面处理
      // 注意：文本筛选会改变 sourceHistories 的内容和结构
      const lowerFilter = filterText.toLowerCase();
      const filteredHistories = [];
      
      // 显示加载指示器
      const loadingIndicator = document.createElement('div');
      loadingIndicator.textContent = '正在搜索...';
      loadingIndicator.className = 'search-loading-indicator';
      listContainer.appendChild(loadingIndicator);
      
      // 异步搜索每个会话
      for (const historyMeta of allHistoriesMeta) {
        // 先检查元数据是否匹配
        const url = (historyMeta.url || '').toLowerCase();
        const summary = (historyMeta.summary || '').toLowerCase();
        
        if (url.includes(lowerFilter) || summary.includes(lowerFilter)) {
          filteredHistories.push(historyMeta);
          continue;
        }
        
        // 如果元数据不匹配，则加载完整内容并搜索
        try {
          // 检查过滤条件是否仍然一致，若不一致则终止
          if (panel.dataset.currentFilter !== filterText) return;
          const fullConversation = await getConversationById(historyMeta.id);
          // 检查过滤条件是否仍然一致，若不一致则终止
          if (panel.dataset.currentFilter !== filterText) return;
          if (fullConversation) {
            const messagesContent = fullConversation.messages && fullConversation.messages.length
              ? fullConversation.messages.map(msg => {
                  if (typeof msg.content === 'string') return msg.content || '';
                  if (Array.isArray(msg.content)) {
                    return msg.content.map(part => part.type === 'text' ? part.text : '').join(' ');
                  }
                  return '';
                }).join(' ')
              : '';
              
            const lowerMessages = messagesContent.toLowerCase();
            if (lowerMessages.includes(lowerFilter)) {
              // 使用完整会话数据替换元数据，以便后续高亮显示snippet
              filteredHistories.push(fullConversation); 
              // 如果加载了完整内容，也更新缓存
              updateConversationInCache(fullConversation); 
            } else {
              // 释放内存
              if (fullConversation.id !== activeConversation?.id) {
                loadedConversations.delete(fullConversation.id);
                conversationUsageTimestamp.delete(fullConversation.id);
              }
            }
          }
        } catch (error) {
          console.error(`搜索会话 ${historyMeta.id} 失败:`, error);
        }
      }
      
      // 移除加载指示器
      loadingIndicator.remove();
      
      // 检查过滤条件是否仍然一致
      if (panel.dataset.currentFilter !== filterText) return;
      
      // 显示过滤结果
      if (filteredHistories.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.textContent = '没有匹配的聊天记录';
        listContainer.appendChild(emptyMsg);
        // Restore scroll position based on filter change
        listContainer.scrollTop = newScrollPos;
        return;
      }
      
      // 文本过滤后的结果作为源数据
      sourceHistories = filteredHistories; 
    }
    // --- 统一处理排序和显示 ---
    
    // 分离置顶和未置顶
    const pinnedHistories = [];
    const unpinnedHistories = [];
    // 创建一个映射以便快速查找置顶顺序
    const pinnedIndexMap = new Map(pinnedIds.map((id, index) => [id, index]));

    // 从 sourceHistories 中分离置顶和未置顶项
    sourceHistories.forEach(hist => {
      if (pinnedIds.includes(hist.id)) {
        pinnedHistories.push(hist);
      } else {
        unpinnedHistories.push(hist);
      }
    });

    // 分别排序
    const sortByTime = (a, b) => b.endTime - a.endTime;
    // 置顶列表按 pinnedIds 中的顺序排序
    pinnedHistories.sort((a, b) => {
      return (pinnedIndexMap.get(a.id) ?? Infinity) - (pinnedIndexMap.get(b.id) ?? Infinity);
    });

    // 对未置顶记录按时间排序
    unpinnedHistories.sort(sortByTime);

    // --- 更新显示逻辑 --- 
    listContainer.innerHTML = ''; // 清空容器准备重新渲染

    if (sourceHistories.length === 0 && !isCountFilter && !filterText.trim()) {
        const emptyMsg = document.createElement('div');
        emptyMsg.textContent = '暂无聊天记录';
        listContainer.appendChild(emptyMsg);
    } else if (sourceHistories.length > 0) {
        // --- 修改: 调用新的增量渲染函数 --- 
        renderListIncrementally(pinnedHistories, unpinnedHistories, filterText, listContainer, pinnedIds, newScrollPos);
    } 
    // else: 筛选后无结果的消息已在前面处理 (例如数量筛选或文本筛选无结果)
  }
  
  /**
   * 逐步渲染会话列表项，避免阻塞UI
   * @param {Array<Object>} pinnedHistories - 按置顶顺序排序的置顶对话数组
   * @param {Array<Object>} allTimeSortedHistories - 按时间排序的所有符合条件的对话数组
   * @param {string} filterText - 过滤文本 (仅用于文本高亮)
   * @param {HTMLElement} listContainer - 列表容器元素
   * @param {string[]} pinnedIds - 当前置顶的ID列表
   * @param {number} [scrollTopToRestore=0] - 需要恢复的滚动位置
   */
  async function renderListIncrementally(pinnedHistories, allTimeSortedHistories, filterText, listContainer, pinnedIds, scrollTopToRestore = 0) {
    listContainer.innerHTML = ''; // 清空容器
    const panel = listContainer.closest('#chat-history-panel'); // 获取父面板
    const BATCH_SIZE = 100; // 每次渲染的批次大小
    let renderedCount = 0;
    let currentGroupLabel = null;
    
    // 优先渲染置顶区域
    if (pinnedHistories.length > 0) {
      const pinnedHeader = document.createElement('div');
      pinnedHeader.className = 'chat-history-group-header pinned-header';
      pinnedHeader.textContent = '已置顶';
      listContainer.appendChild(pinnedHeader);
      
      for (let i = 0; i < pinnedHistories.length; i++) {
        renderConversationItem(pinnedHistories[i], filterText, listContainer, pinnedIds, true);
        renderedCount++;
        if (renderedCount % BATCH_SIZE === 0) {
          await new Promise(requestAnimationFrame); // 等待下一帧
        }
      }
    }
    
    // 渲染普通列表区域 (按日期分组)
    const groups = {};
    const groupLatestTime = {};
    allTimeSortedHistories.forEach(conv => {
      const convDate = new Date(conv.startTime);
      const groupLabel = getGroupLabel(convDate);
      if (!groups[groupLabel]) {
        groups[groupLabel] = [];
        groupLatestTime[groupLabel] = convDate.getTime();
      } else {
        groupLatestTime[groupLabel] = Math.max(groupLatestTime[groupLabel], convDate.getTime());
      }
      groups[groupLabel].push(conv);
    });
    
    const sortedGroupLabels = Object.keys(groups).sort((a, b) => groupLatestTime[b] - groupLatestTime[a]);
    
    for (const groupLabel of sortedGroupLabels) {
      // 检查是否需要添加分组标题
      if (currentGroupLabel !== groupLabel) {
        const groupHeader = document.createElement('div');
        groupHeader.className = 'chat-history-group-header';
        groupHeader.textContent = groupLabel;
        listContainer.appendChild(groupHeader);
        currentGroupLabel = groupLabel;
        // 渲染标题后也稍微等待一下
        await new Promise(requestAnimationFrame);
      }
      
      const groupItems = groups[groupLabel];
      for (let i = 0; i < groupItems.length; i++) {
        renderConversationItem(groupItems[i], filterText, listContainer, pinnedIds, false);
        renderedCount++;
        if (renderedCount % BATCH_SIZE === 0) {
          await new Promise(requestAnimationFrame); // 等待下一帧
        }
      }
    }
    
    // 处理完全没有记录的情况（包括筛选后没有）
    if (renderedCount === 0 && panel) { // 确保 panel 存在
       const filterInputValue = panel.querySelector('input[type="text"]')?.value || '';
       const countFilterMatch = filterInputValue.trim().match(/^(>|>=|<|<=|=|==)\s*(\d+)$/);
       const isTextFilter = filterInputValue && !countFilterMatch;
       const emptyMsg = document.createElement('div');

       if (isTextFilter) {
         emptyMsg.textContent = '没有匹配的聊天记录';
       } else if (countFilterMatch) {
         const operator = countFilterMatch[1];
         const threshold = countFilterMatch[2];
         emptyMsg.textContent = `没有消息数量 ${operator} ${threshold} 的聊天记录`;
       } else {
         emptyMsg.textContent = '暂无聊天记录';
       }
       listContainer.appendChild(emptyMsg);
    }
    
    // 确保滚动位置在渲染完成后恢复
    listContainer.scrollTop = scrollTopToRestore; 
  }

  /**
   * 获取数据库统计信息，优先使用缓存
   * @param {boolean} [forceUpdate=false] - 是否强制更新
   * @returns {Promise<Object>} 数据库统计信息
   */
  async function getDbStatsWithCache(forceUpdate = false) {
    const now = Date.now();
    if (forceUpdate || !cachedDbStats || (now - lastStatsUpdateTime > STATS_CACHE_DURATION)) {
      cachedDbStats = await getDatabaseStats();
      lastStatsUpdateTime = now;
    }
    return cachedDbStats;
  }
  
  /**
   * 渲染数据库统计信息面板
   * @param {Object} stats - 数据库统计数据
   * @returns {HTMLElement} 统计信息面板元素
   */
  function renderStatsPanel(stats) {
    const statsPanel = document.createElement('div');
    statsPanel.className = 'db-stats-panel';
    
    // 添加标题
    const header = document.createElement('div');
    header.className = 'db-stats-header';
    header.innerHTML = `
      <span class="db-stats-title">数据统计</span>
      <span class="db-stats-refresh" title="刷新统计数据">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 4v6h-6"></path>
          <path d="M1 20v-6h6"></path>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
          <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      </span>
    `;
    
    // 点击刷新按钮刷新统计数据
    const refreshBtn = header.querySelector('.db-stats-refresh');
    refreshBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const updatedStats = await getDbStatsWithCache(true);
      
      // 查找父级面板并更新
      const parentPanel = document.getElementById('chat-history-panel');
      if (parentPanel) {
        const oldStatsPanel = parentPanel.querySelector('.db-stats-panel');
        if (oldStatsPanel) {
          const newStatsPanel = renderStatsPanel(updatedStats);
          oldStatsPanel.replaceWith(newStatsPanel);
        }
      }
    });
    
    statsPanel.appendChild(header);
    
    // 创建内容区域 - 使用卡片布局
    const statsContent = document.createElement('div');
    statsContent.className = 'db-stats-content';
    
    // 第一行卡片：存储概览
    const overviewCard = document.createElement('div');
    overviewCard.className = 'db-stats-card overview-card';
    overviewCard.innerHTML = `
      <div class="db-stats-card-header">存储概览</div>
      <div class="db-stats-metrics">
        <div class="db-stats-metric">
          <div class="db-stats-metric-value highlight">${stats.totalSizeFormatted}</div>
          <div class="db-stats-metric-label">总存储大小</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.totalTextSizeFormatted}</div>
          <div class="db-stats-metric-label">文本数据</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.totalImageSizeFormatted}</div>
          <div class="db-stats-metric-label">图片数据</div>
        </div>
      </div>
    `;
    
    // 第二行卡片：聊天统计
    const chatStatsCard = document.createElement('div');
    chatStatsCard.className = 'db-stats-card chat-stats-card';
    chatStatsCard.innerHTML = `
      <div class="db-stats-card-header">聊天统计</div>
      <div class="db-stats-metrics">
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.conversationsCount}</div>
          <div class="db-stats-metric-label">会话总数</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.messagesCount}</div>
          <div class="db-stats-metric-label">消息总数</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.imageMessagesCount}</div>
          <div class="db-stats-metric-label">图片消息</div>
        </div>
      </div>
    `;
    
    // 第三行卡片：时间跨度
    const timeCard = document.createElement('div');
    timeCard.className = 'db-stats-card time-card';
    
    let timeContent = '<div class="db-stats-card-header">时间跨度</div>';
    
    if (stats.oldestMessageDate && stats.newestMessageDate) {
      const formatDate = (date) => {
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      };
      
      timeContent += `
        <div class="db-stats-metrics timeline">
          <div class="db-stats-metric">
            <div class="db-stats-metric-value">${formatDate(stats.oldestMessageDate)}</div>
            <div class="db-stats-metric-label">最早消息</div>
          </div>
          <div class="db-stats-metric time-span">
            <div class="db-stats-metric-value">${stats.timeSpanDays} 天</div>
            <div class="db-stats-metric-label">总时长</div>
          </div>
          <div class="db-stats-metric">
            <div class="db-stats-metric-value">${formatDate(stats.newestMessageDate)}</div>
            <div class="db-stats-metric-label">最新消息</div>
          </div>
        </div>
      `;
    } else {
      timeContent += `
        <div class="db-stats-empty">
          <div class="db-stats-empty-text">暂无消息数据</div>
        </div>
      `;
    }
    
    timeCard.innerHTML = timeContent;
    
    // 第四行卡片：技术信息
    const techCard = document.createElement('div');
    techCard.className = 'db-stats-card tech-card';
    techCard.innerHTML = `
      <div class="db-stats-card-header">技术指标</div>
      <div class="db-stats-metrics tech-metrics">
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.largestMessageSizeFormatted}</div>
          <div class="db-stats-metric-label">最大消息</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.messageContentRefsCount}</div>
          <div class="db-stats-metric-label">分离存储数</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${loadedConversations.size}</div>
          <div class="db-stats-metric-label">内存缓存数</div>
        </div>
      </div>
    `;
    
    // 添加所有卡片到内容区域
    statsContent.appendChild(overviewCard);
    statsContent.appendChild(chatStatsCard);
    statsContent.appendChild(timeCard);
    statsContent.appendChild(techCard);
    
    // 添加饼图显示数据比例
    if (stats.totalTextSize > 0 || stats.totalImageSize > 0) {
      const chartContainer = document.createElement('div');
      chartContainer.className = 'db-stats-chart-container';
      
      const totalSize = stats.totalTextSize + stats.totalImageSize;
      const textPercentage = Math.round((stats.totalTextSize / totalSize) * 100);
      const imagePercentage = 100 - textPercentage;
      
      chartContainer.innerHTML = `
        <div class="db-stats-chart">
          <svg viewBox="0 0 36 36" class="circular-chart">
            <path class="circle-bg" d="M18 2.0845
              a 15.9155 15.9155 0 0 1 0 31.831
              a 15.9155 15.9155 0 0 1 0 -31.831"></path>
            <path class="circle image-data" stroke-dasharray="${imagePercentage}, 100" d="M18 2.0845
              a 15.9155 15.9155 0 0 1 0 31.831
              a 15.9155 15.9155 0 0 1 0 -31.831"></path>
            <path class="circle text-data" stroke-dasharray="${textPercentage}, 100" stroke-dashoffset="-${imagePercentage}" d="M18 2.0845
              a 15.9155 15.9155 0 0 1 0 31.831
              a 15.9155 15.9155 0 0 1 0 -31.831"></path>
            <text x="18" y="20.35" class="percentage">${textPercentage}%</text>
          </svg>
          <div class="chart-legend">
            <div class="legend-item">
              <span class="legend-color text-color"></span>
              <span class="legend-label">文本 (${textPercentage}%)</span>
            </div>
            <div class="legend-item">
              <span class="legend-color image-color"></span>
              <span class="legend-label">图片 (${imagePercentage}%)</span>
            </div>
          </div>
        </div>
      `;
      
      statsContent.appendChild(chartContainer);
    }
    
    statsPanel.appendChild(statsContent);
    
    // 添加更新时间戳
    const footer = document.createElement('div');
    footer.className = 'db-stats-footer';
    footer.innerHTML = `
      <div class="db-stats-update-time">
        最后更新: ${new Date(lastStatsUpdateTime).toLocaleTimeString()}
      </div>
    `;
    statsPanel.appendChild(footer);
    
    return statsPanel;
  }

  /**
   * 显示聊天记录面板
   */
  async function showChatHistoryPanel() {
    let panel = document.getElementById('chat-history-panel');
    let filterInput; // 在外部声明 filterInput 以便在函数末尾访问

    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'chat-history-panel';

      // 添加标题栏
      const header = document.createElement('div');
      header.className = 'panel-header';

      const title = document.createElement('span');
      title.textContent = '聊天记录';
      title.className = 'panel-title';

      // 创建按钮容器
      const headerActions = document.createElement('div');
      headerActions.className = 'header-actions';

      const refreshButton = document.createElement('button');
      refreshButton.textContent = '刷新';
      refreshButton.addEventListener('click', refreshChatHistory);

      const backupButton = document.createElement('button');
      backupButton.textContent = '备份';
      backupButton.addEventListener('click', backupConversations);

      const restoreButton = document.createElement('button');
      restoreButton.textContent = '还原';
      restoreButton.addEventListener('click', restoreConversations);

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '关闭';
      closeBtn.addEventListener('click', () => { closeChatHistoryPanel(); });

      headerActions.appendChild(refreshButton);
      headerActions.appendChild(backupButton);
      headerActions.appendChild(restoreButton);
      headerActions.appendChild(closeBtn);

      header.appendChild(title);
      header.appendChild(headerActions);
      panel.appendChild(header);

      // 创建标签切换栏
      const tabBar = document.createElement('div');
      tabBar.className = 'history-tab-bar';
      
      const historyTab = document.createElement('div');
      historyTab.className = 'history-tab active';
      historyTab.textContent = '聊天记录';
      historyTab.dataset.tab = 'history';
      
      const statsTab = document.createElement('div');
      statsTab.className = 'history-tab';
      statsTab.textContent = '数据统计';
      statsTab.dataset.tab = 'stats';
      
      tabBar.appendChild(historyTab);
      tabBar.appendChild(statsTab);
      panel.appendChild(tabBar);
      
      // 创建标签内容区域
      const tabContents = document.createElement('div');
      tabContents.className = 'history-tab-contents';
      
      // 聊天记录标签内容
      const historyContent = document.createElement('div');
      historyContent.className = 'history-tab-content active';
      historyContent.dataset.tab = 'history';
      
      // 域名筛选输入框
      const filterContainer = document.createElement('div');
      filterContainer.className = 'filter-container';
      filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.placeholder = '筛选文本 或 >10, <5, =20... (按 Enter 搜索)';
      
      // --- 修改开始：监听 keydown 事件 ---
      filterInput.addEventListener('keydown', (e) => {
        // 检查是否按下了 Enter 键
        if (e.key === 'Enter') {
          e.preventDefault(); // 阻止默认的回车行为（如表单提交）
          loadConversationHistories(panel, filterInput.value);
        }
      });
      filterContainer.appendChild(filterInput);
      
      // 新增清除按钮，放在搜索框右边
      const clearButton = document.createElement('button');
      clearButton.textContent = '清除';
      clearButton.className = 'clear-filter-btn';
      clearButton.style.marginLeft = '5px';
      clearButton.addEventListener('click', () => {
        filterInput.value = '';
        // 清除后也立即加载结果
        loadConversationHistories(panel, ''); 
        // 清除后将焦点设置回输入框
        filterInput.focus(); 
      });
      filterContainer.appendChild(clearButton);
      
      historyContent.appendChild(filterContainer);

      // 列表容器
      const listContainer = document.createElement('div');
      listContainer.id = 'chat-history-list';
      historyContent.appendChild(listContainer);
      
      // 统计数据标签内容
      const statsContent = document.createElement('div');
      statsContent.className = 'history-tab-content';
      statsContent.dataset.tab = 'stats';
      
      // 添加标签内容到容器
      tabContents.appendChild(historyContent);
      tabContents.appendChild(statsContent);
      panel.appendChild(tabContents);
      
      // 设置标签切换事件
      tabBar.addEventListener('click', (e) => {
        if (e.target.classList.contains('history-tab')) {
          // 移除所有标签和内容的active类
          tabBar.querySelectorAll('.history-tab').forEach(tab => tab.classList.remove('active'));
          tabContents.querySelectorAll('.history-tab-content').forEach(content => content.classList.remove('active'));
          
          // 给点击的标签和对应内容添加active类
          e.target.classList.add('active');
          const tabName = e.target.dataset.tab;
          const targetContent = tabContents.querySelector(`.history-tab-content[data-tab="${tabName}"]`);
          targetContent.classList.add('active');
          
          if (tabName === 'history') {
             // 切换到历史记录时，聚焦到筛选框
             requestAnimationFrame(() => filterInput?.focus());
          } else if (tabName === 'stats') {
            // 仅在切换到 'stats' 标签页时加载/更新统计信息
            const existingStatsPanel = targetContent.querySelector('.db-stats-panel');
            if (!existingStatsPanel) {
              const loadingIndicator = document.createElement('div');
              loadingIndicator.textContent = '正在加载统计数据...';
              targetContent.appendChild(loadingIndicator);
              
              getDbStatsWithCache().then(statsData => {
                loadingIndicator.remove();
                const statsPanel = renderStatsPanel(statsData);
                targetContent.appendChild(statsPanel);
              }).catch(error => {
                loadingIndicator.remove();
                console.error('加载统计数据失败:', error);
                targetContent.textContent = '加载统计数据失败';
              });
            } else {
              getDbStatsWithCache(true).then(updatedStats => {
                const newStatsPanel = renderStatsPanel(updatedStats);
                existingStatsPanel.replaceWith(newStatsPanel);
              }).catch(error => {
                console.error('更新统计数据失败:', error);
              });
            }
          }
        }
      });
      
      document.body.appendChild(panel);
    } else {
      // 如果面板已存在，获取 filterInput 引用
      filterInput = panel.querySelector('.filter-container input[type="text"]');
    }
    
    // 使用已有的筛选值加载历史记录
    const currentFilter = filterInput ? filterInput.value : '';
    loadConversationHistories(panel, currentFilter);
    panel.style.display = 'flex';
    void panel.offsetWidth;  
    panel.classList.add('visible');
    
    // --- 修改开始：打开面板后聚焦到 filterInput ---
    // 确保在 'history' 标签页激活时聚焦
    const activeTab = panel.querySelector('.history-tab.active');
    if (activeTab && activeTab.dataset.tab === 'history') {
      requestAnimationFrame(() => {
        filterInput?.focus();
        filterInput?.select(); // 可选：选中输入框内容方便修改
      });
    }
    // --- 修改结束 ---
  }

  /**
   * 刷新聊天记录面板
   */
  function refreshChatHistory() {
    const panel = document.getElementById('chat-history-panel');
    if (panel && panel.classList.contains('visible')) { // 仅当面板可见时刷新
      const filterInput = panel.querySelector('input[type="text"]');
      loadConversationHistories(panel, filterInput ? filterInput.value : '');
    }
  }

  /**
   * 备份所有对话记录
   * @returns {Promise<void>}
   */
  async function backupConversations() {
    try {
      // 使用加载所有会话的完整数据进行备份
      const allConversations = await getAllConversations();
      const jsonStr = JSON.stringify(allConversations, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      // 创建临时下载链接
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chat_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('备份失败:', error);
      alert('备份失败，请检查浏览器控制台。');
    }
  }

  /**
   * 从备份文件还原对话记录
   */
  function restoreConversations() {
    // 创建一个 file input 元素用于选择文件
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const backupData = JSON.parse(text);
        if (!Array.isArray(backupData)) {
          alert('备份文件格式不正确！');
          return;
        }
        let countAdded = 0;
        for (const conv of backupData) {
          try {
            const existing = await getConversationById(conv.id, false);
            if (!existing) {
              await putConversation(conv);
              countAdded++;
            }
          } catch (error) {
            console.error(`还原对话 ${conv.id} 时出错:`, error);
          }

        }
        alert(`还原完成，新增 ${countAdded} 条记录。`);
        // 刷新聊天记录面板
        refreshChatHistory();
      } catch (error) {
        console.error('读取备份文件失败:', error);
        alert('读取备份文件失败，请检查文件格式。');
      }
    });
    input.click();
  }

  /**
   * 更新当前页面信息
   * @param {Object} pageInfo - 页面信息对象
   */
  function updatePageInfo(pageInfo) {
    currentPageInfo = pageInfo;
  }
  
  /**
   * 清理内存缓存
   */
  function clearMemoryCache() {
    // 保留当前活动会话
    const activeId = activeConversation?.id;
    const activeConv = activeId ? loadedConversations.get(activeId) : null;
    
    // 清空缓存
    loadedConversations.clear();
    conversationUsageTimestamp.clear();
    
    // 恢复当前活动会话到缓存
    if (activeId && activeConv) {
      loadedConversations.set(activeId, activeConv);
      conversationUsageTimestamp.set(activeId, Date.now());
    }
    
    console.log('内存缓存已清理');
  }

  // 添加URL处理函数
  function getDisplayUrl(url) {
    try {
      if (!url) return '未知来源'; // 处理 null 或 undefined URL
      if (url.startsWith('file:///')) {
        // 解码URL并获取文件名
        const decodedUrl = decodeURIComponent(url);
        return decodedUrl.split(/[\\/]/).pop() || '本地文件'; // 兼容 Windows 和 Unix 路径     
      }
      // 非file协议，返回域名
      const urlObj = new URL(url);
      return urlObj.hostname || url; // 如果 hostname 为空，则返回原始 URL
    } catch (error) {
      console.warn('解析 URL 失败:', url, error); // 使用 warn 级别，因为它不一定是严重错误
      return url || '无效URL'; // 返回原始 URL 或提示
    }
  }

  /**
   * 创建分支对话
   * @param {string} targetMessageId - 目标消息ID，将截取从开始到该消息的对话
   * @returns {Promise<void>}
   */
  async function createForkConversation(targetMessageId) {
    if (!chatHistory || !chatHistory.messages || chatHistory.messages.length === 0) {
      console.error('创建分支对话失败: 没有可用的聊天历史');
      return;
    }

    try {
      // 先保存当前会话以确保所有更改都已保存
      await saveCurrentConversation(true);

      // 查找目标消息
      const targetMessage = chatHistory.messages.find(msg => msg.id === targetMessageId);
      if (!targetMessage) {
        console.error('创建分支对话失败: 找不到目标消息');
        return;
      }
      
      // 获取当前完整对话链
      const currentChain = getCurrentConversationChain();
      
      // 截取从开始到目标消息的对话
      const targetIndex = currentChain.findIndex(msg => msg.id === targetMessageId);
      if (targetIndex === -1) {
        console.error('创建分支对话失败: 目标消息不在当前对话链中');
        return;
      }
      
      // 保存当前对话的相关信息（页面信息等）
      const currentConvId = currentConversationId;
      let pageInfo = null;
      if (currentConvId) {
        const currentConversation = await getConversationFromCacheOrLoad(currentConvId);
        if (currentConversation) {
          pageInfo = {
            url: currentConversation.url,
            title: currentConversation.title
          };
        }
      }
      
      // 创建新的ChatHistory对象
      const newChatHistory = {
        messages: [],
        root: null,
        currentNode: null
      };
      
      // 复制截取的消息到新的ChatHistory
      let previousId = null;
      for (let i = 0; i <= targetIndex; i++) {
        const originalMsg = currentChain[i];
        const newMsg = {
          ...JSON.parse(JSON.stringify(originalMsg)), // 深拷贝
          id: `fork_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          parentId: previousId,
          children: []
        };
        
        if (previousId) {
          const parentMsg = newChatHistory.messages.find(m => m.id === previousId);
          if (parentMsg) {
            parentMsg.children.push(newMsg.id);
          }
        }
        
        if (i === 0) {
          newChatHistory.root = newMsg.id;
        }
        
        if (i === targetIndex) {
          newChatHistory.currentNode = newMsg.id;
        }
        
        previousId = newMsg.id;
        newChatHistory.messages.push(newMsg);
      }
      
      // 生成新的会话ID
      const newConversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // 计算开始和结束时间
      const timestamps = newChatHistory.messages.map(msg => msg.timestamp);
      const startTime = Math.min(...timestamps);
      const endTime = Math.max(...timestamps);
      
      // 提取第一条消息的纯文本内容作为摘要
      const firstMessage = newChatHistory.messages.find(msg => msg.role === 'user');
      const summary = firstMessage ? extractMessagePlainText(firstMessage).substring(0, 50) + ' (分支)' : '分支对话';
      
      // 创建新的会话对象
      const newConversation = {
        id: newConversationId,
        messages: newChatHistory.messages,
        summary: summary,
        startTime: startTime,
        endTime: endTime,
        title: pageInfo?.title || '',
        url: pageInfo?.url || '',
        currentNode: newChatHistory.currentNode,
        root: newChatHistory.root
      };
      
      // 保存新会话到数据库
      await putConversation(newConversation);
      
      // 清空当前会话并加载新创建的会话
      chatHistory.messages = [];
      chatHistory.root = null;
      chatHistory.currentNode = null;
      
      // 清空聊天容器
      chatContainer.innerHTML = '';
      
      // 加载新创建的会话
      await loadConversationIntoChat(newConversation);
      
      // 更新当前会话ID
      currentConversationId = newConversationId;
      
      // 通知消息发送器更新当前会话ID
      if (window.cerebr && window.cerebr.messageSender) {
        window.cerebr.messageSender.setCurrentConversationId(newConversationId);
      }
      
      console.log('成功创建分支对话:', newConversationId);
      
      // 提示用户操作成功
      const notification = document.createElement('div');
      notification.className = 'notification';
      notification.textContent = '已创建分支对话';
      document.body.appendChild(notification);
      
      // 2秒后删除通知
      setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => notification.remove(), 500);
      }, 2000);
      
    } catch (error) {
      console.error('创建分支对话失败:', error);
    }
  }

  /**
   * 渲染单个会话列表项
   * @param {Object} conv - 会话对象（可以是元数据或完整对象）
   * @param {string} filterText - 过滤文本 (仅用于文本高亮)
   * @param {HTMLElement} listContainer - 列表容器元素
   * @param {string[]} pinnedIds - 当前置顶的ID列表
   * @param {boolean} isDirectlyPinned - 该项是否是置顶项（用于跳过分组渲染逻辑）
   */
  function renderConversationItem(conv, filterText, listContainer, pinnedIds, isDirectlyPinned) {
    const item = document.createElement('div');
    item.className = 'chat-history-item';
    // 保存会话ID作为属性，便于后续加载
    item.setAttribute('data-id', conv.id);
    // 添加置顶状态类
    if (pinnedIds.includes(conv.id)) {
      item.classList.add('pinned');
    }

    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'summary';
    let displaySummary = conv.summary || '无摘要'; // 提供默认值
    // 只有在提供了 filterText 并且是文本过滤时才高亮摘要
    const isTextFilter = filterText && !filterText.trim().match(/^(>|>=|<|<=|=|==)\s*(\d+)$/);
    if (isTextFilter && displaySummary) {
      try {
        const escapedFilterForSummary = filterText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedFilterForSummary})`, 'gi');
        displaySummary = displaySummary.replace(regex, '<mark>$1</mark>');
      } catch (e) {
        console.error("高亮摘要时发生错误:", e); 
        // 保持原始摘要不变
      }
    }
    summaryDiv.innerHTML = displaySummary; // 使用 innerHTML 以便渲染 <mark>

    const infoDiv = document.createElement('div');
    infoDiv.className = 'info';
    const convDate = new Date(conv.startTime);
    const endTime = new Date(conv.endTime);
    const relativeTime = formatRelativeTime(convDate);
    const relativeEndTime = formatRelativeTime(endTime);

    // 使用新的URL处理函数
    const domain = getDisplayUrl(conv.url);
    let title = conv.title;

    const chatTimeSpan = relativeTime === relativeEndTime ? relativeTime : `${relativeTime} - ${relativeEndTime}`;
    const displayInfos = `${chatTimeSpan} · 消息数: ${conv.messageCount} · ${domain}`

    infoDiv.textContent = displayInfos;
    // 鼠标悬停显示具体的日期时间和完整URL
    const details = `开始: ${convDate.toLocaleString()} (${relativeTime})\n最新: ${endTime.toLocaleString()} (${relativeEndTime})\n${title}\n${conv.url}`.split('\n').filter(Boolean).join('\n');
    item.title = details;

    item.appendChild(summaryDiv);
    item.appendChild(infoDiv);

    // --- 修改开始：确保仅在文本过滤时才处理 snippet ---
    if (isTextFilter && conv.messages && Array.isArray(conv.messages)) {
      let snippets = [];
      let totalMatches = 0;
      // 对 filterText 进行转义，避免正则特殊字符问题
      const escapedFilter = filterText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lowerFilter = filterText.toLowerCase();
      
      // 预先构造用于高亮的正则对象，处理可能的正则错误
      let highlightRegex;
      try {
        highlightRegex = new RegExp(escapedFilter, 'gi');
      } catch (e) {
        console.error("创建高亮正则表达式失败:", e);
        highlightRegex = null; // 正则无效则不进行高亮
      }

      for (const msg of conv.messages) {
        const plainText = extractMessagePlainText(msg);
        if (plainText) {
          const content = plainText;
          const contentLower = content.toLowerCase();
          // 若当前消息中未包含关键字，则跳过
          if (contentLower.indexOf(lowerFilter) === -1) continue;
          
          let startIndex = 0;
          while (true) {
            const index = contentLower.indexOf(lowerFilter, startIndex);
            if (index === -1) break;
            totalMatches++;
            if (snippets.length < 5) {
              const snippetStart = Math.max(0, index - 30);
              const snippetEnd = Math.min(content.length, index + filterText.length + 30);
              let snippet = content.substring(snippetStart, snippetEnd);
              
              // 高亮 snippet 中所有匹配关键字
              if (highlightRegex) {
                 snippet = snippet.replace(highlightRegex, '<mark>$&</mark>');
              }
              
              // 使用 textContent 防止 XSS
              const snippetSpan = document.createElement('span');
              snippetSpan.innerHTML = `…${snippet}…`; // 渲染高亮
              snippets.push(snippetSpan);
            }
            startIndex = index + 1; 
          }
        }
      }
      
      if (snippets.length > 0) {
        const snippetDiv = document.createElement('div');
        snippetDiv.className = 'highlight-snippet';
        snippets.forEach((span, index) => {
          snippetDiv.appendChild(span);
          if (index < snippets.length - 1) {
            snippetDiv.appendChild(document.createElement('br'));
          }
        });
        if (totalMatches > snippets.length) {
          const moreMatchesSpan = document.createElement('span');
          moreMatchesSpan.textContent = `…… 共 ${totalMatches} 匹配`;
          snippetDiv.appendChild(document.createElement('br'));
          snippetDiv.appendChild(moreMatchesSpan);
        }
        item.appendChild(snippetDiv);
      }
    }

    // 添加聊天记录项的点击事件
    item.addEventListener('click', async () => {
      // 加载对话到聊天窗口
      const conversation = await getConversationFromCacheOrLoad(conv.id);
      if (conversation) {
        loadConversationIntoChat(conversation);
        // 加载对话后关闭历史面板
        // closeChatHistoryPanel(); 
      }
    });
    
    // 添加右键事件，显示删除菜单
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChatHistoryItemContextMenu(e, conv.id);
    });

    listContainer.appendChild(item);
  }

  return {
    saveCurrentConversation,
    loadConversationIntoChat,
    clearChatHistory,
    showChatHistoryPanel,
    closeChatHistoryPanel,
    toggleChatHistoryPanel,
    isChatHistoryPanelOpen,
    backupConversations,
    restoreConversations, 
    refreshChatHistory,
    updatePageInfo,
    getCurrentConversationId: () => currentConversationId,
    clearMemoryCache,
    createForkConversation
  };
} 