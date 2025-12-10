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
  getDatabaseStats,
  purgeOrphanMessageContents
} from '../storage/indexeddb_helper.js';
import { storageService } from '../utils/storage_service.js';
import { extractThinkingFromText, mergeThoughts } from '../utils/thoughts_parser.js';

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

  const galleryCache = {
    items: [],
    loaded: false,
    lastLoadTs: 0
  };
  const GALLERY_IMAGE_LIMIT = 500;

  function createEmptySearchCache() {
    return {
      query: '',
      normalized: '',
      results: null,
      matchMap: new Map(),
      timestamp: 0,
      meta: null
    };
  }
  let searchCache = createEmptySearchCache();

  function invalidateGalleryCache() {
    galleryCache.items = [];
    galleryCache.loaded = false;
    galleryCache.lastLoadTs = 0;
    try {
      const panel = document.getElementById('chat-history-panel');
      if (panel) {
        const galleryContent = panel.querySelector('.history-tab-content[data-tab="gallery"]');
        if (galleryContent) {
          galleryContent.dataset.rendered = '';
          if (!galleryContent.classList.contains('active')) {
            galleryContent.innerHTML = '';
          }
        }
      }
    } catch (_) {}
  }

  function invalidateSearchCache() {
    searchCache = createEmptySearchCache();
    try {
      const panel = document.getElementById('chat-history-panel');
      if (panel) removeSearchSummary(panel);
    } catch (_) {}
  }

  function invalidateMetadataCache() {
    metaCache.data = null;
    metaCache.time = 0;
    invalidateGalleryCache();
    invalidateSearchCache();
  }

  /**
   * 归一化单条消息的思考内容：提取 <think> 段落到 thoughtsRaw，避免正文携带隐藏思考。
   * @param {Object} msg - 聊天消息对象
   * @returns {Object} 处理后的消息对象
   */
  function normalizeThinkingForMessage(msg) {
    if (!msg) return msg;
    if (typeof msg.content === 'string') {
      const thinkExtraction = extractThinkingFromText(msg.content);
      if (thinkExtraction.thoughtText) {
        msg.thoughtsRaw = mergeThoughts(msg.thoughtsRaw, thinkExtraction.thoughtText);
        msg.content = thinkExtraction.cleanText;
      }
    }
    return msg;
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
   * 删除会话记录并同步清理缓存、状态
   * @param {string} conversationId - 要删除的会话ID
   * @returns {Promise<void>}
   */
  async function deleteConversationRecord(conversationId) {
    if (!conversationId) return;
    try {
      await deleteConversation(conversationId);
    } catch (error) {
      console.error('删除会话记录失败:', error);
    }

    try {
      await unpinConversation(conversationId);
    } catch (error) {
      console.error('取消会话置顶失败:', error);
    }

    if (loadedConversations.has(conversationId)) {
      loadedConversations.delete(conversationId);
    }
    if (conversationUsageTimestamp.has(conversationId)) {
      conversationUsageTimestamp.delete(conversationId);
    }
    if (activeConversation?.id === conversationId) {
      activeConversation = null;
    }

    if (currentConversationId === conversationId) {
      currentConversationId = null;
      services.messageSender.setCurrentConversationId(null);
      services.chatHistoryManager.clearHistory();
      chatContainer.innerHTML = '';
    }

    invalidateMetadataCache();
    refreshChatHistory();
  }

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

  function buildExcerptSegments(sourceText, filterText, lowerFilter, contextLength = 32) {
    if (!sourceText) return null;
    const lowerSource = sourceText.toLowerCase();
    let index = lowerSource.indexOf(lowerFilter);
    if (index === -1) return null;

    const filterLength = filterText.length;
    const start = Math.max(0, index - contextLength);
    const end = Math.min(sourceText.length, index + filterLength + contextLength);
    const snippet = sourceText.slice(start, end);
    const snippetLower = snippet.toLowerCase();

    const segments = [];
    let cursor = 0;
    while (cursor < snippet.length) {
      const matchIndex = snippetLower.indexOf(lowerFilter, cursor);
      if (matchIndex === -1) {
        if (cursor < snippet.length) {
          segments.push({ type: 'text', value: snippet.slice(cursor) });
        }
        break;
      }
      if (matchIndex > cursor) {
        segments.push({ type: 'text', value: snippet.slice(cursor, matchIndex) });
      }
      segments.push({ type: 'mark', value: snippet.slice(matchIndex, matchIndex + filterLength) });
      cursor = matchIndex + filterLength;
    }

    return {
      segments,
      prefixEllipsis: start > 0,
      suffixEllipsis: end < sourceText.length
    };
  }

  /**
   * 保存或更新当前对话至持久存储
   * @param {boolean} [isUpdate=false] - 是否为更新操作
   * @returns {Promise<void>}
   */
  async function saveCurrentConversation(isUpdate = false) {
    const chatHistory = services.chatHistoryManager.chatHistory;
    const rawMessages = chatHistory.messages;
    if (rawMessages.length === 0) {
      if (isUpdate && currentConversationId) {
        await deleteConversationRecord(currentConversationId);
      }
      return;
    }
    // 说明：后续的落盘流程会把 dataURL 转换为本地路径，为避免污染实时对话树，
    // 这里先深拷贝一份消息列表，仅在副本上做持久化处理。
    const cloneMessageSafely = (msg) => {
      try {
        return structuredClone(msg);
      } catch (_) {
        return JSON.parse(JSON.stringify(msg));
      }
    };
    const messagesCopy = rawMessages.map(cloneMessageSafely);

    // 保存前确保 <think> 段落已转为 thoughtsRaw，避免思考内容混入正文
    messagesCopy.forEach(normalizeThinkingForMessage);
    // 保存前先将消息中的 dataURL/远程图片落盘（仅操作副本），防止 base64 继续写入 IndexedDB
    try {
      for (const msg of messagesCopy) {
        await repairImagesInMessage(msg);
      }
    } catch (e) {
      console.warn('保存会话时落盘图片失败，已跳过部分图片:', e);
    }
    const timestamps = messagesCopy.map(msg => msg.timestamp);
    const startTime = Math.min(...timestamps);
    const endTime = Math.max(...timestamps);

    // 提取第一条消息的纯文本内容
    const firstMessageTextContent = extractMessagePlainText(messagesCopy.find(msg => extractMessagePlainText(msg) !== ''));
    
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
      messages: messagesCopy,
      summary: summaryToSave,
      messageCount: messagesCopy.length
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
    for (const msg of fullConversation.messages) {
      normalizeThinkingForMessage(msg);
      const role = msg.role.toLowerCase() === 'assistant' ? 'ai' : msg.role;
      let messageElem = null;
      const thoughtsToDisplay = msg.thoughtsRaw || null; // 获取思考过程文本

      if (Array.isArray(msg.content)) {
        const legacyImagesContainer = document.createElement('div');
        let combinedContent = '';
        const legacyImageUrls = [];

        for (const part of msg.content) {
          if (part.type === 'text') {
            combinedContent = part.text || '';
          } else if (part.type === 'image_url' && part.image_url) {
            const resolved = await resolveImageUrlForDisplay(part.image_url);
            legacyImageUrls.push(resolved || part.image_url.url || '');
          }
        }

        const textHasInlineImages = typeof combinedContent === 'string' && /<img/i.test(combinedContent);
        const shouldForceInline = !!msg.hasInlineImages || textHasInlineImages || (role === 'ai' && legacyImageUrls.length > 0);
        let imagesHTML = null;

        if (shouldForceInline) {
          // 若文本中已经包含内联图片，则直接使用文本；若没有，则在末尾补齐。
          if (!textHasInlineImages && legacyImageUrls.length > 0) {
            const inlineHtml = legacyImageUrls.map(url => {
              const safeUrl = url || '';
              return `<img class="ai-inline-image" src="${safeUrl}" alt="加载的图片">`;
            }).join('');
            combinedContent = (combinedContent || '') + inlineHtml;
          }
          msg.hasInlineImages = true;
          const textPartIndex = msg.content.findIndex(part => part.type === 'text');
          if (textPartIndex >= 0) {
            msg.content[textPartIndex] = { ...msg.content[textPartIndex], text: combinedContent };
          }
        } else if (legacyImageUrls.length > 0) {
          legacyImageUrls.forEach(url => {
            const imageTag = createImageTag(url, null);
            legacyImagesContainer.appendChild(imageTag);
          });
          imagesHTML = legacyImagesContainer.innerHTML;
        }

        messageElem = appendMessage(combinedContent, role, true, null, imagesHTML, thoughtsToDisplay);
      } else {
        // 调用 appendMessage 时传递 thoughtsToDisplay
        messageElem = appendMessage(msg.content, role, true, null, null, thoughtsToDisplay);
      }
      
      messageElem.setAttribute('data-message-id', msg.id);
      // 渲染 API footer（按优先级：uuid->displayName->modelId），带 Thought Signature 的消息用文字标记
      try {
        const footer = messageElem.querySelector('.api-footer') || (() => {
          const f = document.createElement('div');
          f.className = 'api-footer';
          messageElem.appendChild(f);
          return f;
        })();
        const allConfigs = appContext.services.apiManager.getAllConfigs?.() || [];
        let label = '';
        let matchedConfig = null;
        if (msg.apiUuid) {
          matchedConfig = allConfigs.find(c => c.id === msg.apiUuid) || null;
        }
        if (!label && matchedConfig && typeof matchedConfig.displayName === 'string' && matchedConfig.displayName.trim()) {
          label = matchedConfig.displayName.trim();
        }
        if (!label && matchedConfig && typeof matchedConfig.modelName === 'string' && matchedConfig.modelName.trim()) {
          label = matchedConfig.modelName.trim();
        }
        if (!label) label = (msg.apiDisplayName || '').trim();
        if (!label) label = (msg.apiModelId || '').trim();
        const hasThoughtSignature = !!msg.thoughtSignature;

        if (role === 'ai') {
          // footer：带 Thought Signature 的消息使用 "signatured · 模型名" 文本标记
          let displayLabel = label || '';
          if (hasThoughtSignature) {
            displayLabel = label ? `signatured · ${label}` : 'signatured';
          }
          footer.textContent = displayLabel;
        }

        const titleDisplayName = matchedConfig?.displayName || msg.apiDisplayName || '-';
        const titleModelId = matchedConfig?.modelName || msg.apiModelId || '-';
        const thoughtFlag = hasThoughtSignature ? ' | thought_signature: stored' : '';
        footer.title = (role === 'ai')
          ? `API uuid: ${msg.apiUuid || '-'} | displayName: ${titleDisplayName} | model: ${titleModelId}${thoughtFlag}`
          : footer.title;
      } catch (_) {}
    }
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

  function highlightMessageInChat(messageId) {
    if (!messageId) return;
    requestAnimationFrame(() => {
      const target = chatContainer.querySelector(`[data-message-id="${messageId}"]`);
      if (!target) return;
      target.classList.add('search-highlight');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => target.classList.remove('search-highlight'), 1600);
    });
  }

  function removeSearchSummary(panel) {
    if (!panel) return;
    const summary = panel.querySelector('.search-result-summary');
    if (summary && summary.parentNode) {
      summary.remove();
    }
  }

  function renderSearchSummary(panel, info = {}) {
    if (!panel) return;
    const filterContainer = panel.querySelector('.filter-container');
    if (!filterContainer) return;

    const queryText = (info.query || '').trim();
    const scannedCount = Math.max(0, Number(info.scannedCount || 0));
    const resultCount = Math.max(0, Number(info.resultCount || 0));
    const excerptCount = Math.max(0, Number(info.excerptCount || 0));
    const durationMs = typeof info.durationMs === 'number' ? info.durationMs : null;
    const reused = !!info.reused;

    let summary = panel.querySelector('.search-result-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.className = 'search-result-summary';
      filterContainer.insertAdjacentElement('afterend', summary);
    }

    let durationText = '';
    if (durationMs !== null) {
      if (durationMs >= 1000) {
        const seconds = durationMs / 1000;
        durationText = `${seconds.toFixed(seconds >= 10 ? 1 : 2)}秒`;
      } else {
        durationText = `${Math.max(1, Math.round(durationMs))}毫秒`;
      }
    }

    const metaParts = [];
    if (scannedCount) metaParts.push(`遍历 ${scannedCount} 条会话`);
    metaParts.push(`匹配 ${resultCount} 条聊天记录`);
    if (excerptCount) metaParts.push(`提取 ${excerptCount} 条片段`);
    if (durationText) metaParts.push(`耗时 ${durationText}`);
    if (reused) metaParts.push('缓存结果');

    const summaryTitle = queryText ? `搜索 “${queryText}”` : '搜索结果';
    summary.textContent = '';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'summary-title';
    titleSpan.textContent = summaryTitle;
    const metaSpan = document.createElement('span');
    metaSpan.className = 'summary-meta';
    metaSpan.textContent = metaParts.join(' · ');
    summary.appendChild(titleSpan);
    summary.appendChild(metaSpan);
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

    // 转到对话 URL 选项
    const openUrlOption = document.createElement('div');
    openUrlOption.textContent = '转到对话 URL';
    openUrlOption.classList.add('chat-history-context-menu-option');
    openUrlOption.addEventListener('click', async (event) => {
      event.stopPropagation();
      menu.remove();
      try {
        const conversation = await getConversationFromCacheOrLoad(conversationId);
        const url = typeof conversation?.url === 'string' ? conversation.url.trim() : '';
        if (url && /^https?:\/\//i.test(url)) {
          try {
            window.open(url, '_blank', 'noopener');
          } catch (err) {
            console.error('打开对话 URL 失败:', err);
            showNotification({ message: '无法打开链接，请检查浏览器设置', type: 'error', duration: 2200 });
          }
        } else {
          showNotification({ message: '该对话没有关联 URL', duration: 2200 });
        }
      } catch (error) {
        console.error('获取对话 URL 失败:', error);
        showNotification({ message: '无法打开对话 URL，请重试', type: 'error', duration: 2200 });
      }
    });
    menu.appendChild(openUrlOption);

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
      try {
        await deleteConversationRecord(conversationId);
      } finally {
        menu.remove();
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
    const normalizedFilter = filterText.trim().toLowerCase();
    panel.dataset.normalizedFilter = normalizedFilter;

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
      removeSearchSummary(panel);
    } else if (filterText.trim()) {
      const normalizedFilter = panel.dataset.normalizedFilter || filterText.trim().toLowerCase();
      if (searchCache.results && searchCache.normalized === normalizedFilter) {
        sourceHistories = searchCache.results.slice();
        effectiveFilterTextForHighlight = filterText;
        const meta = searchCache.meta || {};
        renderSearchSummary(panel, {
          query: searchCache.query || filterText,
          normalized: searchCache.normalized,
          durationMs: meta.durationMs,
          resultCount: meta.resultCount ?? sourceHistories.length,
          excerptCount: meta.excerptCount,
          scannedCount: meta.scannedCount,
          reused: true
        });
      } else {
        removeSearchSummary(panel);
        const lowerFilter = normalizedFilter;
        const searchStartTime = performance.now();
        const matchedEntries = [];
        const matchInfoMap = new Map();
        const totalItems = allHistoriesMeta.length;
        let nextIndex = 0;
        let processedCount = 0;
        let lastProgressUpdate = 0;
        let cancelled = false;

        // 在列表容器顶部插入搜索进度指示器
        const searchProgressIndicator = document.createElement('div');
        searchProgressIndicator.className = 'search-loading-indicator';

        const filterBoxContainer = panel.querySelector('.filter-container');
        if (filterBoxContainer && filterBoxContainer.parentNode === listContainer.parentNode) {
          filterBoxContainer.insertAdjacentElement('afterend', searchProgressIndicator);
        } else {
          listContainer.insertBefore(searchProgressIndicator, listContainer.firstChild);
        }

        const PROGRESS_UPDATE_INTERVAL = 10;
        const CONCURRENCY = Math.min(6, Math.max(2, navigator?.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 2) : 4));

        const updateProgress = (force = false) => {
          if (!force && processedCount - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL) return;
          lastProgressUpdate = processedCount;
          const percentComplete = totalItems === 0 ? 100 : Math.round((processedCount / totalItems) * 100);
          const matchCount = matchedEntries.length;
          searchProgressIndicator.innerHTML = `
            <div class="search-progress">
              <div class="search-progress-text">
                正在搜索聊天记录... (${processedCount}/${totalItems}${matchCount ? ` · 已找到 ${matchCount}` : ''})
              </div>
              <div class="search-progress-bar">
                <div class="search-progress-fill" style="width: ${percentComplete}%"></div>
              </div>
            </div>
          `;
        };

        updateProgress(true);

        const workers = Array.from({ length: CONCURRENCY }).map(async () => {
          while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= totalItems || cancelled) break;

            if (panel.dataset.runId !== runId) {
              cancelled = true;
              break;
            }

            const historyMeta = allHistoriesMeta[currentIndex];
            const url = (historyMeta.url || '').toLowerCase();
            const summary = (historyMeta.summary || '').toLowerCase();
            let matched = false;

            if (url.includes(lowerFilter) || summary.includes(lowerFilter)) {
              matchedEntries.push({ index: currentIndex, data: historyMeta });
              matchInfoMap.set(historyMeta.id, { messageId: null, excerpts: [], reason: 'meta' });
              matched = true;
            }

            if (!matched) {
              try {
                const fullConversation = await getConversationFromCacheOrLoad(historyMeta.id);
                if (panel.dataset.runId !== runId) {
                  cancelled = true;
                  break;
                }
                if (fullConversation && Array.isArray(fullConversation.messages)) {
                  const matchInfo = matchInfoMap.get(historyMeta.id) || { messageId: null, excerpts: [], reason: 'message' };
                  let conversationMatched = false;
                  for (const message of fullConversation.messages) {
                    const plainText = extractMessagePlainText(message);
                    if (!plainText) continue;
                    const lowerPlain = plainText.toLowerCase();
                    if (lowerPlain.includes(lowerFilter)) {
                      conversationMatched = true;
                      if (!matchInfo.messageId && message.id) {
                        matchInfo.messageId = message.id;
                      }
                      if (matchInfo.excerpts.length < 20) {
                        const excerpt = buildExcerptSegments(plainText, filterText, lowerFilter);
                        if (excerpt) {
                          matchInfo.excerpts.push(excerpt);
                        }
                      }
                    }
                    if (matchInfo.excerpts.length >= 20) break;
                  }
                  if (conversationMatched) {
                    matchInfoMap.set(historyMeta.id, matchInfo);
                    matchedEntries.push({ index: currentIndex, data: fullConversation });
                  }
                }
              } catch (error) {
                console.error(`搜索会话 ${historyMeta.id} 失败:`, error);
              }
            }

            processedCount++;
            updateProgress();
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        });

        await Promise.all(workers);

        if (panel.dataset.runId !== runId || cancelled) {
          if (searchProgressIndicator.parentNode) searchProgressIndicator.remove();
          return;
        }

        updateProgress(true);
        if (searchProgressIndicator.parentNode) searchProgressIndicator.remove();

        matchedEntries.sort((a, b) => a.index - b.index);
        const finalResults = matchedEntries.map(entry => entry.data);
        const durationMs = performance.now() - searchStartTime;
        const excerptCount = Array.from(matchInfoMap.values()).reduce((acc, info) => acc + (Array.isArray(info?.excerpts) ? info.excerpts.length : 0), 0);
        const scannedCount = Math.min(processedCount, totalItems);
        searchCache = {
          query: filterText,
          normalized: normalizedFilter,
          results: finalResults.slice(),
          matchMap: matchInfoMap,
          timestamp: Date.now(),
          meta: {
            durationMs,
            resultCount: finalResults.length,
            excerptCount,
            scannedCount
          }
        };
        sourceHistories = searchCache.results.slice();
        renderSearchSummary(panel, {
          query: filterText,
          normalized: normalizedFilter,
          durationMs,
          resultCount: finalResults.length,
          excerptCount,
          scannedCount,
          reused: false
        });
      }
    } else {
      removeSearchSummary(panel);
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
        const regex = new RegExp(escapedFilterForSummary, 'gi');
        let lastIndex = 0;
        summaryDiv.textContent = '';
        let match;
        while ((match = regex.exec(displaySummary)) !== null) {
          if (match.index > lastIndex) {
            summaryDiv.appendChild(document.createTextNode(displaySummary.slice(lastIndex, match.index)));
          }
          const mark = document.createElement('mark');
          mark.textContent = match[0];
          summaryDiv.appendChild(mark);
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < displaySummary.length) {
          summaryDiv.appendChild(document.createTextNode(displaySummary.slice(lastIndex)));
        }
      } catch (e) {
        console.error("高亮摘要时发生错误:", e);
        summaryDiv.textContent = displaySummary;
      }
    } else {
      summaryDiv.textContent = displaySummary;
    }

    let searchMatchInfo = null;
    try {
      const panelNode = document.getElementById('chat-history-panel');
      const normalizedActiveFilter = panelNode?.dataset.normalizedFilter || '';
      if (normalizedActiveFilter && searchCache.normalized === normalizedActiveFilter && searchCache.matchMap) {
        searchMatchInfo = searchCache.matchMap.get(conv.id) || null;
      }
    } catch (_) {}

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

    let snippetRendered = false;
    if (isTextFilterActive && searchMatchInfo && Array.isArray(searchMatchInfo.excerpts) && searchMatchInfo.excerpts.length) {
      const snippetDiv = document.createElement('div');
      snippetDiv.className = 'highlight-snippet';
      searchMatchInfo.excerpts.forEach(excerpt => {
        const line = document.createElement('div');
        line.className = 'highlight-snippet-line';
        if (excerpt.prefixEllipsis) line.appendChild(document.createTextNode('…'));
        excerpt.segments.forEach(segment => {
          if (segment.type === 'mark') {
            const markEl = document.createElement('mark');
            markEl.textContent = segment.value;
            line.appendChild(markEl);
          } else {
            line.appendChild(document.createTextNode(segment.value));
          }
        });
        if (excerpt.suffixEllipsis) line.appendChild(document.createTextNode('…'));
        snippetDiv.appendChild(line);
      });
      item.appendChild(snippetDiv);
      snippetRendered = true;
    }

    if (!snippetRendered && isTextFilterActive && conv.messages && Array.isArray(conv.messages)) {
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
            if (snippets.length < 8) {
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
        snippets.forEach((span) => {
          const line = document.createElement('div');
          line.className = 'highlight-snippet-line';
          line.appendChild(span);
          snippetDiv.appendChild(line);
        });
        if (totalMatches > snippets.length) {
          const moreMatchesLine = document.createElement('div');
          moreMatchesLine.className = 'highlight-snippet-line';
          moreMatchesLine.textContent = `…… 共 ${totalMatches} 匹配`;
          snippetDiv.appendChild(moreMatchesLine);
        }
        item.appendChild(snippetDiv);
      }
    }

    item.addEventListener('click', async () => {
      const conversation = await getConversationFromCacheOrLoad(conv.id);
      if (conversation) {
        await loadConversationIntoChat(conversation);
        const panelNode = document.getElementById('chat-history-panel');
        const normalizedActiveFilter = panelNode?.dataset.normalizedFilter || '';
        if (normalizedActiveFilter && searchCache.normalized === normalizedActiveFilter && searchCache.matchMap) {
          const matchInfo = searchCache.matchMap.get(conv.id);
          if (matchInfo && matchInfo.messageId) {
            highlightMessageInChat(matchInfo.messageId);
          }
        }
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

  async function loadGalleryImages(forceRefresh = false) {
    if (!forceRefresh && galleryCache.loaded) {
      return galleryCache.items;
    }
    const conversations = await getAllConversations(true);
    const images = [];
    const seenKeys = new Set();
    for (const conv of conversations) {
      if (!conv || !Array.isArray(conv.messages)) continue;
      const convDomain = getDisplayUrl(conv.url);
      for (const msg of conv.messages) {
        const timestamp = Number(msg?.timestamp || conv.endTime || conv.startTime || Date.now());
        if (Array.isArray(msg?.content)) {
          for (let idx = 0; idx < msg.content.length; idx++) {
            const part = msg.content[idx];
            if (!part || part.type !== 'image_url' || !part.image_url) continue;
            const resolvedUrl = await resolveImageUrlForDisplay(part.image_url);
            if (!resolvedUrl) continue;
            const rawKey = part.image_url.path || part.image_url.url || resolvedUrl;
            const key = `${conv.id || 'conv'}_${msg.id || idx}_${idx}_${rawKey}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            images.push({
              conversationId: conv.id,
              messageId: msg.id,
              url: resolvedUrl,
              timestamp,
              summary: conv.summary || '',
              title: conv.title || '',
              domain: convDomain || '未知来源'
            });
            if (images.length >= GALLERY_IMAGE_LIMIT) break;
          }
        }
        if (images.length >= GALLERY_IMAGE_LIMIT) {
          break;
        }
      }
      if (images.length >= GALLERY_IMAGE_LIMIT) break;
    }
    images.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    if (images.length > GALLERY_IMAGE_LIMIT) {
      images.length = GALLERY_IMAGE_LIMIT;
    }
    galleryCache.items = images;
    galleryCache.loaded = true;
    galleryCache.lastLoadTs = Date.now();
    return images;
  }

  async function renderGalleryTab(container, { forceRefresh = false } = {}) {
    if (!container) return;
    if (!forceRefresh && container.dataset.rendered === 'true') {
      return;
    }
    if (container._rendering) {
      return container._rendering;
    }
    container.dataset.rendered = '';
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'gallery-loading';
    loading.textContent = '正在收集图片…';
    container.appendChild(loading);

    const renderPromise = (async () => {
      const images = await loadGalleryImages(forceRefresh);
      container.innerHTML = '';
      if (!images || images.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'gallery-empty';
        empty.textContent = '暂无可展示的图片';
        container.appendChild(empty);
        container.dataset.rendered = 'true';
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'gallery-grid';

      images.forEach((record) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';

        const thumb = document.createElement('div');
        thumb.className = 'gallery-thumb';
        const img = document.createElement('img');
        img.src = record.url;
        img.loading = 'lazy';
        img.alt = record.summary || record.title || record.domain || '聊天图片';
        thumb.appendChild(img);
        item.appendChild(thumb);

        const meta = document.createElement('div');
        meta.className = 'gallery-meta';

        const metaTitle = document.createElement('div');
        metaTitle.className = 'gallery-meta-title';
        metaTitle.textContent = record.summary || record.title || record.domain || '聊天图片';
        meta.appendChild(metaTitle);

        const metaInfo = document.createElement('div');
        metaInfo.className = 'gallery-meta-info';
        metaInfo.textContent = `${formatRelativeTime(new Date(record.timestamp || Date.now()))} · ${record.domain || '未知来源'}`;
        meta.appendChild(metaInfo);

        item.appendChild(meta);

        item.addEventListener('click', async () => {
          try {
            const conversation = await getConversationFromCacheOrLoad(record.conversationId);
            if (conversation) {
              await loadConversationIntoChat(conversation);
              requestAnimationFrame(() => {
                const messageEl = chatContainer.querySelector(`[data-message-id="${record.messageId}"]`);
                if (messageEl) {
                  messageEl.classList.add('gallery-highlight');
                  messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  setTimeout(() => messageEl.classList.remove('gallery-highlight'), 1600);
                }
              });
            }
          } catch (error) {
            console.error('打开图片所属对话失败:', error);
          }
        });

        item.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          try {
            window.open(record.url, '_blank', 'noopener');
          } catch (_) {}
        });

        grid.appendChild(item);
      });

      container.appendChild(grid);
      container.dataset.rendered = 'true';
    })().catch((error) => {
      console.error('加载图片相册失败:', error);
      invalidateGalleryCache();
      container.innerHTML = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'gallery-error';
      errorDiv.textContent = '加载图片失败，请稍后重试';
      container.appendChild(errorDiv);
    }).finally(() => {
      container._rendering = null;
    });

    container._rendering = renderPromise;
    return renderPromise;
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

      const importButton = document.createElement('button');
      importButton.textContent = '导入';
      importButton.title = '从剪贴板导入一条新的聊天记录';
      importButton.addEventListener('click', () => {
        importConversationFromClipboard();
      });

      const restoreButton = document.createElement('button');
      restoreButton.textContent = '还原';
      restoreButton.addEventListener('click', restoreConversations);

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '关闭';
      closeBtn.addEventListener('click', () => { closeChatHistoryPanel(); });

      headerActions.appendChild(refreshButton);
      headerActions.appendChild(backupButton);
      headerActions.appendChild(importButton);
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
      
      const galleryTab = document.createElement('div');
      galleryTab.className = 'history-tab';
      galleryTab.textContent = '图片相册';
      galleryTab.dataset.tab = 'gallery';
      
      const statsTab = document.createElement('div');
      statsTab.className = 'history-tab';
      statsTab.textContent = '数据统计';
      statsTab.dataset.tab = 'stats';

      const backupTab = document.createElement('div');
      backupTab.className = 'history-tab';
      backupTab.textContent = '备份设置';
      backupTab.dataset.tab = 'backup-settings';
      
      tabBar.appendChild(historyTab);
      tabBar.appendChild(galleryTab);
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
      
      // 图片相册标签内容
      const galleryContent = document.createElement('div');
      galleryContent.className = 'history-tab-content';
      galleryContent.dataset.tab = 'gallery';
      
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
      tabContents.appendChild(galleryContent);
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
          } else if (tabName === 'gallery') {
            await renderGalleryTab(targetContent);
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
    invalidateGalleryCache();
    const panel = document.getElementById('chat-history-panel');
    if (panel && panel.classList.contains('visible')) { // 仅当面板可见时刷新
      const filterInput = panel.querySelector('input[type="text"]');
      loadConversationHistories(panel, filterInput ? filterInput.value : '');
      const galleryContent = panel.querySelector('.history-tab-content[data-tab="gallery"]');
      const activeTabName = panel.querySelector('.history-tab.active')?.dataset.tab;
      if (galleryContent) {
        galleryContent.dataset.rendered = '';
        if (activeTabName === 'gallery') {
          renderGalleryTab(galleryContent, { forceRefresh: true });
        } else {
          galleryContent.innerHTML = '';
        }
      }
    }
  }

  // 自动备份锁（跨标签页）
  const AUTO_BACKUP_LOCK_KEY = 'auto_backup_lock';
  const INSTANCE_ID = `ab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  async function acquireAutoBackupLock(ttlMs = 2 * 60 * 1000) {
    try {
      const wrap = await chrome.storage.local.get([AUTO_BACKUP_LOCK_KEY]);
      const lock = wrap[AUTO_BACKUP_LOCK_KEY];
      const now = Date.now();
      if (lock && lock.expiresAt && lock.expiresAt > now) return false;
      const newLock = { owner: INSTANCE_ID, expiresAt: now + ttlMs };
      await chrome.storage.local.set({ [AUTO_BACKUP_LOCK_KEY]: newLock });
      const confirmWrap = await chrome.storage.local.get([AUTO_BACKUP_LOCK_KEY]);
      return confirmWrap[AUTO_BACKUP_LOCK_KEY]?.owner === INSTANCE_ID;
    } catch (e) { return false; }
  }
  async function releaseAutoBackupLock() {
    try {
      const wrap = await chrome.storage.local.get([AUTO_BACKUP_LOCK_KEY]);
      if (wrap[AUTO_BACKUP_LOCK_KEY]?.owner === INSTANCE_ID) {
        await chrome.storage.local.remove([AUTO_BACKUP_LOCK_KEY]);
      }
    } catch (_) {}
  }

  /**
   * 备份所有对话记录
   * @returns {Promise<void>}
   */
  async function backupConversations(opts = {}) {
    try {
      // 步进进度（等分）
      const stepTitles = ['读取偏好', '分析会话', '读取会话内容'];
      // 是否包含“处理图片”步骤
    // 先假设包含，稍后根据 excludeImages 决定是否移除
    let includeStripImages = true;
    const tailSteps = ['打包数据', '保存文件', '更新备份时间', '完成'];

      // 读取备份偏好（仅下载方案）
      const prefs = await loadBackupPreferencesDownloadsOnly();
      const seqBase = Number(prefs.incSequence) || 0;
      const mode = opts.mode || 'full';
      const isAuto = !!opts.auto;
      const resetIncremental = !!opts.resetIncremental;
      const doIncremental = mode === 'incremental';
      // 现在 IndexedDB 不再存储图片 base64，默认备份包含图片引用；仅当显式传入 excludeImages 时才剥离图片片段
      const excludeImages = (opts.excludeImages !== undefined) ? !!opts.excludeImages : false;
      const doCompress = (opts.compress !== undefined) ? !!opts.compress : (prefs.compressDefault !== false);
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
          conversationsToExport[i] = stripImagesFromConversation(conversationsToExport[i], { keepImageRefs: false });
          sp.updateSub(i + 1, total, `处理图片 (${i + 1}/${total})`);
        }
      } else {
        // 默认保留图片引用，但清理掉可能残留的 dataURL，避免再次膨胀
        sp.next('处理图片');
        const total = conversationsToExport.length;
        for (let i = 0; i < total; i++) {
          conversationsToExport[i] = sanitizeConversationImages(conversationsToExport[i]);
          sp.updateSub(i + 1, total, `处理图片 (${i + 1}/${total})`);
        }
      }

      // 生成文件名与 Blob
      sp.next('打包数据');
      const { blob, usedStripFallback } = await buildBackupBlob(conversationsToExport, doCompress, { allowStripFallback: true, stripImagesOnFallback: true });
      const seqForName = doIncremental ? (seqBase + 1) : undefined;
      const effectiveExcludeImages = excludeImages || usedStripFallback;
      const filename = buildBackupFilename({
        mode: doIncremental ? 'incremental' : 'full',
        excludeImages: effectiveExcludeImages,
        doCompress,
        seq: seqForName
      });
      sp.next('保存文件');

      // 仅使用下载API或<a download>保存
      await triggerBlobDownload(blob, filename);
      if (usedStripFallback && !excludeImages) {
        try {
          showNotification({
            message: '备份体积过大，已自动移除图片后完成备份',
            type: 'warning',
            duration: 3600
          });
        } catch (_) {}
      }

      // 记录本次备份时间（使用数据中最大 endTime 避免时间漂移）
      sp.next('更新备份时间');
      let backupReferenceTime = Date.now();
      try {
        const maxEnd = conversationsToExport.reduce((acc, c) => Math.max(acc, Number(c.endTime) || 0), lastBackupAt);
        backupReferenceTime = maxEnd || Date.now();
        const toSave = { [LAST_BACKUP_TIME_KEY]: backupReferenceTime };
        await chrome.storage.local.set(toSave);
      } catch (_) {}
      try {
        const completedAt = Date.now();
        const checkpoint = Math.max(completedAt, backupReferenceTime);
        if (doIncremental) {
          await saveBackupPreferencesDownloadsOnly({
            lastIncrementalBackupAt: checkpoint,
            incSequence: seqBase + 1
          });
        } else {
          const updates = {
            lastFullBackupAt: checkpoint
          };
          if (resetIncremental) {
            updates.lastFullResetBackupAt = checkpoint;
            updates.lastIncrementalBackupAt = checkpoint;
            updates.incSequence = 0;
          }
          await saveBackupPreferencesDownloadsOnly(updates);
        }
      } catch (_) {}
      sp.next('完成');
      sp.complete('备份完成', true);
    } catch (error) {
      console.error('备份失败:', error);
      try { showNotification({ message: '备份失败', type: 'error', description: String(error?.message || error) }); } catch (_) {}
    }
  }

  function buildBackupFilename({ mode, excludeImages, doCompress, seq }) {
    const ts = new Date();
    const pad = (n, w) => String(n).padStart(w, '0');
    const nameTs = `${ts.getFullYear()}${pad(ts.getMonth() + 1, 2)}${pad(ts.getDate(), 2)}_${pad(ts.getHours(), 2)}${pad(ts.getMinutes(), 2)}${pad(ts.getSeconds(), 2)}`;
    const suffix = doCompress ? '.json.gz' : '.json';
    if (mode === 'incremental') {
      const s = pad(Math.max(1, Number(seq || 1)), 3);
      return `chat_backup_inc_${nameTs}+${s}${suffix}`;
    }
    return `chat_backup_full_${nameTs}${excludeImages ? '_noimg' : ''}${suffix}`;
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

  // ==== 图片重扫与本地化（用于清理最近会话中的 base64） ====
  const DATA_URL_REGEX = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+=*/gi;

  /**
   * 工具：将会话中的图片内容移除，仅保留文本以减小备份体积
   * @param {Object} conversation
   * @returns {Object}
   */
  function stripDataUrlsFromString(text) {
    if (typeof text !== 'string') return { text, removed: 0 };
    let removed = 0;
    const cleaned = text.replace(DATA_URL_REGEX, () => {
      removed += 1;
      return '';
    });
    return { text: cleaned, removed };
  }

  /**
   * 备份时剥离图片内容：默认移除图片片段，仅保留文本；可选保留图片引用（path/hash）
   * @param {Object} conversation
   * @param {{keepImageRefs?: boolean}} options
   * @returns {Object}
   */
  function stripImagesFromConversation(conversation, options = {}) {
    const keepImageRefs = !!options.keepImageRefs;
    if (!conversation || typeof conversation !== 'object') return conversation;
    try {
      const cloned = { ...conversation };
      if (Array.isArray(conversation.messages)) {
        cloned.messages = conversation.messages.map((msg) => {
          const next = { ...msg };
          // 默认只保留文本片段；keepImageRefs=true 时保留轻量级图片引用（path/hash）
          if (Array.isArray(msg.content)) {
            const parts = [];
            for (const part of msg.content) {
              if (!part) continue;
              if (part.type === 'text' && typeof part.text === 'string') {
                const cleaned = stripDataUrlsFromString(part.text);
                parts.push({ type: 'text', text: cleaned.text });
              } else if (part.type === 'image_url' && keepImageRefs) {
                // 保留轻量级图片引用，避免还原后丢失路径；始终丢弃 data: 链接
                const img = part.image_url || {};
                const minimal = { type: 'image_url', image_url: {} };
                const nonDataPath = (img.path && !String(img.path).startsWith('data:')) ? img.path : null;
                const nonDataUrl = (img.url && !String(img.url).startsWith('data:')) ? img.url : null;
                if (nonDataPath) minimal.image_url.path = nonDataPath;
                else if (nonDataUrl) minimal.image_url.path = nonDataUrl;
                if (!minimal.image_url.path) {
                  // 完全跳过 dataURL 以避免膨胀
                  continue;
                }
                if (img.hash) minimal.image_url.hash = img.hash;
                if (img.mimeType || img.mime_type) {
                  minimal.image_url.mime_type = img.mimeType || img.mime_type;
                }
                parts.push(minimal);
              }
            }
            next.content = parts.length > 0 ? parts : '';
            if (next.contentRef) delete next.contentRef; // 去掉对已被剥离图片内容的引用
          } else if (typeof msg.content === 'string') {
            const cleaned = stripDataUrlsFromString(msg.content);
            next.content = cleaned.text;
          }
          return next;
        });
      }
      return cloned;
    } catch (_) {
      return conversation;
    }
  }

  /**
   * 备份前清理图片字段：移除 dataURL，统一使用 path，缺少路径则丢弃该图片片段
   * @param {Object} conversation
   * @returns {Object}
   */
  function sanitizeConversationImages(conversation) {
    if (!conversation || typeof conversation !== 'object') return conversation;
    try {
      const cloned = { ...conversation };
      if (Array.isArray(conversation.messages)) {
        cloned.messages = conversation.messages.map((msg) => {
          const next = { ...msg };
          if (Array.isArray(msg.content)) {
            const parts = [];
            for (const part of msg.content) {
              if (!part) continue;
              if (part.type === 'text' && typeof part.text === 'string') {
                const cleaned = stripDataUrlsFromString(part.text);
                parts.push({ type: 'text', text: cleaned.text });
              } else if (part.type === 'image_url' && part.image_url) {
                const img = { ...part.image_url };
                const nonDataPath = (img.path && !String(img.path).startsWith('data:')) ? img.path : null;
                const nonDataUrl = (img.url && !String(img.url).startsWith('data:')) ? img.url : null;
                const path = nonDataPath || nonDataUrl;
                if (!path) {
                  // 丢弃 dataURL/空路径的图片，避免撑爆备份
                  continue;
                }
                const minimal = { type: 'image_url', image_url: { path } };
                if (img.hash) minimal.image_url.hash = img.hash;
                if (img.mimeType || img.mime_type) minimal.image_url.mime_type = img.mimeType || img.mime_type;
                parts.push(minimal);
              }
            }
            next.content = parts.length > 0 ? parts : '';
            if (next.contentRef) delete next.contentRef;
          } else if (typeof msg.content === 'string') {
            const cleaned = stripDataUrlsFromString(msg.content);
            next.content = cleaned.text;
          }
          return next;
        });
      }
      return cloned;
    } catch (_) {
      return conversation;
    }
  }

  /**
   * 调试：扫描数据库中残留的 dataURL（文本或图片字段），避免意外膨胀
   * @param {number} sampleLimit 样本上限
   * @returns {Promise<{conversations:number,messages:number,dataUrlCount:number,samples:Array}>}
   */
  async function scanDataUrlsInDb(sampleLimit = 20) {
    const conversations = await getAllConversations(true);
    let msgCount = 0;
    let dataUrlCount = 0;
    const samples = [];

    const pushSample = (convId, msgId, field, value) => {
      if (samples.length >= sampleLimit) return;
      samples.push({
        conversationId: convId,
        messageId: msgId,
        field,
        preview: (value || '').slice(0, 160)
      });
    };

    for (const conv of conversations) {
      if (!Array.isArray(conv?.messages)) continue;
      for (const msg of conv.messages) {
        msgCount += 1;
        const convId = conv.id || '';
        const msgId = msg.id || '';

        // 字符串内容
        if (typeof msg.content === 'string') {
          const matches = msg.content.match(DATA_URL_REGEX);
          if (matches && matches.length) {
            dataUrlCount += matches.length;
            pushSample(convId, msgId, 'content(string)', matches[0]);
          }
        }

        // 结构化内容
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part) continue;
            if (part.type === 'text' && typeof part.text === 'string') {
              const matches = part.text.match(DATA_URL_REGEX);
              if (matches && matches.length) {
                dataUrlCount += matches.length;
                pushSample(convId, msgId, 'text', matches[0]);
              }
            } else if (part.type === 'image_url' && part.image_url) {
              const img = part.image_url;
              if (img.path && String(img.path).startsWith('data:')) {
                dataUrlCount += 1;
                pushSample(convId, msgId, 'image_url.path', img.path);
              } else if (img.url && String(img.url).startsWith('data:')) {
                dataUrlCount += 1;
                pushSample(convId, msgId, 'image_url.url', img.url);
              }
            }
          }
        }
      }
    }

    return {
      conversations: conversations.length,
      messages: msgCount,
      dataUrlCount,
      samples
    };
  }

  /**
   * 工具：构建备份 Blob（可选 gzip），在超大数据时自动剥离图片兜底
   * 使用浏览器原生 CompressionStream('gzip')，无需额外依赖
   * @param {any} data
   * @param {boolean} compress
   * @param {{allowStripFallback?: boolean}} options
   * @returns {Promise<{blob: Blob, usedStripFallback: boolean}>}
   */
  async function buildBackupBlob(data, compress = true, options = {}) {
    const { allowStripFallback = false, stripImagesOnFallback = false } = options || {};
    let jsonStr = '';
    let usedStripFallback = false;
    let dataForStringify = data;
    let useStreaming = false;

    const buildStreamBlob = async (arr) => {
      const encoder = new TextEncoder();
      const jsonStream = new ReadableStream({
        start(controller) {
          try {
            controller.enqueue(encoder.encode('['));
            arr.forEach((item, idx) => {
              const chunk = JSON.stringify(item);
              controller.enqueue(encoder.encode(chunk));
              if (idx !== arr.length - 1) controller.enqueue(encoder.encode(','));
            });
            controller.enqueue(encoder.encode(']'));
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        }
      });
      if (compress && typeof CompressionStream !== 'undefined') {
        const gzipStream = jsonStream.pipeThrough(new CompressionStream('gzip'));
        const gzipBlob = await new Response(gzipStream).blob();
        return new Blob([gzipBlob], { type: 'application/gzip' });
      }
      const plainStream = jsonStream;
      const plainBlob = await new Response(plainStream).blob();
      return new Blob([plainBlob], { type: compress ? 'application/json' : 'application/json' });
    };

    try {
      jsonStr = JSON.stringify(dataForStringify);
    } catch (error) {
      const isRangeError = (error instanceof RangeError) || /invalid string length/i.test(error?.message || '');
      if (!allowStripFallback || !isRangeError) {
        throw error;
      }
      console.warn('备份数据过大，尝试移除图片后重试:', error);
      dataForStringify = Array.isArray(data)
        ? data.map((conv) => stripImagesFromConversation(conv, { keepImageRefs: !stripImagesOnFallback }))
        : stripImagesFromConversation(data, { keepImageRefs: !stripImagesOnFallback });
      try {
        jsonStr = JSON.stringify(dataForStringify);
        usedStripFallback = true;
      } catch (e) {
        // 二次仍失败时，改用流式构造 JSON 以规避超大字符串限制
        console.warn('备份数据仍然过大，改用流式构造 JSON:', e);
        useStreaming = true;
        usedStripFallback = true;
      }
    }

    if (useStreaming) {
      return { blob: await buildStreamBlob(Array.isArray(dataForStringify) ? dataForStringify : [dataForStringify]), usedStripFallback };
    }

    if (compress && typeof CompressionStream !== 'undefined') {
      try {
        const enc = new TextEncoder();
        const inputStream = new Blob([enc.encode(jsonStr)]).stream();
        const gzipStream = inputStream.pipeThrough(new CompressionStream('gzip'));
        const gzipBlob = await new Response(gzipStream).blob();
        return { blob: new Blob([gzipBlob], { type: 'application/gzip' }), usedStripFallback };
      } catch (e) {
        console.warn('压缩失败，回退至原始 JSON:', e);
        return { blob: new Blob([jsonStr], { type: 'application/json' }), usedStripFallback };
      }
    }
    return { blob: new Blob([jsonStr], { type: 'application/json' }), usedStripFallback };
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

  const base64FileCache = new Map(); // hash(base64) -> file://...
  const remoteFileCache = new Map();  // remoteUrl -> file://...
  const IMAGE_HASH_CACHE_KEY = 'image_hash_cache_v1';
  const DOWNLOAD_ROOT_KEY = 'image_download_root';
  let base64CacheLoaded = false;
  let downloadRootCache = null;

  async function loadBase64Cache() {
    if (base64CacheLoaded) return;
    try {
      const wrap = await chrome.storage.local.get([IMAGE_HASH_CACHE_KEY]);
      const cacheObj = wrap[IMAGE_HASH_CACHE_KEY] || {};
      Object.entries(cacheObj).forEach(([hash, url]) => base64FileCache.set(hash, url));
    } catch (e) {
      console.warn('加载图片哈希缓存失败:', e);
    } finally {
      base64CacheLoaded = true;
    }
  }

  async function persistBase64Cache() {
    try {
      const obj = {};
      base64FileCache.forEach((url, hash) => { obj[hash] = url; });
      await chrome.storage.local.set({ [IMAGE_HASH_CACHE_KEY]: obj });
    } catch (e) {
      console.warn('保存图片哈希缓存失败:', e);
    }
  }

  function getImageRoleFolder(role) {
    const r = String(role || '').toLowerCase();
    if (r === 'assistant' || r === 'ai') return 'AI';
    return 'User';
  }

  function guessExtFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    return 'png';
  }

  function guessExtFromUrl(url) {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname || '';
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) return match[1].toLowerCase();
    } catch (_) {}
    return null;
  }

  function normalizeFileUrl(filePath) {
    let normalizedPath = filePath.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(normalizedPath)) {
      normalizedPath = '/' + normalizedPath;
    }
    return `file://${normalizedPath}`;
  }

  function parseDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    if (!dataUrl.startsWith('data:image/')) return null;
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const mimeType = match[1] || 'image/png';
    const base64Data = match[2] || '';
    return { mimeType, base64Data, ext: guessExtFromMime(mimeType) };
  }

  function extractHashFromFileUrl(fileUrl) {
    try {
      if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) return null;
      let path = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
      if (/^[A-Za-z]:\//.test(path)) path = path.replace(/^\//, '');
      const base = (path.split(/[\\/]/).pop() || '').split('.').slice(0, -1).join('') || '';
      // 仅当文件名本身是纯十六进制串时才认定为哈希，避免日期_随机名被误判
      const candidate = base.match(/^[a-fA-F0-9]{16,64}$/);
      return candidate ? candidate[0].toLowerCase() : null;
    } catch (_) {
      return null;
    }
  }

  function normalizePath(p) {
    return (p || '').replace(/\\/g, '/');
  }

  async function loadDownloadRoot() {
    if (downloadRootCache) return downloadRootCache;
    try {
      const res = await chrome.storage.local.get([DOWNLOAD_ROOT_KEY]);
      const root = res[DOWNLOAD_ROOT_KEY];
      if (root && typeof root === 'string') {
        downloadRootCache = normalizePath(root).replace(/\/+$/, '') + '/';
        return downloadRootCache;
      }
    } catch (_) {}
    return null;
  }

  async function saveDownloadRoot(rootPath) {
    if (!rootPath) return;
    downloadRootCache = normalizePath(rootPath).replace(/\/+$/, '') + '/';
    try {
      await chrome.storage.local.set({ [DOWNLOAD_ROOT_KEY]: downloadRootCache });
    } catch (_) {}
  }

  async function setDownloadRootManual(rootPath) {
    if (!rootPath || typeof rootPath !== 'string') return;
    await saveDownloadRoot(rootPath);
  }

  function deriveRootFromAbsolute(absPath, relPath) {
    const abs = normalizePath(absPath);
    const rel = normalizePath(relPath || '');
    const idx = rel ? abs.lastIndexOf(rel) : -1;
    if (idx >= 0) {
      return abs.slice(0, idx);
    }
    // 尝试按 Images/ 分割
    const marker = '/Images/';
    const markerIdx = abs.indexOf(marker);
    if (markerIdx >= 0) {
      return abs.slice(0, markerIdx + 1); // 保留前导 /
    }
    return null;
  }

  function buildFileUrlFromRelative(relPath, rootPath) {
    if (!relPath) return null;
    const root = normalizePath(rootPath || downloadRootCache || '');
    const rel = normalizePath(relPath).replace(/^\/+/, '');
    if (!root) {
      return rel; // 无根路径时返回相对路径，避免生成 file:///Images/...
    }
    const full = `${root}${rel}`;
    let normalized = normalizePath(full);
    if (/^[A-Za-z]:\//.test(normalized)) {
      normalized = '/' + normalized;
    } else if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return `file://${normalized}`;
  }

  function fileUrlToRelative(fileUrl) {
    try {
      if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) return null;
      let path = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
      if (/^[A-Za-z]:\//.test(path)) path = path.replace(/^\//, '');
      const normalized = normalizePath(path);
      const root = downloadRootCache;
      if (root && normalized.startsWith(normalizePath(root))) {
        return normalized.slice(normalizePath(root).length);
      }
      const marker = '/Images/';
      const idx = normalized.indexOf(marker);
      if (idx >= 0) {
        const rel = normalized.slice(idx + 1); // 保留 Images/ 开头
        // 若未缓存根目录，则推断并保存
        if (!downloadRootCache) {
          const derivedRoot = normalized.slice(0, idx + 1);
          saveDownloadRoot(derivedRoot);
        }
        return rel;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async function resolveImageUrlForDisplay(imageUrlObj) {
    if (!imageUrlObj) return '';
    const rawUrl = imageUrlObj.url;
    const relPath = imageUrlObj.path || (rawUrl && !rawUrl.startsWith('file://') ? rawUrl : null);
    if (typeof rawUrl === 'string' && rawUrl.startsWith('file://')) return rawUrl;
    if (relPath) {
      const root = await loadDownloadRoot();
      // 如果没有 root，返回相对路径以避免生成错误的 file:///Images/...，需要用户手动设置根路径
      const fileUrl = root ? buildFileUrlFromRelative(relPath, root) : null;
      return fileUrl || relPath;
    }
    return rawUrl || '';
  }

  function formatTimestampForPath(ts) {
    const d = new Date(ts || Date.now());
    const pad2 = (n) => String(n).padStart(2, '0');
    const monthFolder = `${d.getFullYear()}_${pad2(d.getMonth() + 1)}`;
    const dateStr = [
      d.getFullYear(),
      pad2(d.getMonth() + 1),
      pad2(d.getDate()),
      pad2(d.getHours()),
      pad2(d.getMinutes()),
      pad2(d.getSeconds())
    ].join('');
    return { monthFolder, dateStr };
  }

  async function computeBase64Hash(base64Data) {
    try {
      const data = new TextEncoder().encode(base64Data);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('计算图片哈希失败，回退为长度标记:', e);
      return `len_${base64Data.length}`;
    }
  }

  async function waitForDownloadFile(downloadId, timeoutMs = 30000) {
    const start = Date.now();
    return await new Promise((resolve, reject) => {
      const tick = () => {
        try {
          chrome.downloads.search({ id: downloadId }, (items) => {
            const lastError = chrome.runtime?.lastError;
            if (lastError) return reject(new Error(lastError.message));
            const item = items && items[0];
            if (!item) return reject(new Error('找不到下载任务'));
            if (item.state === 'complete' && item.filename) return resolve(item.filename);
            if (item.state === 'interrupted') return reject(new Error(item.error || '下载被中断'));
            if (Date.now() - start > timeoutMs) return reject(new Error('下载超时'));
            setTimeout(tick, 400);
          });
        } catch (e) {
          reject(e);
        }
      };
      tick();
    });
  }

  async function saveImageContentToLocal({ base64Data, mimeType, roleFolder, timestamp }) {
    try {
      if (!chrome?.downloads?.download) return { fileUrl: null, relPath: null, hash: null };
      const ext = guessExtFromMime(mimeType) || 'png';
      const { dateStr } = formatTimestampForPath(timestamp);
      const fullHash = await computeBase64Hash(base64Data);
      const hash16 = toHash16(fullHash);
      const baseName = `${dateStr}_${hash16 || Math.random().toString(36).slice(2, 8)}`;
      const relPath = `Images/${roleFolder}/${dateStr.slice(0,4)}/${dateStr.slice(4,6)}/${dateStr.slice(6,8)}/${baseName}.${ext}`;

      // 优先尝试使用“预期文件路径”读取：若已存在同名文件则直接复用，避免重复下载
      try {
        const root = await loadDownloadRoot();
        const expectedFileUrl = root ? buildFileUrlFromRelative(relPath, root) : null;
        if (expectedFileUrl) {
          const resp = await fetch(expectedFileUrl);
          if (resp.ok) {
            return { fileUrl: expectedFileUrl, relPath, hash: fullHash };
          }
        }
      } catch (checkErr) {
        console.warn('检测既有图片文件失败，将继续下载流程:', checkErr);
      }

      const normalizedDataUrl = `data:${mimeType};base64,${base64Data}`;
      const filename = `Cerebr/${relPath}`;
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: normalizedDataUrl, filename, conflictAction: 'overwrite', saveAs: false },
          (id) => {
            const lastError = chrome.runtime?.lastError;
            if (lastError || typeof id !== 'number') {
              reject(new Error(lastError?.message || '下载失败'));
            } else {
              resolve(id);
            }
          }
        );
      });
      const filePath = await waitForDownloadFile(downloadId);
      if (filePath) {
        const root = deriveRootFromAbsolute(filePath, relPath);
        if (root) await saveDownloadRoot(root);
      }
      return {
        fileUrl: filePath ? normalizeFileUrl(filePath) : null,
        relPath,
        hash: fullHash
      };
    } catch (error) {
      console.error('保存图片失败:', error);
      return { fileUrl: null, relPath: null, hash: null };
    }
  }

  async function saveDataUrlToLocalFile(dataUrl, roleFolder, preferredName, options = {}) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return { fileUrl: null, relPath: null, hash: null };
    return await saveImageContentToLocal({
      base64Data: parsed.base64Data,
      mimeType: parsed.mimeType,
      roleFolder,
      timestamp: options.timestamp
    });
  }

  function toHash16(fullHash) {
    if (!fullHash || typeof fullHash !== 'string') return '';
    return fullHash.slice(0, 16);
  }

  async function blobToBase64(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || '';
        const str = typeof result === 'string' ? result : '';
        const base64 = str.split(',').pop() || '';
        resolve(base64);
      };
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(blob);
    });
  }

  async function getOrSaveDataUrlToLocalFile(dataUrl, roleFolder, options = {}) {
    // 不再根据哈希跳过保存，始终保存一份
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return { fileUrl: null, relPath: null, hash: null };
    return await saveImageContentToLocal({
      base64Data: parsed.base64Data,
      mimeType: parsed.mimeType,
      roleFolder,
      timestamp: options.timestamp
    });
  }

  async function saveRemoteImageToLocalFile(remoteUrl, roleFolder, options = {}) {
    try {
      const resp = await fetch(remoteUrl);
      if (!resp.ok) return { fileUrl: null, relPath: null, hash: null };
      const blob = await resp.blob();
      const base64 = await blobToBase64(blob);
      const mimeType = blob.type || `image/${guessExtFromUrl(remoteUrl) || 'png'}`;
      return await saveImageContentToLocal({
        base64Data: base64,
        mimeType,
        roleFolder,
        timestamp: options.timestamp
      });
    } catch (error) {
      console.warn('下载远程图片失败，已跳过:', remoteUrl, error);
      return { fileUrl: null, relPath: null, hash: null };
    }
  }

  async function getOrSaveRemoteImage(remoteUrl, roleFolder, options = {}) {
    // 不再基于文件名去重，始终保存
    return await saveRemoteImageToLocalFile(remoteUrl, roleFolder, options);
  }

  async function replaceDataUrlsInText(text, roleFolder, options = {}) {
    if (typeof text !== 'string') return { text, changed: false, found: 0, converted: 0, failed: 0 };
    let output = text;
    let changed = false;
    let found = 0;
    let converted = 0;
    let failed = 0;
    const matches = [...text.matchAll(DATA_URL_REGEX)];
    for (const m of matches) {
      found += 1;
      const dataUrl = m[0];
      const saved = await getOrSaveDataUrlToLocalFile(dataUrl, roleFolder, options);
      const replacement = saved?.relPath || saved?.fileUrl;
      if (replacement) {
        output = output.replace(dataUrl, replacement);
        converted += 1;
        changed = true;
      } else {
        failed += 1;
      }
    }
    return { text: output, changed, found, converted, failed };
  }

  async function repairImagesInMessage(msg) {
    await loadDownloadRoot();
    const roleFolder = getImageRoleFolder(msg?.role);
    const ts = Number(msg?.timestamp) || Date.now();
    let changed = false;
    let found = 0;
    let converted = 0;
    let failed = 0;

      if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (part?.type === 'image_url' && part.image_url?.url) {
          const url = part.image_url.url;
          if (typeof url === 'string' && url.startsWith('data:image/')) {
            found += 1;
          const saved = await getOrSaveDataUrlToLocalFile(url, roleFolder, { timestamp: ts });
            if (saved?.relPath || saved?.fileUrl) {
              if (saved.hash) part.image_url.hash = saved.hash;
              if (saved.relPath) {
                part.image_url.path = saved.relPath;
                delete part.image_url.url;
              } else if (saved.fileUrl) {
                part.image_url.url = saved.fileUrl;
              }
              converted += 1;
              changed = true;
            } else {
              failed += 1;
            }
          } else if (typeof url === 'string' && url.startsWith('http')) {
            // 将 http/https 远程图片也落盘，避免后续备份重复拉取
            const saved = await getOrSaveRemoteImage(url, roleFolder, { timestamp: ts });
            if (saved?.relPath || saved?.fileUrl) {
              if (saved.hash) part.image_url.hash = saved.hash;
              if (saved.relPath) {
                part.image_url.path = saved.relPath;
                delete part.image_url.url;
              } else if (saved.fileUrl) {
                part.image_url.url = saved.fileUrl;
              }
              converted += 1;
              changed = true;
            }
          } else if (typeof url === 'string' && url.startsWith('file://')) {
            // 已有本地文件但缺少哈希时尝试补写
            if (!part.image_url.hash) {
              const h = extractHashFromFileUrl(url);
              if (h) {
                part.image_url.hash = h;
                changed = true;
              }
            }
            if (!part.image_url.path) {
              const rel = fileUrlToRelative(url);
              if (rel) {
                part.image_url.path = rel;
                delete part.image_url.url;
                changed = true;
              }
            }
          }
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          const res = await replaceDataUrlsInText(part.text, roleFolder, { timestamp: ts });
          if (res.changed) {
            part.text = res.text;
            changed = true;
          }
          found += res.found;
          converted += res.converted;
          failed += res.failed;
        }
      }
    } else if (typeof msg?.content === 'string') {
      const res = await replaceDataUrlsInText(msg.content, roleFolder, { timestamp: ts });
      if (res.changed) {
        msg.content = res.text;
        changed = true;
      }
      found += res.found;
      converted += res.converted;
      failed += res.failed;
    }

    // 移除已无用的内容引用，避免保留旧的 base64 内容
    if (changed && msg.contentRef) delete msg.contentRef;

    return { changed, found, converted, failed };
  }

  async function repairRecentImages(options = {}) {
    const days = Math.max(1, Number(options.days || 7));
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const sp = utils.createStepProgress({ steps: ['加载会话', '处理图片', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    const recentMetas = (metas || []).filter((m) => Number(m?.endTime) >= cutoff);
    const total = recentMetas.length || 1;

    let updated = 0;
    let totalFound = 0;
    let totalConverted = 0;
    let totalFailed = 0;

    sp.next('处理图片');
    for (let i = 0; i < recentMetas.length; i++) {
      // 按需加载完整内容，避免一次性拉取全部会话导致内存暴涨
      const conv = await getConversationById(recentMetas[i].id, true);
      if (!conv) {
        sp.updateSub(i + 1, total, `处理图片 (${i + 1}/${total})`);
        continue;
      }
      let convChanged = false;
      if (Array.isArray(conv.messages)) {
        for (const msg of conv.messages) {
          const res = await repairImagesInMessage(msg);
          totalFound += res.found;
          totalConverted += res.converted;
          totalFailed += res.failed;
          if (res.changed) convChanged = true;
        }
      }
      if (convChanged) {
        conv.messageCount = Array.isArray(conv.messages) ? conv.messages.length : 0;
        conv.endTime = Number(conv.endTime) || conv.endTime || now;
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) {
          activeConversation = conv;
        }
        updated += 1;
      }
      sp.updateSub(i + 1, total, `处理图片 (${i + 1}/${total})`);
    }

    sp.complete('处理完成', true);
    invalidateMetadataCache();
    return {
      scannedConversations: recentMetas.length,
      updatedConversations: updated,
      base64Found: totalFound,
      convertedImages: totalConverted,
      failedConversions: totalFailed
    };
  }

  /**
   * 重新按 YYYY/MM/DD/HHMMSS_hash16 命名保存图片并更新路径/哈希
   * @param {{days?:number}} options
   */
  async function resaveImagesWithNewScheme(options = {}) {
    await loadDownloadRoot();
    const days = Math.max(1, Number(options.days || 365));
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const sp = utils.createStepProgress({ steps: ['加载会话', '重新保存', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    const recentMetas = (metas || []).filter((m) => Number(m?.endTime) >= cutoff);
    const total = recentMetas.length || 1;
    let updated = 0;

    sp.next('重新保存');
    console.info('[resaveImagesWithNewScheme] start', { metas: metas.length, filtered: recentMetas.length, days });
    for (let i = 0; i < recentMetas.length; i++) {
      const conv = await getConversationById(recentMetas[i].id, true);
      let convChanged = false;
      if (conv && Array.isArray(conv.messages)) {
        for (const msg of conv.messages) {
          if (!Array.isArray(msg.content)) continue;
          const ts = Number(msg?.timestamp) || Number(conv?.endTime) || Date.now();
          for (const part of msg.content) {
            if (part?.type !== 'image_url') continue;
            const raw = part.image_url?.path || part.image_url?.url || '';
            if (!raw) continue;
            try {
              let fileUrl = raw;
              if (!fileUrl.startsWith('http') && !fileUrl.startsWith('data:') && !fileUrl.startsWith('file://')) {
                const root = await loadDownloadRoot();
                fileUrl = root ? buildFileUrlFromRelative(raw, root) : null;
              }
              const resolved = await resolveToFileUrlForResave(fileUrl);
              if (!resolved) continue;
              const resp = await fetch(resolved);
              if (!resp.ok) continue;
              const blob = await resp.blob();
              const base64 = await blobToBase64(blob);
              const mimeType = blob.type || 'image/png';
              const saved = await saveImageContentToLocal({
                base64Data: base64,
                mimeType,
                roleFolder: getImageRoleFolder(msg.role),
                timestamp: ts
              });
              if (saved?.relPath) {
                part.image_url.path = saved.relPath;
                part.image_url.url = saved.relPath;
                if (saved.hash) part.image_url.hash = saved.hash;
                convChanged = true;
                console.info('[resaveImagesWithNewScheme] resaved', { convId: conv.id, msgId: msg.id, relPath: saved.relPath });
              }
            } catch (e) {
              console.warn('[resaveImagesWithNewScheme] skip image', { convId: conv.id, msgId: msg.id, raw, error: e?.message || e });
            }
          }
        }
      }
      if (convChanged) {
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updated += 1;
      }
      sp.updateSub(i + 1, total, `重新保存 (${i + 1}/${total})`);
    }
    sp.complete('完成', true);
    invalidateMetadataCache();
    const result = { updatedConversations: updated, scanned: recentMetas.length };
    console.info('[resaveImagesWithNewScheme] done', result);
    return result;
  }

  async function resolveToFileUrlForResave(rawUrl) {
    if (!rawUrl) return null;
    if (rawUrl.startsWith('file://') || rawUrl.startsWith('data:') || rawUrl.startsWith('http')) return rawUrl;
    const root = await loadDownloadRoot();
    return root ? buildFileUrlFromRelative(rawUrl, root) : null;
  }

  /**
   * 将现有消息中的 file:// 图片引用迁移为相对路径（Images/...），同时补写哈希（仅纯十六进制文件名）
   * @returns {Promise<{updated:number, scanned:number}>}
   */
  async function migrateImagePathsToRelative() {
    await loadDownloadRoot();
    const sp = utils.createStepProgress({ steps: ['加载会话', '迁移路径', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    const total = metas.length || 1;
    let updated = 0;

    sp.next('迁移路径');
    for (let i = 0; i < metas.length; i++) {
      const conv = await getConversationById(metas[i].id, true);
      let convChanged = false;
      if (conv && Array.isArray(conv.messages)) {
        for (const msg of conv.messages) {
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part?.type === 'image_url' && part.image_url?.url && !part.image_url?.path) {
                const rel = fileUrlToRelative(part.image_url.url);
                if (rel) {
                  part.image_url.path = rel;
                  part.image_url.url = rel;
                  const h = extractHashFromFileUrl(part.image_url.url);
                  if (h) part.image_url.hash = h;
                  convChanged = true;
                }
              }
            }
          }
        }
      }
      if (convChanged) {
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updated += 1;
      }
      sp.updateSub(i + 1, total, `迁移路径 (${i + 1}/${total})`);
    }

    sp.complete('完成', true);
    invalidateMetadataCache();
    return { updated, scanned: metas.length };
  }

  /**
   * 检查 image_url.path 与 image_url.url 的一致性，统计差异并给出示例
   * @param {number} [sampleLimit=20]
   * @returns {Promise<{total:number, same:number, mismatch:number, pathOnly:number, urlOnly:number, samples:Array<Object>, urlOnlySamples:Array<Object>}>}
   */
  async function checkImagePathUrlMismatch(sampleLimit = 20) {
    const metas = await getAllConversationMetadata();
    let total = 0;
    let same = 0;
    let mismatch = 0;
    let pathOnly = 0;
    let urlOnly = 0;
    const samples = [];
    const urlOnlySamples = [];

    const normalizeRel = (p) => normalizePath(p || '').replace(/^\/+/, '');
    const normalizeUrl = (u) => {
      if (!u) return '';
      if (u.startsWith('file://')) {
        let p = decodeURIComponent(u.replace(/^file:\/\//, ''));
        if (/^[A-Za-z]:\//.test(p)) p = p.replace(/^\//, '');
        return normalizeRel(p);
      }
      return normalizeRel(u);
    };

    for (const meta of metas) {
      const conv = await getConversationById(meta.id, true);
      if (!conv || !Array.isArray(conv.messages)) continue;
      for (const msg of conv.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          if (part?.type !== 'image_url') continue;
          total += 1;
          const rawPath = part.image_url?.path || '';
          const rawUrl = part.image_url?.url || '';
          const normPath = normalizeRel(rawPath);
          const normUrl = normalizeUrl(rawUrl);
          if (normPath && normUrl) {
            if (normUrl.endsWith(normPath)) {
              same += 1;
            } else {
              mismatch += 1;
              if (samples.length < sampleLimit) {
                samples.push({
                  conversationId: conv.id,
                  messageId: msg.id,
                  path: rawPath,
                  url: rawUrl
                });
              }
            }
          } else if (normPath && !normUrl) {
            pathOnly += 1;
          } else if (!normPath && normUrl) {
            urlOnly += 1;
            if (urlOnlySamples.length < sampleLimit) {
              urlOnlySamples.push({
                conversationId: conv.id,
                messageId: msg.id,
                url: rawUrl
              });
            }
          }
        }
      }
    }

    return { total, same, mismatch, pathOnly, urlOnly, samples, urlOnlySamples };
  }

  /**
   * 清理 image_url 中重复的 url 字段：
   * - 尝试从 file:// 或相对 url 补全 path
   * - 若 path 存在且 url 相同则移除 url
   */
  async function cleanImageUrlFields() {
    await loadDownloadRoot();
    const metas = await getAllConversationMetadata();
    let updated = 0;
    let removedUrl = 0;
    let addedPath = 0;
    const normalizeRel = (p) => normalizePath(p || '').replace(/^\/+/, '');

    for (const meta of metas) {
      const conv = await getConversationById(meta.id, true);
      let convChanged = false;
      if (!conv || !Array.isArray(conv.messages)) continue;

      for (const msg of conv.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          if (part?.type !== 'image_url') continue;
          const img = part.image_url || {};
          let relPath = normalizeRel(img.path);
          const rawUrl = img.url || '';

          if (!relPath && rawUrl) {
            const derived = rawUrl.startsWith('file://')
              ? fileUrlToRelative(rawUrl)
              : normalizeRel(rawUrl);
            if (derived) {
              img.path = derived;
              relPath = derived;
              addedPath += 1;
              convChanged = true;
            }
          }

          if (relPath && rawUrl) {
            const normUrl = rawUrl.startsWith('file://')
              ? normalizeRel(fileUrlToRelative(rawUrl) || '')
              : normalizeRel(rawUrl);
            if (!normUrl || normUrl.endsWith(relPath)) {
              delete img.url;
              removedUrl += 1;
              convChanged = true;
            }
          }

          part.image_url = img;
        }
      }

      if (convChanged) {
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updated += 1;
      }
    }

    invalidateMetadataCache();
    return { updatedConversations: updated, removedUrl, addedPath };
  }

  /**
   * 清理 IndexedDB 中孤立的 messageContents 记录，避免无引用的图片残留占用空间
   * @returns {Promise<{removed:number,total:number}>}
   */
  async function purgeOrphanImageContents() {
    return await purgeOrphanMessageContents();
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
    const defaults = {
      incrementalDefault: true,
      excludeImagesDefault: false,
      compressDefault: true,
      autoBackupEnabled: false,
      autoBackupIntervalMin: 60,
      autoBackupMode: 'hourly', // 'hourly' | 'daily'
      autoBackupHourlyHours: 1, // 每N小时
      autoBackupDailyTime: '02:00', // 每天固定时间 HH:MM
      lastIncrementalBackupAt: 0,
      lastFullBackupAt: 0,
      lastFullResetBackupAt: 0,
      incSequence: 0
    };
    const prefs = await storageService.getJSON(BACKUP_PREFS_KEY, defaults, { area: 'sync' });
    return { ...defaults, ...prefs };
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

    const makeRow = (extraClass = '') => {
      const row = document.createElement('div');
      row.className = 'backup-form-row' + (extraClass ? ' ' + extraClass : '');
      return row;
    };

    const manualSection = document.createElement('div');
    manualSection.className = 'backup-section';

    const manualTitle = document.createElement('div');
    manualTitle.className = 'backup-panel-title';
    manualTitle.textContent = '手动备份';
    manualSection.appendChild(manualTitle);

    const manualButtons = document.createElement('div');
    manualButtons.className = 'backup-button-group';

    const fullIncludeBtn = document.createElement('button');
    fullIncludeBtn.className = 'backup-button';
    fullIncludeBtn.textContent = '全量备份（包含图片）';
    manualButtons.appendChild(fullIncludeBtn);

    const slimBtn = document.createElement('button');
    slimBtn.className = 'backup-button';
    slimBtn.textContent = '精简备份（不含图片）';
    manualButtons.appendChild(slimBtn);

    const fullResetBtn = document.createElement('button');
    fullResetBtn.className = 'backup-button';
    fullResetBtn.textContent = '全量备份并重置增量';
    manualButtons.appendChild(fullResetBtn);

    manualSection.appendChild(manualButtons);
    container.appendChild(manualSection);

    const rowZip = document.createElement('div');
    rowZip.className = 'switch-row backup-form-row';
    const switchZip = document.createElement('label');
    switchZip.className = 'switch';
    const cbZip = document.createElement('input');
    cbZip.type = 'checkbox';
    const sliderZip = document.createElement('span');
    sliderZip.className = 'slider';
    switchZip.appendChild(cbZip);
    switchZip.appendChild(sliderZip);
    const zipText = document.createElement('span');
    zipText.className = 'switch-text';
    zipText.textContent = '默认压缩为 .json.gz（不支持则回退 .json）';
    rowZip.appendChild(zipText);
    rowZip.appendChild(switchZip);
    container.appendChild(rowZip);

    const manualHint = document.createElement('div');
    manualHint.className = 'backup-panel-hint';
    manualHint.textContent = '备份将保存到 “下载/Cerebr/” 子目录。';
    container.appendChild(manualHint);

    const incrementalSection = document.createElement('div');
    incrementalSection.className = 'backup-section';

    const incrementalTitle = document.createElement('div');
    incrementalTitle.className = 'backup-panel-subtitle';
    incrementalTitle.textContent = '增量备份管理';
    incrementalSection.appendChild(incrementalTitle);

    const rowAuto = document.createElement('div');
    rowAuto.className = 'switch-row backup-form-row';
    const switchAuto = document.createElement('label');
    switchAuto.className = 'switch';
    const cbAuto = document.createElement('input');
    cbAuto.type = 'checkbox';
    const sliderAuto = document.createElement('span');
    sliderAuto.className = 'slider';
    switchAuto.appendChild(cbAuto);
    switchAuto.appendChild(sliderAuto);
    const autoText = document.createElement('span');
    autoText.className = 'switch-text';
    autoText.textContent = '启用自动增量备份';
    rowAuto.appendChild(autoText);
    rowAuto.appendChild(switchAuto);
    incrementalSection.appendChild(rowAuto);

    const scheduleRow = makeRow('backup-form-row--select');
    const scheduleLabel = document.createElement('label');
    scheduleLabel.className = 'backup-form-label';
    scheduleLabel.textContent = '调度模式';
    const scheduleSelect = document.createElement('select');
    const optHourly = document.createElement('option');
    optHourly.value = 'hourly';
    optHourly.textContent = '每N小时';
    const optDaily = document.createElement('option');
    optDaily.value = 'daily';
    optDaily.textContent = '每天固定时间';
    scheduleSelect.appendChild(optHourly);
    scheduleSelect.appendChild(optDaily);
    scheduleRow.appendChild(scheduleLabel);
    scheduleRow.appendChild(scheduleSelect);
    incrementalSection.appendChild(scheduleRow);

    const hourlyRow = makeRow('backup-form-row--inline');
    const hourlyLabel = document.createElement('label');
    hourlyLabel.className = 'backup-form-label';
    hourlyLabel.textContent = '间隔（小时）';
    const hourlyInput = document.createElement('input');
    hourlyInput.type = 'number';
    hourlyInput.min = '1';
    hourlyInput.step = '1';
    hourlyRow.appendChild(hourlyLabel);
    hourlyRow.appendChild(hourlyInput);
    incrementalSection.appendChild(hourlyRow);

    const dailyRow = makeRow('backup-form-row--inline');
    const dailyLabel = document.createElement('label');
    dailyLabel.className = 'backup-form-label';
    dailyLabel.textContent = '时间（每天）';
    const dailyInput = document.createElement('input');
    dailyInput.type = 'time';
    dailyRow.appendChild(dailyLabel);
    dailyRow.appendChild(dailyInput);
    incrementalSection.appendChild(dailyRow);

    const infoList = document.createElement('div');
    infoList.className = 'backup-info-list';
    incrementalSection.appendChild(infoList);

    const createInfoItem = (label) => {
      const item = document.createElement('div');
      item.className = 'backup-info-item';
      const labelEl = document.createElement('span');
      labelEl.className = 'backup-info-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'backup-info-value';
      valueEl.textContent = '加载中...';
      item.appendChild(labelEl);
      item.appendChild(valueEl);
      infoList.appendChild(item);
      return valueEl;
    };

    const fullResetInfoValue = createInfoItem('上次全量并重置：');
    const lastIncrementalInfoValue = createInfoItem('上次增量备份：');
    const nextIncrementalInfoValue = createInfoItem('下次预计增量：');

    container.appendChild(incrementalSection);

    const fmt = (t) => t ? new Date(t).toLocaleString() : '从未';
    const computeNextTs = (prefs) => {
      if (!prefs.autoBackupEnabled) return null;
      const now = Date.now();
      if ((prefs.autoBackupMode || 'hourly') === 'daily') {
        const parts = String(prefs.autoBackupDailyTime || '02:00').split(':');
        const hh = parseInt(parts[0], 10) || 0;
        const mm = parseInt(parts[1], 10) || 0;
        const today = new Date();
        today.setHours(hh, mm, 0, 0);
        const todayTs = today.getTime();
        if (now < todayTs) return todayTs;
        return todayTs + 24 * 60 * 60 * 1000;
      }
      const hours = Math.max(1, Number(prefs.autoBackupHourlyHours || 1));
      const last = Number(prefs.lastIncrementalBackupAt || 0);
      const intervalMs = hours * 60 * 60 * 1000;
      return last ? (last + intervalMs) : (now + intervalMs);
    };

    const applyPreferencesToUI = (prefs) => {
      cbZip.checked = prefs.compressDefault !== false;
      const autoEnabled = !!prefs.autoBackupEnabled;
      cbAuto.checked = autoEnabled;
      scheduleSelect.value = prefs.autoBackupMode || 'hourly';
      hourlyInput.value = String(prefs.autoBackupHourlyHours || 1);
      dailyInput.value = prefs.autoBackupDailyTime || '02:00';
      hourlyRow.style.display = scheduleSelect.value == 'hourly' ? 'flex' : 'none';
      dailyRow.style.display = scheduleSelect.value == 'daily' ? 'flex' : 'none';
      scheduleSelect.disabled = !autoEnabled;
      hourlyInput.disabled = !autoEnabled;
      dailyInput.disabled = !autoEnabled;
      fullResetInfoValue.textContent = fmt(prefs.lastFullResetBackupAt);
      lastIncrementalInfoValue.textContent = fmt(prefs.lastIncrementalBackupAt);
      if (autoEnabled) {
        const nextTs = computeNextTs(prefs);
        nextIncrementalInfoValue.textContent = nextTs ? new Date(nextTs).toLocaleString() : '计算中...';
      } else {
        nextIncrementalInfoValue.textContent = '计划未启用';
      }
    };

    const refreshPreferences = async () => {
      try {
        const saved = await loadBackupPreferencesDownloadsOnly();
        applyPreferencesToUI(saved);
      } catch (error) {
        fullResetInfoValue.textContent = '加载失败';
        lastIncrementalInfoValue.textContent = '加载失败';
        nextIncrementalInfoValue.textContent = '加载失败';
      }
    };

    cbZip.addEventListener('change', async () => {
      const updated = await saveBackupPreferencesDownloadsOnly({ compressDefault: !!cbZip.checked });
      applyPreferencesToUI(updated);
    });
    cbAuto.addEventListener('change', async () => {
      const updated = await saveBackupPreferencesDownloadsOnly({ autoBackupEnabled: !!cbAuto.checked });
      applyPreferencesToUI(updated);
      restartAutoBackupScheduler?.();
    });
    scheduleSelect.addEventListener('change', async () => {
      const mode = scheduleSelect.value === 'daily' ? 'daily' : 'hourly';
      hourlyRow.style.display = mode === 'hourly' ? 'flex' : 'none';
      dailyRow.style.display = mode === 'daily' ? 'flex' : 'none';
      const updated = await saveBackupPreferencesDownloadsOnly({ autoBackupMode: mode });
      applyPreferencesToUI(updated);
      restartAutoBackupScheduler?.();
    });

    hourlyInput.addEventListener('change', async () => {
      const value = Math.max(1, Number(hourlyInput.value) || 1);
      hourlyInput.value = String(value);
      const updated = await saveBackupPreferencesDownloadsOnly({ autoBackupHourlyHours: value });
      applyPreferencesToUI(updated);
      restartAutoBackupScheduler?.();
    });

    dailyInput.addEventListener('change', async () => {
      const timeValue = dailyInput.value || '02:00';
      const updated = await saveBackupPreferencesDownloadsOnly({ autoBackupDailyTime: timeValue });
      applyPreferencesToUI(updated);
      restartAutoBackupScheduler?.();
    });

    const runManualBackup = async (extraOptions = {}) => {
      await backupConversations({ mode: 'full', ...extraOptions });
      await refreshPreferences();
      restartAutoBackupScheduler?.();
    };

    fullIncludeBtn.addEventListener('click', async () => {
      await runManualBackup({ excludeImages: false });
    });

    slimBtn.addEventListener('click', async () => {
      await runManualBackup({ excludeImages: true });
    });

    fullResetBtn.addEventListener('click', async () => {
      await runManualBackup({ excludeImages: false, resetIncremental: true });
    });

    refreshPreferences();

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

  /**
   * 从剪贴板导入一条新的聊天记录
   * 剪贴板内容格式要求为纯字符串数组 JSON，例如：["第一条用户消息","第一条AI回复"]
   * 假定消息从用户开始，用户/AI 交替排列
   */
  async function importConversationFromClipboard() {
    const showNotificationSafe = typeof showNotification === 'function' ? showNotification : null;

    // 由于 Permissions Policy 限制，直接调用 Clipboard API 可能被阻止，这里改为让用户手动粘贴 JSON
    const hint = '请粘贴聊天 JSON 字符串数组，例如 ["第一条用户消息","第一条AI回复"]';
    let rawText = window.prompt(hint, '');

    if (rawText === null) {
      // 用户取消，不视为错误
      return;
    }

    rawText = (rawText || '').trim();
    if (!rawText) {
      showNotificationSafe?.({
        message: '未输入任何内容，已取消导入',
        type: 'warning',
        duration: 2000
      });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      console.error('解析导入 JSON 失败:', error);
      showNotificationSafe?.({
        message: '内容不是有效的 JSON，请确认格式如 ["用户消息","AI回复"]',
        type: 'error',
        duration: 2800
      });
      return;
    }

    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(item => typeof item === 'string')) {
      showNotificationSafe?.({
        message: '导入 JSON 必须是字符串数组，例如 ["第一条用户消息","第一条AI回复"]',
        type: 'warning',
        duration: 3200
      });
      return;
    }

    try {
      // 先清空当前会话（内部会自动保存已有内容）
      await clearChatHistory();

      // 按“用户-助手-用户-助手”顺序构建新会话
      let isUserTurn = true;
      for (const text of parsed) {
        const content = typeof text === 'string' ? text : String(text);
        const sender = isUserTurn ? 'user' : 'ai';
        appendMessage(content, sender, false, null, null, null, null);
        isUserTurn = !isUserTurn;
      }

      // 保存为新的持久化会话，使用当前页面信息作为元数据
      await saveCurrentConversation(false);

      // 通知消息发送器当前会话 ID 已更新，后续继续聊天时可以接在导入记录之后
      if (currentConversationId) {
        services.messageSender.setCurrentConversationId(currentConversationId);
      }

      showNotificationSafe?.({
        message: '已从剪贴板导入一条新的聊天记录',
        type: 'success',
        duration: 2200
      });

      // 关闭历史面板，让用户直接回到聊天界面
      closeChatHistoryPanel();
    } catch (error) {
      console.error('导入聊天记录失败:', error);
      showNotificationSafe?.({
        message: '导入聊天记录失败，请检查剪贴板内容或稍后重试',
        type: 'error',
        duration: 3200
      });
    }
  }

  // ---- 自动备份调度 ----
  let autoBackupTimerId = null;
  async function autoBackupTick() {
    try {
      const prefs = await loadBackupPreferencesDownloadsOnly();
      if (!prefs.autoBackupEnabled) return;
      const now = Date.now();
      const last = Number(prefs.lastIncrementalBackupAt || 0);
      let due = false;
      if ((prefs.autoBackupMode || 'hourly') === 'daily') {
        const [hh, mm] = String(prefs.autoBackupDailyTime || '02:00').split(':').map(x => parseInt(x, 10) || 0);
        const today = new Date(); today.setHours(hh, mm, 0, 0);
        const todayTs = today.getTime();
        const yesterdayTs = todayTs - 24 * 60 * 60 * 1000;
        if (now >= todayTs && last < todayTs) due = true;
        else if (now < todayTs && last < yesterdayTs) due = true;
      } else {
        const hours = Math.max(1, Number(prefs.autoBackupHourlyHours || 1));
        const intervalMs = hours * 60 * 60 * 1000;
        due = last <= 0 ? (now >= intervalMs) : (now >= (last + intervalMs));
      }
      if (!due) return;
      const locked = await acquireAutoBackupLock(2 * 60 * 1000);
      if (!locked) return;
      try {
        await backupConversations({ mode: 'incremental', auto: true });
      } finally {
        await releaseAutoBackupLock();
      }
    } catch (_) {}
  }

  function startAutoBackupScheduler() {
    if (autoBackupTimerId) clearInterval(autoBackupTimerId);
    autoBackupTimerId = setInterval(autoBackupTick, 60 * 1000);
  }
  function stopAutoBackupScheduler() {
    if (autoBackupTimerId) { clearInterval(autoBackupTimerId); autoBackupTimerId = null; }
  }
  function restartAutoBackupScheduler() { stopAutoBackupScheduler(); startAutoBackupScheduler(); }

  // 启动自动备份调度器
  startAutoBackupScheduler();

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
    createForkConversation,
    restartAutoBackupScheduler,
    repairRecentImages,
    purgeOrphanImageContents,
    migrateImagePathsToRelative,
    resaveImagesWithNewScheme,
    setDownloadRootManual,
    checkImagePathUrlMismatch,
    cleanImageUrlFields,
    scanDataUrlsInDb
  };
}
