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
import { storageService } from '../utils/storage_service.js';

/**
 * 创建聊天历史UI管理器
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {HTMLElement} appContext.dom.messageInput - 主聊天输入框元素
 * @param {Function} appContext.services.messageProcessor.appendMessage - 添加消息的函数
 * @param {Object} appContext.services.chatHistoryManager.chatHistory - 聊天历史管理器实例
 * @param {Function} appContext.services.chatHistoryManager.clearHistory - 清空聊天历史的函数
 * @param {Function} appContext.services.promptSettingsManager.getPrompts - 获取提示词配置的函数
 * @param {Function} appContext.services.imageHandler.createImageTag - 创建图片标签的函数
 * @param {Function} appContext.services.chatHistoryManager.getCurrentConversationChain - 获取当前会话链的函数
 * @returns {Object} 聊天历史UI管理API
 */
export function createChatHistoryUI(appContext) {
  const {
    dom,
    services,
    state,
    utils
  } = appContext;

  // Destructure dependencies from appContext
  const chatContainer = dom.chatContainer;
  const chatInputElement = dom.messageInput; 
  const appendMessage = services.messageProcessor.appendMessage;
  
  // 修改: 直接使用 services.chatHistoryManager.chatHistory 访问数据对象
  // const chatHistory = services.chatHistoryManager.chatHistory; 
  // 修改: 直接使用 services.chatHistoryManager.clearHistory 访问清空函数
  // const clearHistory = services.chatHistoryManager.clearHistory;
  
  const promptSettingsManager = services.promptSettingsManager; 
  const createImageTag = services.imageHandler.createImageTag;
  // 修改: 直接使用 services.chatHistoryManager.getCurrentConversationChain 访问获取会话链函数
  // const getCurrentConversationChain = services.chatHistoryManager.getCurrentConversationChain;
  const showNotification = utils.showNotification;

  let currentConversationId = null;
  // let currentPageInfo = null; // Replaced by appContext.state.pageInfo or parameter to updatePageInfo
  
  // 内存管理设置 - 始终启用
  let activeConversation = null;       // 当前活动的会话对象
  let maxLoadedConversations = 5;      // 最大加载到内存的会话数
  let loadedConversations = new Map(); // 已加载到内存的会话缓存
  let conversationUsageTimestamp = new Map(); // 记录会话最后使用时间
  
  // 缓存数据库统计信息
  let cachedDbStats = null;
  let lastStatsUpdateTime = 0;
  const STATS_CACHE_DURATION = 5 * 60 * 1000; // 5分钟更新一次统计数据

  // --- 元数据缓存（UI层） ---
  let metaCache = { data: null, time: 0 };
  const META_CACHE_TTL = 30 * 1000; // 30秒缓存元数据，打开面板/轻度操作极速响应

  function invalidateMetadataCache() {
    metaCache.data = null;
    metaCache.time = 0;
  }

  async function getAllConversationMetadataWithCache(forceUpdate = false) {
    if (forceUpdate || !metaCache.data || (Date.now() - metaCache.time > META_CACHE_TTL)) {
      metaCache.data = await getAllConversationMetadata();
      metaCache.time = Date.now();
    }
    return metaCache.data;
  }

  // --- 任务令牌（运行ID）用于取消过期的加载流程 ---
  function createRunId() {
    return `run_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  // --- 面板样式注入 & 骨架屏与哨兵 ---
  let historyStylesInjected = false;
  function ensurePanelStylesInjected() {
    if (historyStylesInjected) return;
    const style = document.createElement('style');
    style.id = 'chat-history-enhanced-styles';
    style.textContent = `
#chat-history-list {
  content-visibility: auto;
  contain-intrinsic-size: 1000px 600px;
}
.skeleton-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color, #2a2a2a);
  animation: skeletonPulse 1.2s ease-in-out infinite;
}
.skeleton-title, .skeleton-sub {
  background: linear-gradient(90deg, rgba(180,180,180,0.08) 25%, rgba(255,255,255,0.18) 37%, rgba(180,180,180,0.08) 63%);
  background-size: 400% 100%;
  border-radius: 6px;
}
.skeleton-title { height: 14px; width: 70%; margin-bottom: 8px; }
.skeleton-sub { height: 10px; width: 45%; }
@keyframes skeletonPulse {
  0% { opacity: .7 }
  50% { opacity: 1 }
  100% { opacity: .7 }
}
.end-sentinel { height: 1px; width: 100%; }
`;
    document.head.appendChild(style);
    historyStylesInjected = true;
  }

  function renderSkeleton(container, count = 8) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton-item';
      sk.innerHTML = '<div class="skeleton-title"></div><div class="skeleton-sub"></div>';
      frag.appendChild(sk);
    }
    container.appendChild(frag);
  }

  function removeSkeleton(container) {
    container.querySelectorAll('.skeleton-item').forEach(n => n.remove());
  }

  function ensureEndSentinel(container) {
    let sentinel = container.querySelector('.end-sentinel');
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.className = 'end-sentinel';
      container.appendChild(sentinel);
    }
    return sentinel;
  }

  function setupEndSentinelObserver(panel, container, onIntersect, runId) {
    if (panel._ioObserver) {
      panel._ioObserver.disconnect();
    }
    const sentinel = ensureEndSentinel(container);
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry || !entry.isIntersecting) return;
      if (panel.dataset.runId !== runId) return;
      onIntersect();
    }, { root: container, rootMargin: '0px 0px 1000px 0px', threshold: 0.01 });
    observer.observe(sentinel);
    panel._ioObserver = observer;
  }

  function cleanupHistoryPanel(panel) {
    try {
      const listContainer = panel.querySelector('#chat-history-list');
      if (listContainer && listContainer._scrollListener) {
        listContainer.removeEventListener('scroll', listContainer._scrollListener);
        listContainer._scrollListener = null;
      }
      if (panel._ioObserver) {
        panel._ioObserver.disconnect();
        panel._ioObserver = null;
      }
      const menu = document.getElementById('chat-history-context-menu');
      if (menu) menu.remove();
      panel.dataset.runId = '';
    } catch (e) {
      console.warn('清理面板异常:', e);
    }
  }

  // --- Infinite Scroll/Batch Rendering State ---
  const BATCH_SIZE = 100; // 每批加载的项目数
  let currentDisplayItems = []; // 当前筛选和排序后的所有项目
  let currentlyRenderedCount = 0; // 已渲染的项目数量
  let isLoadingMoreItems = false; // 防止并发加载的标志
  let currentGroupLabelForBatchRender = null; // 用于跨批次跟踪组标签（针对未置顶项目）
  let currentPinnedItemsCountInDisplay = 0; // 当前显示列表中置顶项的数量，用于辅助分组逻辑

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
    if (services.chatHistoryManager.chatHistory.messages.length === 0) return;
    const messages = services.chatHistoryManager.chatHistory.messages.slice();
    const timestamps = messages.map(msg => msg.timestamp);
    const startTime = Math.min(...timestamps);
    const endTime = Math.max(...timestamps);

    // 提取第一条消息的纯文本内容
    const firstMessageTextContent = extractMessagePlainText(messages.find(msg => extractMessagePlainText(msg) !== ''));
    
    let summary = '';
    if (firstMessageTextContent) {
      // 使用 getPlainText 转换为字符串
      let content = firstMessageTextContent;
      const prompts = promptSettingsManager.getPrompts(); // New way: Call on instance
      
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
      // 如果是首次保存，使用当前页面信息 from appContext.state.pageInfo
      urlToSave = state.pageInfo?.url || '';
      titleToSave = state.pageInfo?.title || '';
      
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
    invalidateMetadataCache();
    
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
      const thoughtsToDisplay = msg.thoughtsRaw || null; // 获取思考过程文本

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
        // 调用 appendMessage 时传递 thoughtsToDisplay
        messageElem = appendMessage(textContent, role, true, null, imagesHTML.innerHTML, thoughtsToDisplay);
      } else {
        // 调用 appendMessage 时传递 thoughtsToDisplay
        messageElem = appendMessage(msg.content, role, true, null, null, thoughtsToDisplay);
      }
      
      messageElem.setAttribute('data-message-id', msg.id);
      // 渲染 API footer（按优先级：uuid->displayName->modelId）
      try {
        const footer = messageElem.querySelector('.api-footer') || (() => { const f = document.createElement('div'); f.className = 'api-footer'; messageElem.appendChild(f); return f; })();
        const allConfigs = appContext.services.apiManager.getAllConfigs?.() || [];
        let label = '';
        if (msg.apiUuid) {
          const cfg = allConfigs.find(c => c.id === msg.apiUuid);
          if (cfg && cfg.modelName) label = cfg.modelName;
        }
        if (!label) label = (msg.apiDisplayName || '').trim();
        if (!label) label = (msg.apiModelId || '').trim();
        footer.textContent = (role === 'ai') ? (label || '') : footer.textContent;
        footer.title = (role === 'ai') ? `API uuid: ${msg.apiUuid || '-'} | displayName: ${msg.apiDisplayName || '-'} | model: ${msg.apiModelId || '-'}` : footer.title;
      } catch (_) {}
    });
    // 恢复加载的对话历史到聊天管理器
    // 修改: 使用 services.chatHistoryManager.chatHistory 访问数据对象
    services.chatHistoryManager.chatHistory.messages = fullConversation.messages.slice();
    services.chatHistoryManager.chatHistory.root = fullConversation.messages.length > 0 ? fullConversation.messages[0].id : null;
    services.chatHistoryManager.chatHistory.currentNode = fullConversation.messages.length > 0 ? fullConversation.messages[fullConversation.messages.length - 1].id : null;
    // 保存加载的对话记录ID，用于后续更新操作
    currentConversationId = fullConversation.id;
    
    // 通知消息发送器当前会话ID已更新
    services.messageSender.setCurrentConversationId(currentConversationId);

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
    services.messageSender.abortCurrentRequest();
    // 如果有消息，等待保存完成
    // 修改: 使用 services.chatHistoryManager.chatHistory 访问消息
    if (services.chatHistoryManager.chatHistory.messages.length > 0) {
      await saveCurrentConversation(true);
    }
    // 清空聊天容器和内存中的聊天记录
    chatContainer.innerHTML = '';
    // 修改: 直接调用 services.chatHistoryManager.clearHistory()
    services.chatHistoryManager.clearHistory();
    // 重置当前会话ID，确保下次发送新消息创建新会话
    currentConversationId = null;
    activeConversation = null;
    
    // 通知消息发送器当前会话ID已重置
    services.messageSender.setCurrentConversationId(null);
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
          cleanupHistoryPanel(panel);
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
   * 显示聊天记录面板的右键菜单
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
    pinToggleOption.addEventListener('click', async (e) => {
      e.stopPropagation(); // <--- 添加阻止冒泡
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
    renameOption.addEventListener('click', async (e) => {
      e.stopPropagation(); // <--- 添加阻止冒泡
      menu.remove(); // 先关闭菜单
      try {
        const conversation = await getConversationFromCacheOrLoad(conversationId);
        if (conversation) {
          const newName = window.prompt('请输入新的对话名称:', conversation.summary || '');
          if (newName !== null && newName.trim() !== '') { // 确保用户输入了内容且没有取消
            conversation.summary = newName.trim();
            await putConversation(conversation); // 保存更新
            updateConversationInCache(conversation); // 更新缓存
            invalidateMetadataCache();
            refreshChatHistory(); // 刷新列表显示新名称
            
            showNotification({ message: '对话已重命名', duration: 1800 });
          }
        }
      } catch (error) {
        console.error('重命名对话失败:', error);
        // 可选：添加失败提示
        showNotification({ message: '重命名失败，请重试', type: 'error', duration: 2200 });
      }
    });
    menu.appendChild(renameOption); // 添加重命名选项

    // 复制聊天记录选项
    const copyOption = document.createElement('div');
    copyOption.textContent = '以 JSON 格式复制';
    copyOption.classList.add('chat-history-context-menu-option');

    copyOption.addEventListener('click', async (e) => {
      e.stopPropagation(); // <--- 添加阻止冒泡
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
          
          showNotification({ message: '聊天记录已复制到剪贴板', duration: 2000 });
        }
      } catch (error) {
        console.error('复制聊天记录失败:', error);
        // 显示错误提示
        showNotification({ message: '复制失败，请重试', type: 'error', duration: 2200 });
      }
      menu.remove();
    });

    // 删除选项
    const deleteOption = document.createElement('div');
    deleteOption.textContent = '删除聊天记录';
    deleteOption.classList.add('chat-history-context-menu-option');

    deleteOption.addEventListener('click', async (e) => {
      e.stopPropagation(); // <--- 添加阻止冒泡
      await deleteConversation(conversationId);
      invalidateMetadataCache();
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
    // 生成本次加载的 runId 并标记到面板，用于取消过期任务
    ensurePanelStylesInjected();
    const runId = createRunId();
    panel.dataset.currentFilter = filterText;
    panel.dataset.runId = runId;

    const listContainer = panel.querySelector('#chat-history-list');
    if (!listContainer) return;

    // 重置并显示骨架屏，立刻给到视觉反馈
    listContainer.innerHTML = '';
    listContainer.scrollTop = 0;
    renderSkeleton(listContainer, 8);

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

    const pinnedIds = await getPinnedIds();
    const allHistoriesMeta = await getAllConversationMetadataWithCache();
    // 任务可能已被新一轮加载替换
    if (panel.dataset.runId !== runId) return;

    let sourceHistories = [];
    let effectiveFilterTextForHighlight = filterText;

    if (isCountFilter) {
      sourceHistories = allHistoriesMeta.filter(history =>
        compareCount(history.messageCount, countOperator, countThreshold)
      );
      effectiveFilterTextForHighlight = '';
    } else if (filterText) {
      const lowerFilter = filterText.toLowerCase();
      const filteredResults = [];

      // 在列表容器顶部插入搜索进度指示器
      const searchProgressIndicator = document.createElement('div');
      searchProgressIndicator.className = 'search-loading-indicator';

      const filterBoxContainer = panel.querySelector('.filter-container');
      if (filterBoxContainer && filterBoxContainer.parentNode === listContainer.parentNode) {
        filterBoxContainer.insertAdjacentElement('afterend', searchProgressIndicator);
      } else {
        listContainer.insertBefore(searchProgressIndicator, listContainer.firstChild);
      }

      const BATCH_PROCESS_SIZE = 25;

      for (let i = 0; i < allHistoriesMeta.length; i++) {
        // 若当前任务已过期，立刻终止
        if (panel.dataset.runId !== runId) {
          if (searchProgressIndicator.parentNode) searchProgressIndicator.remove();
          return;
        }

        const historyMeta = allHistoriesMeta[i];
        const url = (historyMeta.url || '').toLowerCase();
        const summary = (historyMeta.summary || '').toLowerCase();

        let foundInMeta = false;
        if (url.includes(lowerFilter) || summary.includes(lowerFilter)) {
          filteredResults.push(historyMeta);
          foundInMeta = true;
        }

        if (!foundInMeta) {
          try {
            const fullConversation = await getConversationById(historyMeta.id);
            // await 之后再次核对任务是否仍然有效
            if (panel.dataset.runId !== runId) {
              if (searchProgressIndicator.parentNode) searchProgressIndicator.remove();
              return;
            }

            if (fullConversation) {
              const messagesContent = fullConversation.messages && fullConversation.messages.length
                ? fullConversation.messages.map(msg => extractMessagePlainText(msg) || '').join(' ')
                : '';
              const lowerMessages = messagesContent.toLowerCase();
              if (lowerMessages.includes(lowerFilter)) {
                filteredResults.push(fullConversation);
                updateConversationInCache(fullConversation);
              }
            }
          } catch (error) {
            console.error(`搜索会话 ${historyMeta.id} 失败:`, error);
          }
        }

        // 批次更新进度并让出主线程
        if ((i + 1) % BATCH_PROCESS_SIZE === 0 || i === allHistoriesMeta.length - 1) {
          const percentComplete = Math.round(((i + 1) / allHistoriesMeta.length) * 100);
          searchProgressIndicator.innerHTML = `
            <div class="search-progress">
              <div class="search-progress-text">正在搜索聊天记录... (${i+1}/${allHistoriesMeta.length})</div>
              <div class="search-progress-bar">
                <div class="search-progress-fill" style="width: ${percentComplete}%"></div>
              </div>
            </div>
          `;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      if (searchProgressIndicator.parentNode) searchProgressIndicator.remove();
      sourceHistories = filteredResults;
      // effectiveFilterTextForHighlight 保持为 filterText
    } else {
      sourceHistories = allHistoriesMeta;
      effectiveFilterTextForHighlight = '';
    }

    const pinnedItems = [];
    const unpinnedItems = [];
    const pinnedIndexMap = new Map(pinnedIds.map((id, index) => [id, index]));

    sourceHistories.forEach(hist => {
      if (pinnedIds.includes(hist.id)) {
        pinnedItems.push(hist);
      } else {
        unpinnedItems.push(hist);
      }
    });

    pinnedItems.sort((a, b) => (pinnedIndexMap.get(a.id) ?? Infinity) - (pinnedIndexMap.get(b.id) ?? Infinity));
    unpinnedItems.sort((a, b) => b.endTime - a.endTime);

    currentDisplayItems = [...pinnedItems, ...unpinnedItems];
    currentPinnedItemsCountInDisplay = pinnedItems.length;

    currentlyRenderedCount = 0;
    currentGroupLabelForBatchRender = null;
    isLoadingMoreItems = false;

    if (currentDisplayItems.length === 0) {
      removeSkeleton(listContainer);
      const emptyMsg = document.createElement('div');
      if (isCountFilter) {
        emptyMsg.textContent = `没有消息数量 ${countOperator} ${countThreshold} 的聊天记录`;
      } else if (filterText) {
        emptyMsg.textContent = '没有匹配的聊天记录';
      } else {
        emptyMsg.textContent = '暂无聊天记录';
      }
      listContainer.appendChild(emptyMsg);
      return;
    }

    if (pinnedItems.length > 0) {
      removeSkeleton(listContainer);
      const pinnedHeader = document.createElement('div');
      pinnedHeader.className = 'chat-history-group-header pinned-header';
      pinnedHeader.textContent = '已置顶';
      listContainer.appendChild(pinnedHeader);
    }

    // 首次加载批次
    await renderMoreItems(listContainer, pinnedIds, effectiveFilterTextForHighlight, panel.dataset.currentFilter, runId);

    // 使用 IntersectionObserver 进行后续批次加载
    setupEndSentinelObserver(panel, listContainer, async () => {
      if (panel.dataset.runId !== runId) return;
      await renderMoreItems(listContainer, pinnedIds, effectiveFilterTextForHighlight, panel.dataset.currentFilter, runId);
    }, runId);

    // Fallback：滚动监听，兼容拖动滚动条与键盘 End 场景
    if (listContainer._scrollListener) {
      listContainer.removeEventListener('scroll', listContainer._scrollListener);
    }
    listContainer._scrollListener = async () => {
      const panelNow = listContainer.closest('#chat-history-panel');
      if (!panelNow) return;
      if (panelNow.dataset.runId !== runId) return;
      if (!isLoadingMoreItems && (listContainer.scrollTop + listContainer.clientHeight >= listContainer.scrollHeight - 48)) {
        await renderMoreItems(listContainer, pinnedIds, effectiveFilterTextForHighlight, panel.dataset.currentFilter, runId);
      }
    };
    listContainer.addEventListener('scroll', listContainer._scrollListener);

    // 如果内容高度不足以填满视口，自动继续加载直至填满
    requestAnimationFrame(async () => {
      const panelNow = listContainer.closest('#chat-history-panel');
      if (!panelNow || panelNow.dataset.runId !== runId) return;
      while (listContainer.scrollHeight <= listContainer.clientHeight && currentlyRenderedCount < currentDisplayItems.length) {
        await renderMoreItems(listContainer, pinnedIds, effectiveFilterTextForHighlight, panel.dataset.currentFilter, runId);
        await new Promise(r => setTimeout(r, 0));
      }
    });
  }
  
  /**
   * 逐步渲染会话列表项到指定容器。此函数被 renderMoreItems 调用。
   * @param {Object} conv - 会话对象（可以是元数据或完整对象）
   * @param {string} filterText - 过滤文本 (仅用于文本高亮)
   * @param {boolean} isPinned - 该项是否是置顶项
   * @returns {HTMLElement} 创建的会话项元素
   */
  function createConversationItemElement(conv, filterText, isPinned) {
    const item = document.createElement('div');
    item.className = 'chat-history-item';
    item.setAttribute('data-id', conv.id);
    if (isPinned) {
      item.classList.add('pinned');
    }

    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'summary';
    let displaySummary = conv.summary || '无摘要';
    const isTextFilterActive = filterText && !filterText.trim().match(/^(>|>=|<|<=|=|==)\s*(\d+)$/);
    if (isTextFilterActive && displaySummary) {
      try {
        const escapedFilterForSummary = filterText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedFilterForSummary})`, 'gi');
        displaySummary = displaySummary.replace(regex, '<mark>$1</mark>');
      } catch (e) {
        console.error("高亮摘要时发生错误:", e);
      }
    }
    summaryDiv.innerHTML = displaySummary;

    const infoDiv = document.createElement('div');
    infoDiv.className = 'info';
    const convDate = new Date(conv.startTime);
    const endTime = new Date(conv.endTime);
    const relativeTime = formatRelativeTime(convDate);
    const relativeEndTime = formatRelativeTime(endTime);
    const domain = getDisplayUrl(conv.url);
    let title = conv.title;
    const chatTimeSpan = relativeTime === relativeEndTime ? relativeTime : `${relativeTime} - ${relativeEndTime}`;
    const displayInfos = `${chatTimeSpan} · 消息数: ${conv.messageCount} · ${domain}`;
    infoDiv.textContent = displayInfos;
    const details = `开始: ${convDate.toLocaleString()} (${relativeTime})\n最新: ${endTime.toLocaleString()} (${relativeEndTime})\n${title}\n${conv.url}`.split('\n').filter(Boolean).join('\n');
    item.title = details;

    item.appendChild(summaryDiv);
    item.appendChild(infoDiv);

    if (isTextFilterActive && conv.messages && Array.isArray(conv.messages)) {
      let snippets = [];
      let totalMatches = 0;
      const escapedFilter = filterText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lowerFilter = filterText.toLowerCase();
      let highlightRegex;
      try {
        highlightRegex = new RegExp(escapedFilter, 'gi');
      } catch (e) {
        console.error("创建高亮正则表达式失败:", e);
        highlightRegex = null;
      }

      for (const msg of conv.messages) {
        const plainText = extractMessagePlainText(msg);
        if (plainText) {
          const content = plainText;
          const contentLower = content.toLowerCase();
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
              if (highlightRegex) {
                 snippet = snippet.replace(highlightRegex, '<mark>$&</mark>');
              }
              const snippetSpan = document.createElement('span');
              snippetSpan.innerHTML = `…${snippet}…`;
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

    item.addEventListener('click', async () => {
      const conversation = await getConversationFromCacheOrLoad(conv.id);
      if (conversation) {
        loadConversationIntoChat(conversation);
      }
    });
    
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChatHistoryItemContextMenu(e, conv.id);
    });

    return item;
  }

  /**
   * 渲染下一批聊天记录项。
   * @param {HTMLElement} listContainer - 列表容器元素
   * @param {string[]} pinnedIds - 当前置顶的ID列表
   * @param {string} originalFilterTextForHighlight - 用于文本高亮的原始过滤文本
   * @param {string} currentPanelFilter - 调用此函数时面板当前的过滤条件，用于一致性检查
   */
  async function renderMoreItems(listContainer, pinnedIds, originalFilterTextForHighlight, currentPanelFilter, currentRunId) {
    if (isLoadingMoreItems || currentlyRenderedCount >= currentDisplayItems.length) {
      return;
    }
    isLoadingMoreItems = true;

    const panel = listContainer.closest('#chat-history-panel');
    if (panel && (panel.dataset.currentFilter !== currentPanelFilter || panel.dataset.runId !== currentRunId)) {
      isLoadingMoreItems = false;
      return;
    }

    const fragment = document.createDocumentFragment();
    let itemsRenderedInThisCall = 0;

    for (let i = 0; (currentlyRenderedCount + i) < currentDisplayItems.length && i < BATCH_SIZE; i++) {
      const convIndex = currentlyRenderedCount + i;
      const conv = currentDisplayItems[convIndex];
      const isConvPinned = pinnedIds.includes(conv.id);

      if (!isConvPinned) {
        const convDate = new Date(conv.endTime);
        const groupLabel = getGroupLabel(convDate);

        const isFirstUnpinnedAfterPinnedBlock = (convIndex === currentPinnedItemsCountInDisplay);

        if (isFirstUnpinnedAfterPinnedBlock || currentGroupLabelForBatchRender !== groupLabel) {
          const groupHeader = document.createElement('div');
          groupHeader.className = 'chat-history-group-header';
          groupHeader.textContent = groupLabel;
          fragment.appendChild(groupHeader);
          currentGroupLabelForBatchRender = groupLabel;
        }
      }

      const itemElement = createConversationItemElement(conv, originalFilterTextForHighlight, isConvPinned);
      fragment.appendChild(itemElement);
      itemsRenderedInThisCall++;
    }

    if (currentlyRenderedCount === 0) {
      removeSkeleton(listContainer);
    }

    listContainer.appendChild(fragment);
    // 确保哨兵始终位于列表末尾，兼容拖动滚动条和键盘 End 触发加载
    {
      const sentinel = ensureEndSentinel(listContainer);
      if (sentinel && sentinel.parentElement === listContainer) {
        listContainer.appendChild(sentinel);
      }
    }
    currentlyRenderedCount += itemsRenderedInThisCall;
    isLoadingMoreItems = false;

    if (currentlyRenderedCount < currentDisplayItems.length && itemsRenderedInThisCall > 0) {
      requestAnimationFrame(() => {
        const panelNow = listContainer.closest('#chat-history-panel');
        if (!panelNow) return;
        if (panelNow.dataset.currentFilter !== currentPanelFilter || panelNow.dataset.runId !== currentRunId) return;
        if (listContainer.scrollHeight <= listContainer.clientHeight) {
          renderMoreItems(listContainer, pinnedIds, originalFilterTextForHighlight, currentPanelFilter, currentRunId);
        }
      });
    }
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

    // 新增卡片：均值统计
    const avgStatsCard = document.createElement('div');
    avgStatsCard.className = 'db-stats-card avg-stats-card';
    avgStatsCard.innerHTML = `
      <div class="db-stats-card-header">均值统计</div>
      <div class="db-stats-metrics">
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${(stats.avgMessagesPerConversation || 0).toFixed(2)}</div>
          <div class="db-stats-metric-label">平均每会话消息数</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.avgTextBytesPerMessageFormatted || '0 B'}</div>
          <div class="db-stats-metric-label">平均每条文本大小</div>
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
    
    // 新增卡片：Top 域名（最多 10 个）
    const domainsCard = document.createElement('div');
    domainsCard.className = 'db-stats-card domains-card';
    const topDomains = Array.isArray(stats.topDomains) ? stats.topDomains : [];
    const domainsListHtml = topDomains.length
      ? `<ul class="domain-list">${topDomains.map(d => `<li><span class="domain">${d.domain}</span><span class="count">${d.count}</span></li>`).join('')}</ul>`
      : '<div class="db-stats-empty"><div class="db-stats-empty-text">暂无域名统计</div></div>';
    domainsCard.innerHTML = `
      <div class="db-stats-card-header">来源域名 Top 10</div>
      ${domainsListHtml}
    `;

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
    statsContent.appendChild(avgStatsCard);
    statsContent.appendChild(domainsCard);
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
    ensurePanelStylesInjected();
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

      const backupTab = document.createElement('div');
      backupTab.className = 'history-tab';
      backupTab.textContent = '备份设置';
      backupTab.dataset.tab = 'backup-settings';
      
      tabBar.appendChild(historyTab);
      tabBar.appendChild(statsTab);
      tabBar.appendChild(backupTab);
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
      filterInput.placeholder = '筛选文本 或 >10, <5, =20...';
      
      // 改为输入防抖实时搜索，且输入法构词期间不触发
      let filterDebounceTimer = null;
      let isComposingFilter = false;
      const triggerSearch = () => loadConversationHistories(panel, filterInput.value);
      const onFilterInput = () => {
        if (isComposingFilter) return;
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(triggerSearch, 200);
      };
      filterInput.addEventListener('input', onFilterInput);
      filterInput.addEventListener('compositionstart', () => { isComposingFilter = true; });
      filterInput.addEventListener('compositionend', () => { isComposingFilter = false; triggerSearch(); });
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
      
      // 备份设置标签内容
      const backupSettingsContent = document.createElement('div');
      backupSettingsContent.className = 'history-tab-content';
      backupSettingsContent.dataset.tab = 'backup-settings';
      backupSettingsContent.appendChild(renderBackupSettingsPanelDownloadsOnly());

      // 添加标签内容到容器
      tabContents.appendChild(historyContent);
      tabContents.appendChild(statsContent);
      tabContents.appendChild(backupSettingsContent);
      panel.appendChild(tabContents);
      
      // 设置标签切换事件（异步以支持 await 刷新）
      tabBar.addEventListener('click', async (e) => {
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
          } else if (tabName === 'backup-settings') {
            // 纯下载方案，无需刷新句柄状态
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
      // 步进进度（等分）
      const stepTitles = ['读取偏好', '分析会话', '读取会话内容'];
      // 是否包含“处理图片”步骤
      // 先假设包含，稍后根据 excludeImages 决定是否移除
      let includeStripImages = true;
      const tailSteps = ['打包数据', '保存文件', '更新备份时间', '完成'];

      // 读取备份偏好（仅下载方案）
      const prefs = await loadBackupPreferencesDownloadsOnly();
      const doIncremental = !!prefs.incrementalDefault;
      const excludeImages = !!prefs.excludeImagesDefault;
      const doCompress = prefs.compressDefault !== false; // 默认压缩
      includeStripImages = !!excludeImages;
      const steps = includeStripImages ? [...stepTitles, '处理图片', ...tailSteps] : [...stepTitles, ...tailSteps];
      const sp = utils.createStepProgress({ steps, type: 'info' });
      sp.setStep(0); // 读取偏好

      // 读取上次备份时间
      const LAST_BACKUP_TIME_KEY = 'chat_last_backup_time';
      let lastBackupAt = 0;
      try {
        const local = await chrome.storage.local.get([LAST_BACKUP_TIME_KEY]);
        lastBackupAt = Number(local[LAST_BACKUP_TIME_KEY]) || 0;
      } catch (_) {}
      sp.next('分析会话');

      // 准备需要导出的会话列表
      let conversationsToExport = [];
      if (doIncremental && lastBackupAt > 0) {
        // 增量：先获取元数据筛选 endTime 更大的会话，再逐个加载完整内容
        const metas = await getAllConversations(false);
        const updated = metas.filter(m => (Number(m.endTime) || 0) > lastBackupAt);
        const total = updated.length;
        let idx = 0;
        sp.next('读取会话内容');
        for (const meta of updated) {
          const full = await getConversationById(meta.id, true);
          if (full) conversationsToExport.push(full);
          idx++;
          sp.updateSub(idx, total, `读取会话内容 (${idx}/${total})`);
        }
      } else {
        // 全量：直接获取完整数据
        sp.next('读取会话内容');
        conversationsToExport = await getAllConversations();
        sp.updateSub(1, 1, `读取完成（${conversationsToExport.length} 条）`);
      }

      // 可选：移除图片与截图内容
      if (includeStripImages) {
        sp.next('处理图片');
        const total = conversationsToExport.length;
        for (let i = 0; i < total; i++) {
          conversationsToExport[i] = stripImagesFromConversation(conversationsToExport[i]);
          sp.updateSub(i + 1, total, `处理图片 (${i + 1}/${total})`);
        }
      }

      // 生成文件名与 Blob
      const filenamePrefix = doIncremental ? 'chat_backup_inc_' : 'chat_backup_full_';
      const filename = filenamePrefix + new Date().toISOString().replace(/[:.]/g, '-') + (excludeImages ? '_noimg' : '') + (doCompress ? '.json.gz' : '.json');
      sp.next('打包数据');
      const blob = await buildBackupBlob(conversationsToExport, doCompress);
      sp.next('保存文件');

      // 仅使用下载API或<a download>保存
      await triggerBlobDownload(blob, filename);

      // 记录本次备份时间（使用数据中最大 endTime 避免时间漂移）
      sp.next('更新备份时间');
      try {
        const maxEnd = conversationsToExport.reduce((acc, c) => Math.max(acc, Number(c.endTime) || 0), lastBackupAt);
        const toSave = { [LAST_BACKUP_TIME_KEY]: maxEnd || Date.now() };
        await chrome.storage.local.set(toSave);
      } catch (_) {}
      sp.next('完成');
      sp.complete('备份完成', true);
    } catch (error) {
      console.error('备份失败:', error);
      try { showNotification({ message: '备份失败', type: 'error', description: String(error?.message || error) }); } catch (_) {}
    }
  }

  /**
   * 从备份文件还原对话记录（支持多选与合并去重）
   */
  function restoreConversations() {
    // 创建一个 file input 元素用于选择文件
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true; // 支持多选
    // 同时支持 .json 与 .json.gz
    input.accept = '.json,application/json,.gz,application/gzip';
    input.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files || files.length === 0) return;
      try {
        // 步进进度：读取文件、解析合并、确认覆盖、写入会话、刷新界面、完成
        const steps = ['读取文件', '解析与合并', '确认覆盖', '写入会话', '刷新界面', '完成'];
        const sp = utils.createStepProgress({ steps, type: 'info' });
        sp.setStep(0);

        // 读取并解析所有选中的备份文件
        const allConversations = [];
        for (const file of files) {
          try {
            const text = await readBackupFileAsText(file);
            const data = JSON.parse(text);
            const arr = normalizeBackupArray(data);
            if (!arr) {
              console.warn('备份文件格式不正确（忽略此文件）:', file.name);
              continue;
            }
            allConversations.push(...arr);
          } catch (err) {
            console.error('解析备份文件失败（忽略此文件）:', file.name, err);
          }
          sp.updateSub(allConversations.length, allConversations.length, `读取文件 (${Math.min(allConversations.length, 1)}/${files.length})`);
        }
        if (allConversations.length === 0) {
          showNotification({ message: '未从所选文件读取到有效会话', type: 'warning' });
          return;
        }
        sp.next('解析与合并');
        const originalTotal = allConversations.length;
        const mergedConversations = mergeConversationsById(allConversations);
        const mergedCount = mergedConversations.length;
        sp.next('确认覆盖');
        const overwrite = await appContext.utils.showConfirm({
          message: '是否覆盖已有会话（同 ID）？',
          description: '选择“确定”会覆盖同 ID 的已有会话；选择“取消”仅导入新增会话。',
          confirmText: '确定',
          cancelText: '取消',
          type: 'warning'
        });
        let countAdded = 0;
        let countOverwritten = 0;
        let countSkipped = 0;
        sp.next('写入会话');
        const total = mergedConversations.length;
        // 逐条写入：存在且不覆盖则跳过，存在且覆盖则替换
        for (const conv of mergedConversations) {
          try {
            const existing = await getConversationById(conv.id, false);
            if (!existing) {
              await putConversation(conv);
              countAdded++;
            } else if (overwrite) {
              await putConversation(conv);
              countOverwritten++;
            } else {
              countSkipped++;
            }
          } catch (error) {
            console.error(`还原对话 ${conv?.id || '-'} 时出错:`, error);
          }
          const done = countAdded + countOverwritten + countSkipped;
          sp.updateSub(done, total, `写入会话 (${done}/${total})`);
        }
        sp.next('刷新界面');
        showNotification({
          message: '还原完成',
          description: `合并：${originalTotal} → ${mergedCount}；新增 ${countAdded}，覆盖 ${countOverwritten}，跳过 ${countSkipped}`,
          type: 'success',
          duration: 3000
        });
        // 刷新聊天记录面板
        invalidateMetadataCache();
        refreshChatHistory();
        sp.next('完成');
        sp.complete('还原完成', true);
      } catch (error) {
        console.error('读取备份文件失败:', error);
        showNotification({ message: '读取备份文件失败', type: 'error', description: '请检查文件格式' });
      }
    });
    input.click();
  }

  /**
   * 兼容不同导出格式，将对象归一为会话数组
   * @param {any} data
   * @returns {Array<Object>|null}
   */
  function normalizeBackupArray(data) {
    if (!data) return null;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    return null;
  }

  /**
   * 将多文件中的会话按 id 合并去重，冲突优先选择 endTime 更新的记录；
   * 若 endTime 相同，选择消息数更多的记录
   * @param {Array<Object>} conversations
   * @returns {Array<Object>}
   */
  function mergeConversationsById(conversations) {
    const map = new Map();
    (conversations || []).forEach((c) => {
      const id = c && c.id;
      if (!id) return;
      const prev = map.get(id);
      if (!prev) {
        map.set(id, c);
      } else {
        const endPrev = Number(prev.endTime) || 0;
        const endCur = Number(c.endTime) || 0;
        if (endCur > endPrev) {
          map.set(id, c);
        } else if (endCur === endPrev) {
          const countPrev = (Array.isArray(prev.messages) ? prev.messages.length : (prev.messageCount || 0)) || 0;
          const countCur = (Array.isArray(c.messages) ? c.messages.length : (c.messageCount || 0)) || 0;
          if (countCur > countPrev) map.set(id, c);
        }
      }
    });
    return Array.from(map.values());
  }

  /**
   * 工具：将会话中的图片内容移除，仅保留文本以减小备份体积
   * @param {Object} conversation
   * @returns {Object}
   */
  function stripImagesFromConversation(conversation) {
    try {
      const cloned = JSON.parse(JSON.stringify(conversation));
      if (Array.isArray(cloned.messages)) {
        cloned.messages = cloned.messages.map(msg => {
          const m = { ...msg };
          // 兼容字符串与多段内容
          if (Array.isArray(m.content)) {
            m.content = m.content.filter(part => part && ((part.type === 'text' && typeof part.text === 'string')));
            // 若结果为空，则改为空字符串，避免还原失败
            if (m.content.length === 0) m.content = '';
          }
          return m;
        });
      }
      return cloned;
    } catch (_) {
      return conversation;
    }
  }

  /**
   * 工具：将对象压缩为 gzip 并触发下载
   * 使用浏览器原生 CompressionStream('gzip')，无需额外依赖
   * @param {any} data
   * @param {string} filename
   */
  async function buildBackupBlob(data, compress = true) {
    const jsonStr = JSON.stringify(data);
    if (compress && typeof CompressionStream !== 'undefined') {
      try {
        const enc = new TextEncoder();
        const inputStream = new Blob([enc.encode(jsonStr)]).stream();
        const gzipStream = inputStream.pipeThrough(new CompressionStream('gzip'));
        const gzipBlob = await new Response(gzipStream).blob();
        return new Blob([gzipBlob], { type: 'application/gzip' });
      } catch (e) {
        console.warn('压缩失败，回退至原始 JSON:', e);
        return new Blob([jsonStr], { type: 'application/json' });
      }
    }
    return new Blob([jsonStr], { type: 'application/json' });
  }

  async function triggerBlobDownload(blob, filename) {
    // 尝试使用 chrome.downloads 以便指定子目录（如 Cerebr/），失败再回退为 <a download>
    const useDownloadsApi = !!(chrome && chrome.downloads && chrome.downloads.download);
    if (useDownloadsApi) {
      try {
        const url = URL.createObjectURL(blob);
        const target = `Cerebr/${filename}`; // 保存到下载目录下的 Cerebr 子文件夹
        await new Promise((resolve, reject) => {
          chrome.downloads.download({ url, filename: target, saveAs: false }, (id) => {
            if (chrome.runtime.lastError || !id) {
              try { URL.revokeObjectURL(url); } catch (_) {}
              reject(chrome.runtime.lastError || new Error('downloads.download failed'));
            } else {
              // 稍后撤销 URL，避免泄漏
              setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60 * 1000);
              resolve(id);
            }
          });
        });
        return;
      } catch (_) { /* 回退到 <a download> */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 工具：读取备份文件文本，支持 .json 及 .json.gz
   * @param {File} file
   * @returns {Promise<string>}
   */
  async function readBackupFileAsText(file) {
    // gzip 场景
    if (/\.gz$/i.test(file.name)) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前环境不支持解压 .gz 文件，请导入 .json 备份');
      }
      const ds = new DecompressionStream('gzip');
      const decompressed = file.stream().pipeThrough(ds);
      return await new Response(decompressed).text();
    }
    // 常规 JSON
    return await file.text();
  }

  // ==== 仅下载方案的备份偏好 ====
  const BACKUP_PREFS_KEY = 'chat_backup_prefs';
  async function loadBackupPreferencesDownloadsOnly() {
    const defaults = { incrementalDefault: true, excludeImagesDefault: false, compressDefault: true };
    const prefs = await storageService.getJSON(BACKUP_PREFS_KEY, defaults, { area: 'sync' });
    return {
      incrementalDefault: prefs.incrementalDefault !== false,
      excludeImagesDefault: !!prefs.excludeImagesDefault,
      compressDefault: prefs.compressDefault !== false
    };
  }
  async function saveBackupPreferencesDownloadsOnly(prefs) {
    const current = await loadBackupPreferencesDownloadsOnly();
    const merged = { ...current, ...prefs };
    await storageService.setJSON(BACKUP_PREFS_KEY, merged, { area: 'sync' });
    return merged;
  }

  // 已移除目录授权/直写方案，统一使用下载 API

  // ==== UI：在聊天记录面板添加“备份设置”标签页 ====
  // 在渲染面板的逻辑中（创建 tabs 处）插入一个设置页
  function renderBackupSettingsPanelDownloadsOnly() {
    const container = document.createElement('div');
    container.className = 'backup-settings-panel';

    // 同步初始化控件，随后从存储刷新状态
    let prefs = { incrementalDefault: true, excludeImagesDefault: false, compressDefault: true };

    const makeRow = () => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.margin = '6px 0';
      return row;
    };

    const title = document.createElement('div');
    title.textContent = '备份默认项设置';
    title.style.fontWeight = '600';
    title.style.margin = '8px 0';
    container.appendChild(title);

    // 默认增量备份
    const rowInc = makeRow();
    const cbInc = document.createElement('input');
    cbInc.type = 'checkbox';
    cbInc.checked = !!prefs.incrementalDefault;
    const lbInc = document.createElement('label');
    lbInc.textContent = '默认增量备份（按 endTime 仅导出变更）';
    rowInc.appendChild(cbInc); rowInc.appendChild(lbInc);
    container.appendChild(rowInc);

    // 默认排除图片
    const rowImg = makeRow();
    const cbImg = document.createElement('input');
    cbImg.type = 'checkbox';
    cbImg.checked = !!prefs.excludeImagesDefault;
    const lbImg = document.createElement('label');
    lbImg.textContent = '默认排除图片/截图（仅导出文本）';
    rowImg.appendChild(cbImg); rowImg.appendChild(lbImg);
    container.appendChild(rowImg);

    // 默认压缩
    const rowZip = makeRow();
    const cbZip = document.createElement('input');
    cbZip.type = 'checkbox';
    cbZip.checked = prefs.compressDefault !== false;
    const lbZip = document.createElement('label');
    lbZip.textContent = '默认压缩为 .json.gz（不支持则回退 .json）';
    rowZip.appendChild(cbZip); rowZip.appendChild(lbZip);
    container.appendChild(rowZip);

    // 下载路径说明
    const hint = document.createElement('div');
    hint.style.fontSize = '12px';
    hint.style.opacity = '0.8';
    hint.style.marginTop = '6px';
    hint.textContent = '备份将保存到 “下载/Cerebr/” 子目录。';
    container.appendChild(hint);

    // 事件：保存首选项
    cbInc.addEventListener('change', async () => { await saveBackupPreferencesDownloadsOnly({ incrementalDefault: !!cbInc.checked }); });
    cbImg.addEventListener('change', async () => { await saveBackupPreferencesDownloadsOnly({ excludeImagesDefault: !!cbImg.checked }); });
    cbZip.addEventListener('change', async () => { await saveBackupPreferencesDownloadsOnly({ compressDefault: !!cbZip.checked }); });

    // 初始化勾选状态（从存储读取）
    (async () => {
      try {
        const saved = await loadBackupPreferencesDownloadsOnly();
        cbInc.checked = !!saved.incrementalDefault;
        cbImg.checked = !!saved.excludeImagesDefault;
        cbZip.checked = saved.compressDefault !== false;
      } catch (e) {
        // ignore
      }
    })();

    return container;
  }

  // 已移除目录选择与顶层写入弹窗逻辑

  /**
   * 更新当前页面信息
   * @param {Object} newPageInfo - 新的页面信息对象
   */
  function updatePageInfo(newPageInfo) {
    // currentPageInfo = newPageInfo; // Local variable removed
    state.pageInfo = newPageInfo; // Update the shared state in appContext
    console.log('ChatHistoryUI: 页面信息已更新', state.pageInfo);
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
    
    // console.log('内存缓存已清理');
  }

  // 添加URL处理函数
  function getDisplayUrl(url) {
    try {
      if (!url) return '未知来源'; // 处理 null 或 undefined URL
      if (url.startsWith('file:///')) {
        // 解码URL并获取文件名
        const decodedUrl = decodeURIComponent(url);
        return decodedUrl.split(/[\/]/).pop() || '本地文件'; // 兼容 Windows 和 Unix 路径     
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
    if (!services.chatHistoryManager.chatHistory || !services.chatHistoryManager.chatHistory.messages || services.chatHistoryManager.chatHistory.messages.length === 0) {
      console.error('创建分支对话失败: 没有可用的聊天历史');
      return;
    }

    try {
      // 先保存当前会话以确保所有更改都已保存
      await saveCurrentConversation(true);

      // 查找目标消息
      const targetMessage = services.chatHistoryManager.chatHistory.messages.find(msg => msg.id === targetMessageId);
      if (!targetMessage) {
        console.error('创建分支对话失败: 找不到目标消息');
        return;
      }
      
      // 获取当前完整对话链
      const currentChain = services.chatHistoryManager.getCurrentConversationChain();
      
      // 截取从开始到目标消息的对话
      const targetIndex = currentChain.findIndex(msg => msg.id === targetMessageId);
      if (targetIndex === -1) {
        console.error('创建分支对话失败: 目标消息不在当前对话链中');
        return;
      }
      
      // 优先使用当前的页面信息，如果不存在，则尝试从原始对话获取（如果已保存）
      let pageInfo = appContext.state.pageInfo ? { ...appContext.state.pageInfo } : null;
      if (!pageInfo && currentConversationId) {
        const originalConversation = await getConversationFromCacheOrLoad(currentConversationId, false); // false: 不要强制重新加载完整内容
        if (originalConversation && originalConversation.url) {
          pageInfo = {
            url: originalConversation.url,
            title: originalConversation.title
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
      invalidateMetadataCache();
      
      // 清空当前会话并加载新创建的会话
      services.chatHistoryManager.chatHistory.messages = [];
      services.chatHistoryManager.chatHistory.root = null;
      services.chatHistoryManager.chatHistory.currentNode = null;
      
      // 清空聊天容器
      chatContainer.innerHTML = '';
      
      // 加载新创建的会话
      await loadConversationIntoChat(newConversation);
      
      // 更新当前会话ID
      currentConversationId = newConversationId;
      
      // 通知消息发送器更新当前会话ID
      services.messageSender.setCurrentConversationId(newConversationId);
      
      console.log('成功创建分支对话:', newConversationId);
      
      // 提示用户操作成功
      showNotification({ message: '已创建分支对话', duration: 2000 });
      
    } catch (error) {
      console.error('创建分支对话失败:', error);
    }
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
