/**
 * 聊天历史界面管理模块 - 负责聊天历史的UI展示、交互和持久化
 * @module ChatHistoryUI
 */

import { 
  getAllConversationMetadata, 
  getAllConversations, 
  getConversationMetadataByIds,
  getConversationMetadataPageByEndTimeDesc,
  listConversationMetadataByUrlCandidates,
  putConversation, 
  deleteConversation, 
  getConversationById,
  getConversationsByIds,
  loadMessageContent,
  loadMessageContentsByIds,
  getDatabaseStats,
  purgeOrphanMessageContents
} from '../storage/indexeddb_helper.js';
import { storageService } from '../utils/storage_service.js';
import { extractThinkingFromText, mergeThoughts } from '../utils/thoughts_parser.js';
import { generateCandidateUrls } from '../utils/url_candidates.js';
import { buildConversationSummaryFromMessages } from '../utils/conversation_title.js';
import { normalizeStoredMessageContent, splitStoredMessageContent } from '../utils/message_content.js';

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
  const conversationPresence = services.conversationPresence;

  let currentConversationId = null;
  // let currentPageInfo = null; // Replaced by appContext.state.pageInfo or parameter to updatePageInfo
  
  // 内存管理设置 - 始终启用
  let activeConversation = null;       // 当前活动的会话对象
  let maxLoadedConversations = 5;      // 最大加载到内存的会话数
  let loadedConversations = new Map(); // 已加载到内存的会话缓存
  
  // 缓存数据库统计信息
  let cachedDbStats = null;
  let lastStatsUpdateTime = 0;
  const STATS_CACHE_DURATION = 5 * 60 * 1000; // 5分钟更新一次统计数据

  // --- 元数据缓存（UI层） ---
  let metaCache = { data: null, time: 0, promise: null };
  // 说明：默认列表使用 paged 模式，不会预先拉取全量元数据；一旦用户输入“全文搜索”，就必须拿到全量元数据。
  // 为避免“输入停下后卡一秒才开始显示搜索进度”，这里把 TTL 设长一些，并对并发请求做去重。
  const META_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存元数据（有显式 invalidateMetadataCache 兜底）

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
    metaCache.promise = null;
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
    const stale = forceUpdate || !metaCache.data || (Date.now() - metaCache.time > META_CACHE_TTL);
    if (!stale) return metaCache.data;

    // 并发去重：同一时间只允许一次“全量元数据”加载，避免打开面板预热 + 输入搜索同时触发两次全量扫描。
    if (metaCache.promise) {
      try {
        return await metaCache.promise;
      } catch (_) {
        // 若之前的 promise 失败，则允许继续走下面的重新加载逻辑。
      }
    }

    metaCache.promise = (async () => {
      const data = await getAllConversationMetadata();
      metaCache.data = data;
      metaCache.time = Date.now();
      return data;
    })();

    try {
      return await metaCache.promise;
    } finally {
      metaCache.promise = null;
    }
  }

  function scheduleConversationMetadataWarmup(panel) {
    // 说明：
    // - 默认历史列表走 paged 模式，首屏速度快，但“第一次全文搜索”需要全量元数据；
    // - 这里用 idle/延迟的方式预热元数据，降低用户输入后的启动延迟。
    try {
      if (!panel || !panel.classList.contains('visible')) return;
    } catch (_) {
      return;
    }

    // 已有缓存/正在加载则不重复预热
    if (metaCache.data || metaCache.promise) return;

    const runWarmup = async () => {
      try {
        await getAllConversationMetadataWithCache(false);
      } catch (_) {}
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => {
        try {
          if (!panel.classList.contains('visible')) return;
        } catch (_) {
          return;
        }
        if (metaCache.data || metaCache.promise) return;
        runWarmup();
      }, { timeout: 1200 });
    } else {
      setTimeout(() => {
        try {
          if (!panel.classList.contains('visible')) return;
        } catch (_) {
          return;
        }
        if (metaCache.data || metaCache.promise) return;
        runWarmup();
      }, 600);
    }
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

/* --- 分支会话树状视图（仅影响历史面板）---
 * 说明：
 * - 树状视图只在“无筛选”时启用树排序；这里仅提供缩进与引导线的视觉样式；
 * - 缩进层级由 JS 写入 --branch-depth（见 createConversationItemElement）。
 */
#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item {
  --branch-depth: 0;
}

#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item.branch-tree-child {
  position: relative;
  padding-left: calc((var(--branch-depth) * 14px) + 8px);
}

#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item.branch-tree-child::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: calc(var(--branch-depth) * 14px);
  background-image: repeating-linear-gradient(
    to right,
    rgba(255, 255, 255, 0.08) 0,
    rgba(255, 255, 255, 0.08) 1px,
    transparent 1px,
    transparent 14px
  );
  pointer-events: none;
  opacity: 0.7;
}

#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item.branch-tree-child::after {
  content: '↳';
  position: absolute;
  left: calc((var(--branch-depth) * 14px) - 10px);
  top: 7px;
  font-size: 12px;
  line-height: 1;
  color: var(--cerebr-text-color);
  opacity: 0.65;
  pointer-events: none;
}

/* 非树状模式下：对“分支会话”给一个轻量提示（不改结构，只提示有父会话） */
#chat-history-panel .chat-history-item.forked-conversation .summary::before {
  content: '↳ ';
  opacity: 0.65;
  font-weight: normal;
}
#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item.forked-conversation .summary::before {
  content: '';
}
#chat-history-panel .chat-history-item.forked-orphan .summary::before {
  content: '↳? ';
}
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
  // 默认视图性能优化：首次只取“置顶 + 最近 50 条（非置顶）”，后续按需再分页追加
  const INITIAL_UNPINNED_LOAD_LIMIT = 50;
  const PAGED_UNPINNED_LOAD_SIZE = 100;
  // 搜索框输入防抖（越小越敏捷，但会更频繁触发全文扫描；runId 取消机制会兜底避免旧任务污染 UI）
  const HISTORY_SEARCH_DEBOUNCE_MS = 80;
  let currentDisplayItems = []; // 当前筛选和排序后的所有项目
  let currentlyRenderedCount = 0; // 已渲染的项目数量
  let isLoadingMoreItems = false; // 防止并发加载的标志
  let currentGroupLabelForBatchRender = null; // 跨批次跟踪“分组 key”（默认按日期；URL 模式按匹配等级）
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
  function extractPlainTextFromMessageContent(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map(part => part?.type === 'image_url' ? '[图片]' : (part?.text?.trim() || ''))
        .filter(Boolean)
        .join(' ');
    }
    return '';
  }

  function extractMessagePlainText(msg) {
    if (!msg) return '';
    return extractPlainTextFromMessageContent(msg.content);
  }

  /**
   * 创建“全文搜索取消检查器”。
   *
   * 说明：
   * - 搜索是长任务；用户每次输入都会触发新一轮 runId；
   * - 旧任务必须尽快退出，否则会造成无谓的 IndexedDB 读取与 UI 抖动。
   *
   * @param {HTMLElement} panel
   * @param {string} runId
   * @returns {() => boolean} 返回 true 表示本轮任务已取消
   */
  function createSearchCancelledChecker(panel, runId) {
    return () => panel?.dataset?.runId !== runId;
  }

  /**
   * 全文搜索（阶段1）：仅扫描 conversations 记录内联 messages 的文本内容。
   *
   * 返回值约定：
   * - matched=true：matchInfo 已包含 excerpts，可直接使用；
   * - matched=false：若 pendingContentRefs 非空，则说明需要进一步解引用 messageContents 才能保证搜索正确性。
   *
   * @param {Object} conversation
   * @param {string} filterText
   * @param {string} lowerFilter
   * @param {() => boolean} isCancelled
   * @returns {{ cancelled: boolean, matched: boolean, matchInfo: {messageId:string|null, excerpts:Array<Object>, reason:string}, pendingContentRefs: Array<{messageId:string|null, contentRef:string}> }}
   */
  function scanConversationInlineMessagesForMatch(conversation, filterText, lowerFilter, isCancelled) {
    const empty = { cancelled: false, matched: false, matchInfo: { messageId: null, excerpts: [], reason: 'message' }, pendingContentRefs: [] };
    if (!conversation || !Array.isArray(conversation.messages)) return empty;

    const matchInfo = { messageId: null, excerpts: [], reason: 'message' };
    const MAX_EXCERPTS = 20;
    const pendingContentRefs = [];
    let matched = false;

    for (const message of conversation.messages) {
      if (isCancelled()) return { ...empty, cancelled: true };
      if (!message) continue;

      const plainText = extractMessagePlainText(message);
      if (plainText) {
        if (plainText.toLowerCase().includes(lowerFilter)) {
          matched = true;
          if (!matchInfo.messageId && message.id) matchInfo.messageId = message.id;
          if (matchInfo.excerpts.length < MAX_EXCERPTS) {
            const excerpt = buildExcerptSegments(plainText, filterText, lowerFilter);
            if (excerpt) matchInfo.excerpts.push(excerpt);
          }
          if (matchInfo.excerpts.length >= MAX_EXCERPTS) break;
        }
        continue;
      }

      // contentRef：大型内容（例如图片消息）会被单独存入 messageContents。
      if (message.contentRef) {
        pendingContentRefs.push({ messageId: message.id || null, contentRef: message.contentRef });
      }
    }

    return { cancelled: false, matched, matchInfo, pendingContentRefs };
  }

  /**
   * 全文搜索（阶段2）：对 pendingContentRefs 执行解引用并扫描文本。
   *
   * 注意：该函数不做“是否需要扫描”的判断；调用方应当只在阶段1未命中时调用。
   *
   * @param {Array<{messageId:string|null, contentRef:string}>} pendingContentRefs
   * @param {Map<string, any>} contentMap - contentRefId -> content
   * @param {string} filterText
   * @param {string} lowerFilter
   * @param {() => boolean} isCancelled
   * @param {{messageId:string|null, excerpts:Array<Object>, reason:string}} matchInfo - 会被原地追加 excerpts/messageId
   * @returns {{ cancelled: boolean, matched: boolean, matchInfo: {messageId:string|null, excerpts:Array<Object>, reason:string} }}
   */
  function scanConversationContentRefsForMatch(pendingContentRefs, contentMap, filterText, lowerFilter, isCancelled, matchInfo) {
    const MAX_EXCERPTS = 20;
    const refs = Array.isArray(pendingContentRefs) ? pendingContentRefs : [];
    const map = contentMap instanceof Map ? contentMap : new Map();
    const info = matchInfo && typeof matchInfo === 'object' ? matchInfo : { messageId: null, excerpts: [], reason: 'message' };

    let matched = false;
    for (const ref of refs) {
      if (isCancelled()) return { cancelled: true, matched: false, matchInfo: info };
      if (!ref?.contentRef) continue;

      const content = map.get(ref.contentRef);
      if (content == null) continue;

      const plainText = extractPlainTextFromMessageContent(content);
      if (!plainText) continue;
      if (!plainText.toLowerCase().includes(lowerFilter)) continue;

      matched = true;
      if (!info.messageId && ref.messageId) info.messageId = ref.messageId;
      if (info.excerpts.length < MAX_EXCERPTS) {
        const excerpt = buildExcerptSegments(plainText, filterText, lowerFilter);
        if (excerpt) info.excerpts.push(excerpt);
      }
      if (info.excerpts.length >= MAX_EXCERPTS) break;
    }

    return { cancelled: false, matched, matchInfo: info };
  }

  /**
   * 全文搜索：按需从 IndexedDB 读取会话并扫描消息内容，返回匹配信息。
   *
   * 设计目标（关键性能点）：
   * - 不污染 UI 的会话缓存（loadedConversations），避免搜索过程导致缓存暴涨/刷屏日志；
   * - 优先只读取 conversations 表（loadFullContent=false），避免不必要地解引用 messageContents（图像等大对象）；
   * - 仅当会话在“内联消息文本”中未命中，才按需解引用 contentRef（保证搜索正确性）。
   *
   * @param {string} conversationId
   * @param {string} filterText - 原始搜索词（用于 excerpt 高亮）
   * @param {string} lowerFilter - 小写后的搜索词
   * @param {HTMLElement} panel - 用于 runId 取消判断
   * @param {string} runId
   * @returns {Promise<{messageId:string|null, excerpts:Array<Object>, reason:string}|null>}
   */
  async function scanConversationForTextMatch(conversationId, filterText, lowerFilter, panel, runId) {
    if (!conversationId) return null;

    let conversation = null;
    try {
      // 重要：这里显式禁止加载 messageContents，避免把图片等大对象拉进内存。
      conversation = await getConversationById(conversationId, false);
    } catch (error) {
      console.error(`搜索会话 ${conversationId} 失败:`, error);
      return null;
    }

    if (!conversation || !Array.isArray(conversation.messages)) return null;
    const isCancelled = createSearchCancelledChecker(panel, runId);
    if (isCancelled()) return null;

    // 阶段1：扫描 conversations 记录内的消息文本（不解引用 contentRef）
    const inlineScan = scanConversationInlineMessagesForMatch(conversation, filterText, lowerFilter, isCancelled);
    if (inlineScan.cancelled) return null;
    if (inlineScan.matched) return inlineScan.matchInfo;

    // 阶段2：仅在阶段1未命中时，按需解引用 contentRef（批量读取，避免多次事务）
    const pendingRefs = Array.isArray(inlineScan.pendingContentRefs) ? inlineScan.pendingContentRefs : [];
    if (pendingRefs.length === 0) return null;

    const contentRefIds = pendingRefs.map((r) => r?.contentRef).filter(Boolean);
    let contentMap = new Map();
    try {
      contentMap = await loadMessageContentsByIds(contentRefIds);
    } catch (_) {
      // contentRef 缺失/读取失败时不阻断整个搜索流程，直接按“未命中”处理。
      contentMap = new Map();
    }

    const refScan = scanConversationContentRefsForMatch(pendingRefs, contentMap, filterText, lowerFilter, isCancelled, inlineScan.matchInfo);
    if (refScan.cancelled) return null;
    return refScan.matched ? refScan.matchInfo : null;
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
    for (const msg of messagesCopy) {
      try {
        msg.content = normalizeStoredMessageContent(msg.content);
      } catch (_) {}
    }
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

    // 对话摘要（对话列表显示的标题）：
    // - 优先使用发送时写入到消息节点的 promptType/promptMeta（避免基于字符串/正则猜测）；
    // - 对于 selection/query：标题为「[划词解释] + 划词内容」；
    // - 对于 summary/pdf/image：标题使用固定标签；
    // - 其它情况回退为第一条用户消息的摘要。
    const promptsConfig = promptSettingsManager.getPrompts();
    const summary = buildConversationSummaryFromMessages(messagesCopy, {
      promptsConfig,
      pageTitle: state.pageInfo?.title || '',
      maxLength: 50
    });

    let urlToSave = '';
    let titleToSave = '';
    let summaryToSave = summary;
    // 分支元信息：仅在更新已有会话时需要“继承”下来，避免分支关系被覆盖丢失
    let parentConversationIdToSave = null;
    let forkedFromMessageIdToSave = null;
    
    // 如果是更新操作并且已存在记录，则固定使用首次保存的 url 和 title
    if (isUpdate && currentConversationId) {
      try {
        // 使用false参数，不加载完整内容，只获取元数据
        const existingConversation = await getConversationById(currentConversationId, false);
        if (existingConversation) {
          urlToSave = existingConversation.url || '';
          titleToSave = existingConversation.title || '';

          // 继承分支关系字段（如果存在）
          if (typeof existingConversation.parentConversationId === 'string' && existingConversation.parentConversationId.trim()) {
            parentConversationIdToSave = existingConversation.parentConversationId.trim();
          }
          if (typeof existingConversation.forkedFromMessageId === 'string' && existingConversation.forkedFromMessageId.trim()) {
            forkedFromMessageIdToSave = existingConversation.forkedFromMessageId.trim();
          }
          
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
    if (parentConversationIdToSave) {
      conversation.parentConversationId = parentConversationIdToSave;
    }
    if (forkedFromMessageIdToSave) {
      conversation.forkedFromMessageId = forkedFromMessageIdToSave;
    }

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
    if (!conversation || !conversation.id) return;

    // 说明：这里的缓存用于“快速打开最近使用的会话”，因此应当是一个真正的 LRU。
    // 旧实现仅“释放消息内容”但依然把所有会话对象留在 Map 中，导致：
    // 1) 搜索/遍历时缓存无限增长（Map 永远 > maxLoadedConversations）；
    // 2) 每次插入都触发“释放会话内存”日志刷屏；
    // 3) JS 堆仍保留大量 message 元对象，实际内存收益有限。
    //
    // 新策略：只保留最近使用的 N 条“完整会话对象”引用，超出上限直接淘汰（让 GC 回收）。
    // activeConversation（正在聊天/刚打开）尽量不淘汰。
    if (loadedConversations.has(conversation.id)) {
      loadedConversations.delete(conversation.id);
    }
    loadedConversations.set(conversation.id, conversation);

    const maxKeep = Math.max(1, Number(maxLoadedConversations) || 1);
    if (loadedConversations.size <= maxKeep) return;

    const activeId = activeConversation?.id || null;
    for (const id of loadedConversations.keys()) {
      if (loadedConversations.size <= maxKeep) break;
      if (activeId && id === activeId) continue;
      loadedConversations.delete(id);
    }

    // 极端兜底：如果 maxKeep 太小（例如被误设为 0）导致仍超限，则允许淘汰最旧项。
    while (loadedConversations.size > maxKeep) {
      const oldestId = loadedConversations.keys().next().value;
      if (!oldestId) break;
      loadedConversations.delete(oldestId);
    }
  }

  /**
   * 从缓存获取会话，如果不在缓存中则从数据库加载
   * @param {string} conversationId - 会话ID 
   * @param {boolean} [forceReload=false] - 是否强制从数据库重新加载
   * @returns {Promise<Object>} 会话对象
   */
  async function getConversationFromCacheOrLoad(conversationId, forceReload = false) {
    if (!conversationId) return null;

    if (forceReload || !loadedConversations.has(conversationId)) {
      // 从数据库加载并更新缓存（用于点击打开/恢复会话）
      const conversation = await getConversationById(conversationId, true);
      if (conversation) updateConversationInCache(conversation);
      return conversation || null;
    }

    const cached = loadedConversations.get(conversationId) || null;
    if (cached) updateConversationInCache(cached); // touch -> LRU
    return cached;
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

    // 性能优化：
    // - 预热下载根目录缓存：避免首次遇到图片时触发 chrome.storage.local 读取造成额外卡顿；
    // - 使用 DocumentFragment 批量插入 DOM，减少大量 appendChild 带来的反复回流/重绘；
    // - 注意：messageProcessor.appendMessage 在传入 fragment 时会给消息加上 batch-load class（用于动画）。
    //   “继续本页对话”属于快速恢复场景，这里移除 batch-load，确保视觉行为与之前一致。
    try { await loadDownloadRoot(); } catch (_) {}
    const fragment = document.createDocumentFragment();

    const extractInlineImgSrcs = (html) => {
      const set = new Set();
      if (typeof html !== 'string' || !html.includes('<img')) return set;
      const re = /<img\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/gi;
      let m = null;
      while ((m = re.exec(html)) !== null) {
        const src = m[2] || '';
        if (src) set.add(src);
      }
      return set;
    };

    // 遍历对话中的每条消息并显示
    for (const msg of fullConversation.messages) {
      normalizeThinkingForMessage(msg);
      const role = msg.role.toLowerCase() === 'assistant' ? 'ai' : msg.role;
      let messageElem = null;
      const thoughtsToDisplay = msg.thoughtsRaw || null; // 获取思考过程文本

      msg.content = normalizeStoredMessageContent(msg.content);

      if (Array.isArray(msg.content)) {
        const { text, images } = splitStoredMessageContent(msg.content);
        let combinedContent = text || '';
        const displayUrls = [];

        for (const imageUrlObj of images) {
          const resolved = await resolveImageUrlForDisplay(imageUrlObj);
          const fallback = imageUrlObj?.url || imageUrlObj?.path || '';
          const url = (resolved || fallback || '').trim();
          if (url) displayUrls.push(url);
        }

        const uniqueDisplayUrls = Array.from(new Set(displayUrls));

        if (role === 'ai') {
          const existingSrcs = extractInlineImgSrcs(combinedContent);
          const inlineHtml = uniqueDisplayUrls
            .filter((u) => u && !existingSrcs.has(u))
            .map((u) => {
              const safeUrl = String(u).replace(/"/g, '&quot;');
              return `\n<img class="ai-inline-image" src="${safeUrl}" alt="加载的图片" />\n`;
            })
            .join('');
          combinedContent = combinedContent + inlineHtml;
          messageElem = appendMessage(combinedContent, role, true, fragment, null, thoughtsToDisplay);
        } else {
          const legacyImagesContainer = document.createElement('div');
          uniqueDisplayUrls.forEach((u) => {
            const imageTag = createImageTag(u, null);
            legacyImagesContainer.appendChild(imageTag);
          });
          const imagesHTML = legacyImagesContainer.innerHTML;
          messageElem = appendMessage(combinedContent, role, true, fragment, imagesHTML, thoughtsToDisplay);
        }
      } else {
        // 调用 appendMessage 时传递 thoughtsToDisplay
        messageElem = appendMessage(msg.content, role, true, fragment, null, thoughtsToDisplay);
      }

      if (messageElem && messageElem.classList) {
        messageElem.classList.remove('batch-load');
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

    // 批量插入：一次性提交到 DOM，显著降低大对话恢复时的卡顿/延迟
    chatContainer.appendChild(fragment);
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
   * @param {string} [conversationUrl=''] - 对话记录关联的网页 URL（若调用方已知则传入，避免额外读取数据库）
   */
  async function showChatHistoryItemContextMenu(e, conversationId, conversationUrl = '') {
    e.preventDefault();

    /**
     * 将会话记录中的 URL 规范化为可打开链接。
     *
     * 说明：
     * - 历史会话的 url 字段由页面信息写入，可能为空、含空格，或为不可直接打开的协议；
     * - 这里保持与既有逻辑一致：仅允许 http(s) 链接，避免误打开不受支持/不安全的协议。
     *
     * @param {unknown} rawUrl
     * @returns {string} 可打开的 URL（不可用则返回空字符串）
     */
    function normalizeOpenableUrl(rawUrl) {
      if (typeof rawUrl !== 'string') return '';
      const trimmed = rawUrl.trim();
      if (!trimmed) return '';
      if (!/^https?:\/\//i.test(trimmed)) return '';
      return trimmed;
    }

    /**
     * 打开 URL（优先使用 chrome.tabs.create，避免在侧边栏/独立页中被 window.open 的弹窗策略影响）。
     * @param {string} url
     * @returns {Promise<boolean>} 是否成功触发打开动作
     */
    async function openUrlInNewTab(url) {
      const safeUrl = normalizeOpenableUrl(url);
      if (!safeUrl) return false;
      try {
        // 注意：这里必须先用 typeof 判断，避免在非扩展环境下直接引用 chrome 变量导致 ReferenceError。
        if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
          await chrome.tabs.create({ url: safeUrl });
          return true;
        }
      } catch (error) {
        console.warn('使用 chrome.tabs.create 打开链接失败，将回退到 window.open:', error);
      }
      try {
        window.open(safeUrl, '_blank', 'noopener');
        return true;
      } catch (error) {
        console.error('使用 window.open 打开链接失败:', error);
        return false;
      }
    }

    /**
     * 让右键菜单尽量完整显示在视口内（避免靠近边缘时菜单被裁切导致“看起来像没功能”）。
     * @param {HTMLElement} menu
     * @param {number} x
     * @param {number} y
     */
    function clampMenuToViewport(menu, x, y) {
      const margin = 6;
      const menuWidth = menu.offsetWidth || 0;
      const menuHeight = menu.offsetHeight || 0;
      const maxLeft = Math.max(margin, window.innerWidth - menuWidth - margin);
      const maxTop = Math.max(margin, window.innerHeight - menuHeight - margin);
      const left = Math.min(Math.max(margin, x), maxLeft);
      const top = Math.min(Math.max(margin, y), maxTop);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }

    // 如果已存在菜单，则删除
    const existingMenu = document.getElementById('chat-history-context-menu');
    if (existingMenu) {
      existingMenu.remove();
    }
    // 创建菜单容器
    const menu = document.createElement('div');
    menu.id = 'chat-history-context-menu';
    // 先按点击位置放置（随后在 append 后再做一次“视口内修正”）
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

    // 打开对话页面（会话关联 URL）选项
    const openUrlOption = document.createElement('div');
    openUrlOption.textContent = '打开对话页面';
    openUrlOption.classList.add('chat-history-context-menu-option');
    openUrlOption.addEventListener('click', async (event) => {
      event.stopPropagation();
      menu.remove();
      try {
        // 优先使用列表元数据携带的 URL（无需读库）；若缺失再回退读取会话详情。
        let urlToOpen = normalizeOpenableUrl(conversationUrl);
        if (!urlToOpen) {
          const conversation = await getConversationFromCacheOrLoad(conversationId);
          urlToOpen = normalizeOpenableUrl(conversation?.url);
        }

        if (!urlToOpen) {
          showNotification({ message: '该对话没有关联 URL', duration: 2200 });
          return;
        }

        const opened = await openUrlInNewTab(urlToOpen);
        if (!opened) {
          showNotification({ message: '无法打开链接，请检查浏览器设置', type: 'error', duration: 2200 });
        }
      } catch (error) {
        console.error('获取对话页面 URL 失败:', error);
        showNotification({ message: '无法打开对话页面，请重试', type: 'error', duration: 2200 });
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
    // append 后才能拿到菜单宽高，因此在这里做“视口内修正”
    try {
      clampMenuToViewport(menu, e.clientX, e.clientY);
    } catch (_) {}

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
   * 纯函数：把“会话列表”按 parentConversationId 展开为可渲染的树状顺序。
   *
   * 设计目标：
   * - UI 侧只关心“渲染顺序 + 缩进层级”；不在这里写 DOM；
   * - 同级排序尽量稳定：置顶优先，其次按 endTime 倒序；URL 匹配模式下优先按 urlMatchLevel；
   * - 允许父会话缺失（被删除/未加载）：子会话会作为顶层节点展示，并标记为 orphan。
   *
   * @param {Array<Object>} conversations
   * @param {string[]} pinnedIds
   * @returns {Array<Object>} 新数组：每项会附加 __branchDepth/__branchParentSummary/__branchIsOrphan 等 UI 字段
   */
  function buildConversationBranchTreeDisplayList(conversations, pinnedIds) {
    const list = Array.isArray(conversations) ? conversations.filter(Boolean) : [];
    const pinnedList = Array.isArray(pinnedIds) ? pinnedIds.filter(Boolean) : [];
    const pinnedIndexMap = new Map(pinnedList.map((id, idx) => [id, idx]));

    const idToConv = new Map();
    for (const conv of list) {
      const id = typeof conv?.id === 'string' ? conv.id : '';
      if (!id) continue;
      if (!idToConv.has(id)) {
        idToConv.set(id, conv);
      }
    }

    const safeUrlLevel = (conv) => {
      const raw = conv?.urlMatchLevel;
      return Number.isFinite(Number(raw)) ? Number(raw) : null;
    };

    const compareByDisplayPriority = (a, b) => {
      if (!a || !b) return 0;
      const aId = a.id;
      const bId = b.id;
      const aPinned = pinnedIndexMap.has(aId);
      const bPinned = pinnedIndexMap.has(bId);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (aPinned && bPinned) {
        return (pinnedIndexMap.get(aId) ?? 0) - (pinnedIndexMap.get(bId) ?? 0);
      }

      // URL 筛选模式：更严格的匹配等级优先
      const aLevel = safeUrlLevel(a);
      const bLevel = safeUrlLevel(b);
      if (aLevel !== null || bLevel !== null) {
        const av = aLevel === null ? Number.POSITIVE_INFINITY : aLevel;
        const bv = bLevel === null ? Number.POSITIVE_INFINITY : bLevel;
        if (av !== bv) return av - bv;
      }

      const aEnd = Number(a?.endTime) || 0;
      const bEnd = Number(b?.endTime) || 0;
      if (aEnd !== bEnd) return bEnd - aEnd;

      const aStart = Number(a?.startTime) || 0;
      const bStart = Number(b?.startTime) || 0;
      if (aStart !== bStart) return bStart - aStart;

      const aSummary = String(a?.summary || '');
      const bSummary = String(b?.summary || '');
      return aSummary.localeCompare(bSummary);
    };

    // parentId -> childConv[]
    const childrenMap = new Map();
    const rootIds = [];

    for (const [id, conv] of idToConv.entries()) {
      const rawParent = typeof conv?.parentConversationId === 'string' ? conv.parentConversationId.trim() : '';
      const parentId = rawParent && rawParent !== id ? rawParent : '';
      if (parentId && idToConv.has(parentId)) {
        if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
        childrenMap.get(parentId).push(conv);
      } else {
        rootIds.push(id);
      }
    }

    // 对 root/children 做一次排序，保证渲染稳定
    rootIds.sort((aId, bId) => compareByDisplayPriority(idToConv.get(aId), idToConv.get(bId)));
    for (const [parentId, children] of childrenMap.entries()) {
      children.sort(compareByDisplayPriority);
      childrenMap.set(parentId, children);
    }

    const ordered = [];
    const visited = new Set();

    const walk = (conv, depth, resolvedParentId) => {
      if (!conv || !conv.id) return;
      if (visited.has(conv.id)) return;
      visited.add(conv.id);

      const rawParent = typeof conv?.parentConversationId === 'string' ? conv.parentConversationId.trim() : '';
      const parentId = rawParent && rawParent !== conv.id ? rawParent : '';
      const parentExists = !!(parentId && idToConv.has(parentId));
      const parentSummary = parentExists ? String(idToConv.get(parentId)?.summary || '') : '';

      ordered.push({
        ...conv,
        __branchDepth: Math.max(0, Number(depth) || 0),
        __branchResolvedParentId: resolvedParentId || null,
        __branchParentSummary: parentSummary,
        __branchIsOrphan: !!(parentId && !parentExists)
      });

      const children = childrenMap.get(conv.id) || [];
      for (const child of children) {
        walk(child, (Number(depth) || 0) + 1, conv.id);
      }
    };

    for (const rootId of rootIds) {
      walk(idToConv.get(rootId), 0, null);
    }

    // 兜底：处理环/异常数据导致未被遍历到的节点
    for (const conv of idToConv.values()) {
      if (!visited.has(conv.id)) {
        walk(conv, 0, null);
      }
    }

    return ordered;
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

    // 清理上一轮搜索残留的进度条（避免在新一轮加载时出现“旧进度”闪烁）
    try {
      panel.querySelectorAll('.search-loading-indicator').forEach((n) => n.remove());
    } catch (_) {}

    const upsertSearchProgressIndicator = () => {
      let indicator = null;
      try {
        indicator = panel.querySelector('.search-loading-indicator');
      } catch (_) {
        indicator = null;
      }
      if (indicator) return indicator;

      indicator = document.createElement('div');
      indicator.className = 'search-loading-indicator';

      const filterBoxContainer = panel.querySelector('.filter-container');
      if (filterBoxContainer && filterBoxContainer.parentNode === listContainer.parentNode) {
        filterBoxContainer.insertAdjacentElement('afterend', indicator);
      } else {
        listContainer.insertBefore(indicator, listContainer.firstChild);
      }
      return indicator;
    };

    const setSearchProgressStage = (indicator, text) => {
      if (!indicator) return;
      indicator.innerHTML = `
        <div class="search-progress">
          <div class="search-progress-text">${text || ''}</div>
          <div class="search-progress-bar">
            <div class="search-progress-fill" style="width: 0%"></div>
          </div>
        </div>
      `;
    };

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
    // 任务可能已被新一轮加载替换
    if (panel.dataset.runId !== runId) return;

    // 树状视图：只在“无筛选”场景下改变排序（否则会干扰全文搜索/筛选的直觉）
    const isBranchTreeView = panel.dataset.branchViewMode === 'tree';
    const shouldTreeOrder = isBranchTreeView && !isCountFilter && !filterText.trim();

    // 记录本轮“列表数据源模式”，供 renderMoreItems 继续分页追加
    // - paged：默认视图（置顶 + 最近 N 条），后续按需加载更多
    // - full：全文搜索/消息数筛选等，需要全量元数据
    // - url：按当前页面 URL 前缀快速筛选
    panel._historyDataSource = { mode: 'full' };

    const urlFilterMode = panel.dataset.urlFilterMode === 'currentUrl';

    let baseHistories = null;

    if (urlFilterMode) {
      const currentUrl = (state.pageInfo?.url || '').trim();
      if (!currentUrl) {
        // 无 URL 时退回普通模式（按钮理论上会 disabled，这里再做一次防御）
        panel.dataset.urlFilterMode = '';
      } else {
        panel._historyDataSource = { mode: 'url', currentUrl };
        const candidateUrls = generateCandidateUrls(currentUrl);
        baseHistories = await listConversationMetadataByUrlCandidates(candidateUrls);
        if (panel.dataset.runId !== runId) return;
      }
    }

    // 默认视图（无输入筛选）走“快速分页”：
    // - 首次：置顶 + 最近 50（非置顶）
    // - 后续：滚动到底部再继续加载更多（renderMoreItems 内部触发）
    if (!baseHistories && !isCountFilter && !filterText.trim() && !shouldTreeOrder) {
      panel._historyDataSource = { mode: 'paged', cursor: null, hasMore: false, pageSize: PAGED_UNPINNED_LOAD_SIZE };
      removeSearchSummary(panel);

      const pinnedMetas = await getConversationMetadataByIds(pinnedIds);
      if (panel.dataset.runId !== runId) return;

      const firstPage = await getConversationMetadataPageByEndTimeDesc({
        limit: INITIAL_UNPINNED_LOAD_LIMIT,
        cursor: null,
        excludeIds: pinnedIds
      });
      if (panel.dataset.runId !== runId) return;

      panel._historyDataSource.cursor = firstPage.cursor;
      panel._historyDataSource.hasMore = firstPage.hasMore;

      baseHistories = [...pinnedMetas, ...(firstPage.items || [])];
    }

    // 需要“全量元数据”的场景：消息数筛选 / 全文搜索
    if (!baseHistories) {
      panel._historyDataSource = { mode: 'full' };

      // 说明：全文搜索需要先拿到“全量会话元数据列表”作为候选池，这一步在会话很多时可能需要 0.5~2s。
      // 旧实现会等“元数据加载完成后”才插入进度条，导致用户感觉“停顿了一秒啥也没干”。
      // 这里提前显示“准备阶段”，让用户能立刻看到反馈。
      const isFullTextSearch = !isCountFilter && !!filterText.trim() && !urlFilterMode;
      const canReuseSearchCache = isFullTextSearch && !!searchCache?.results && searchCache.normalized === normalizedFilter;

      if (canReuseSearchCache) {
        baseHistories = searchCache.results.slice();
      } else {
        let warmupIndicator = null;
        if (isFullTextSearch) {
          warmupIndicator = upsertSearchProgressIndicator();
          setSearchProgressStage(warmupIndicator, '正在准备搜索…（加载会话列表）');
        }

        baseHistories = await getAllConversationMetadataWithCache();
        if (panel.dataset.runId !== runId) {
          if (warmupIndicator && warmupIndicator.parentNode) warmupIndicator.remove();
          return;
        }
      }
    }

    let sourceHistories = [];
    let effectiveFilterTextForHighlight = filterText;

    if (panel._historyDataSource.mode === 'paged') {
      // 默认分页列表不做额外筛选（filterText 本身为空）
      sourceHistories = baseHistories;
      effectiveFilterTextForHighlight = '';
      removeSearchSummary(panel);
    } else if (panel._historyDataSource.mode === 'url') {
      // URL 模式保持“快速”：仅在元数据维度做筛选（避免全文消息扫描导致的延迟）
      removeSearchSummary(panel);

      if (isCountFilter) {
        sourceHistories = baseHistories.filter((history) =>
          compareCount(history.messageCount, countOperator, countThreshold)
        );
        effectiveFilterTextForHighlight = '';
      } else if (filterText.trim()) {
        const lowerFilter = normalizedFilter;
        sourceHistories = baseHistories.filter((history) => {
          const url = (history.url || '').toLowerCase();
          const summary = (history.summary || '').toLowerCase();
          const title = (history.title || '').toLowerCase();
          return url.includes(lowerFilter) || summary.includes(lowerFilter) || title.includes(lowerFilter);
        });
        effectiveFilterTextForHighlight = filterText;
      } else {
        sourceHistories = baseHistories;
        effectiveFilterTextForHighlight = '';
      }
    } else {
      const allHistoriesMeta = baseHistories;

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
	          // 连续输入优化：若本次查询是“上次查询的前缀扩展”，则只需要在上次结果集合里继续筛即可。
	          // 典型场景：用户从 "http" 继续输入到 "https://..."，无需每次都从全量会话重扫。
	          const previousNormalized = (typeof searchCache?.normalized === 'string') ? searchCache.normalized : '';
	          const canReusePrefixCache = (
	            !!previousNormalized &&
	            previousNormalized !== normalizedFilter &&
	            normalizedFilter.startsWith(previousNormalized) &&
	            Array.isArray(searchCache?.results)
	          );

	          const candidateMetas = canReusePrefixCache ? searchCache.results.slice() : allHistoriesMeta;
	          const totalItems = candidateMetas.length;
	          let nextIndex = 0;
	          let processedCount = 0;
	          let lastProgressUpdate = 0;
	          let cancelled = false;

	          // 在列表容器顶部插入搜索进度指示器
	          const searchProgressIndicator = upsertSearchProgressIndicator();

	          const PROGRESS_UPDATE_INTERVAL = 10;
	          // 批量读取会话后，每个 worker 的“单次工作量”更大；并发过高反而可能造成 IndexedDB 竞争与 UI 抖动。
	          const CONCURRENCY = Math.min(4, Math.max(2, navigator?.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 2) : 4));
	          const SEARCH_SCAN_BATCH_SIZE = 12;
	          let lastYieldTime = performance.now();
	          const isCancelled = createSearchCancelledChecker(panel, runId);

	          const updateProgress = (force = false) => {
	            if (!force && processedCount - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL) return;
	            lastProgressUpdate = processedCount;
	            const percentComplete = totalItems === 0 ? 100 : Math.round((processedCount / totalItems) * 100);
	            const matchCount = matchedEntries.length;
	            const reuseHint = canReusePrefixCache ? ' · 候选池来自缓存' : '';
	            searchProgressIndicator.innerHTML = `
	              <div class="search-progress">
	                <div class="search-progress-text">
	                  正在搜索聊天记录... (${processedCount}/${totalItems}${matchCount ? ` · 已找到 ${matchCount}` : ''}${reuseHint})
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
	              const batchStart = nextIndex;
	              nextIndex += SEARCH_SCAN_BATCH_SIZE;
	              if (batchStart >= totalItems || cancelled) break;

	              if (isCancelled()) {
	                cancelled = true;
	                break;
	              }

	              const batchEnd = Math.min(totalItems, batchStart + SEARCH_SCAN_BATCH_SIZE);
	              const batchMetas = candidateMetas.slice(batchStart, batchEnd);
	              const batchToScan = [];

	              // 1) 先在“元数据字段”上做快速命中（无需读 messages）
	              for (let offset = 0; offset < batchMetas.length; offset++) {
	                const historyMeta = batchMetas[offset];
	                if (!historyMeta?.id) {
	                  processedCount++;
	                  updateProgress();
	                  continue;
	                }
	                if (isCancelled()) {
	                  cancelled = true;
	                  break;
	                }

	                const url = (historyMeta.url || '').toLowerCase();
	                const summary = (historyMeta.summary || '').toLowerCase();
	                const title = (historyMeta.title || '').toLowerCase();
	                const metaMatched = url.includes(lowerFilter) || summary.includes(lowerFilter) || title.includes(lowerFilter);

	                if (metaMatched) {
	                  matchedEntries.push({ index: batchStart + offset, data: historyMeta });
	                  matchInfoMap.set(historyMeta.id, { messageId: null, excerpts: [], reason: 'meta' });
	                  processedCount++;
	                  updateProgress();
	                } else {
	                  batchToScan.push({ index: batchStart + offset, meta: historyMeta });
	                }
	              }

	              if (cancelled) break;

	              // 2) 未命中元数据的条目：批量读取会话并扫描 messages（减少 transaction 次数）
	              if (batchToScan.length > 0) {
	                const idsToLoad = batchToScan.map((item) => item.meta.id).filter(Boolean);
	                let conversations = [];
	                try {
	                  conversations = await getConversationsByIds(idsToLoad, false);
	                } catch (error) {
	                  console.error('批量加载会话失败（全文搜索）:', error);
	                  conversations = [];
	                }

	                if (isCancelled()) {
	                  cancelled = true;
	                  break;
	                }

	                const conversationById = new Map();
	                for (const conv of conversations) {
	                  if (conv?.id) conversationById.set(conv.id, conv);
	                }

	                // 2.1 先扫内联 messages；必要时收集 contentRef，后续批量解引用
	                const pendingRefByConversationId = new Map();
	                const pendingRefIdSet = new Set();

	                for (const item of batchToScan) {
	                  if (isCancelled()) {
	                    cancelled = true;
	                    break;
	                  }

	                  const conv = conversationById.get(item.meta.id);
	                  if (!conv || !Array.isArray(conv.messages)) {
	                    processedCount++;
	                    updateProgress();
	                    continue;
	                  }

	                  const inlineScan = scanConversationInlineMessagesForMatch(conv, filterText, lowerFilter, isCancelled);
	                  if (inlineScan.cancelled) {
	                    cancelled = true;
	                    break;
	                  }

	                  if (inlineScan.matched) {
	                    matchInfoMap.set(item.meta.id, inlineScan.matchInfo);
	                    matchedEntries.push({ index: item.index, data: item.meta });
	                    processedCount++;
	                    updateProgress();
	                  } else if (Array.isArray(inlineScan.pendingContentRefs) && inlineScan.pendingContentRefs.length > 0) {
	                    pendingRefByConversationId.set(item.meta.id, {
	                      index: item.index,
	                      meta: item.meta,
	                      matchInfo: inlineScan.matchInfo,
	                      pendingRefs: inlineScan.pendingContentRefs
	                    });
	                    inlineScan.pendingContentRefs.forEach((ref) => {
	                      if (ref?.contentRef) pendingRefIdSet.add(ref.contentRef);
	                    });
	                  } else {
	                    processedCount++;
	                    updateProgress();
	                  }

	                  // 让出主线程给 UI（进度条/滚动/输入），避免长时间占用导致卡顿。
	                  const now = performance.now();
	                  if (now - lastYieldTime >= 16) {
	                    lastYieldTime = now;
	                    await new Promise(resolve => setTimeout(resolve, 0));
	                  }
	                }

	                if (cancelled) break;

	                // 2.2 仍未命中：批量解引用 messageContents 并扫描文本（图片/多模态消息）
	                if (pendingRefByConversationId.size > 0 && pendingRefIdSet.size > 0) {
	                  let contentMap = new Map();
	                  try {
	                    contentMap = await loadMessageContentsByIds(Array.from(pendingRefIdSet));
	                  } catch (_) {
	                    contentMap = new Map();
	                  }

	                  if (isCancelled()) {
	                    cancelled = true;
	                    break;
	                  }

	                  for (const [conversationId, payload] of pendingRefByConversationId.entries()) {
	                    if (isCancelled()) {
	                      cancelled = true;
	                      break;
	                    }

	                    const refScan = scanConversationContentRefsForMatch(
	                      payload.pendingRefs,
	                      contentMap,
	                      filterText,
	                      lowerFilter,
	                      isCancelled,
	                      payload.matchInfo
	                    );
	                    if (refScan.cancelled) {
	                      cancelled = true;
	                      break;
	                    }

	                    if (refScan.matched) {
	                      matchInfoMap.set(conversationId, refScan.matchInfo);
	                      matchedEntries.push({ index: payload.index, data: payload.meta });
	                    }

	                    processedCount++;
	                    updateProgress();

	                    const now = performance.now();
	                    if (now - lastYieldTime >= 16) {
	                      lastYieldTime = now;
	                      await new Promise(resolve => setTimeout(resolve, 0));
	                    }
	                  }
	                } else if (pendingRefByConversationId.size > 0) {
	                  // 无法解引用（极少数异常情况），也要推进进度，避免进度条卡死。
	                  processedCount += pendingRefByConversationId.size;
	                  updateProgress(true);
	                }
	              }

	              // 让出主线程给 UI（进度条/滚动/输入），避免长时间占用导致卡顿。
	              // 注意：不必每条都 setTimeout(0)，否则会明显拖慢搜索；这里按时间片让出即可。
	              const now = performance.now();
	              if (now - lastYieldTime >= 16) {
	                lastYieldTime = now;
	                await new Promise(resolve => setTimeout(resolve, 0));
	              }
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
	            reused: canReusePrefixCache
	          });
	        }
	      } else {
	        removeSearchSummary(panel);
	        sourceHistories = allHistoriesMeta;
        effectiveFilterTextForHighlight = '';
      }
    }

    let pinnedItems = [];
    let unpinnedItems = [];
    let isTreeOrderingActive = false;

    if (shouldTreeOrder) {
      // 树状排序：保持父子关系连续展示，因此不再拆分“置顶/非置顶”两段，也不再按日期插入分组标题。
      isTreeOrderingActive = true;
      currentDisplayItems = buildConversationBranchTreeDisplayList(sourceHistories, pinnedIds);
      currentPinnedItemsCountInDisplay = 0;
    } else {
      const pinnedIndexMap = new Map(pinnedIds.map((id, index) => [id, index]));
      sourceHistories.forEach(hist => {
        if (pinnedIds.includes(hist.id)) {
          pinnedItems.push(hist);
        } else {
          unpinnedItems.push(hist);
        }
      });

      pinnedItems.sort((a, b) => (pinnedIndexMap.get(a.id) ?? Infinity) - (pinnedIndexMap.get(b.id) ?? Infinity));
      if (panel?._historyDataSource?.mode === 'url') {
        // URL 快速筛选模式：更严格的匹配等级优先，等级相同再按最近对话排序
        unpinnedItems.sort((a, b) => {
          const aLevel = Number.isFinite(Number(a?.urlMatchLevel)) ? Number(a.urlMatchLevel) : Number.POSITIVE_INFINITY;
          const bLevel = Number.isFinite(Number(b?.urlMatchLevel)) ? Number(b.urlMatchLevel) : Number.POSITIVE_INFINITY;
          if (aLevel !== bLevel) return aLevel - bLevel;
          return (Number(b?.endTime) || 0) - (Number(a?.endTime) || 0);
        });
      } else {
        unpinnedItems.sort((a, b) => (Number(b?.endTime) || 0) - (Number(a?.endTime) || 0));
      }

      currentDisplayItems = [...pinnedItems, ...unpinnedItems];
      currentPinnedItemsCountInDisplay = pinnedItems.length;
    }

    if (panel?._historyDataSource?.mode === 'paged') {
      // 用于后续分页追加时去重（极端情况下避免重复插入同一会话）
      panel._historyDataSource.loadedIdSet = new Set(currentDisplayItems.map((item) => item?.id).filter(Boolean));
    }

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

    if (!isTreeOrderingActive && pinnedItems.length > 0) {
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

  // ==========================================================================
  //  聊天记录列表：标注“已在其它标签页打开”并提供跳转按钮
  // ==========================================================================

  function buildOpenTabsTooltipText(tabs, selfTabId) {
    const list = Array.isArray(tabs) ? tabs : [];
    if (list.length === 0) return '';

    const normalizedSelfTabId = Number.isFinite(Number(selfTabId)) ? Number(selfTabId) : null;
    const lines = [`该会话已在 ${list.length} 个标签页打开`];

    const maxLines = Math.min(6, list.length);
    for (let i = 0; i < maxLines; i++) {
      const t = list[i] || {};
      const tabId = Number.isFinite(Number(t.tabId)) ? Number(t.tabId) : null;
      const title = typeof t.title === 'string' ? t.title.trim() : '';
      const url = typeof t.url === 'string' ? t.url.trim() : '';
      const isSelf = normalizedSelfTabId !== null && tabId !== null && tabId === normalizedSelfTabId;
      const prefix = isSelf ? '当前' : '其它';
      const main = title || url || (tabId !== null ? `tab ${tabId}` : 'tab');
      lines.push(`${prefix}：${main}`);
      if (title && url && url !== title) lines.push(url);
    }
    if (list.length > maxLines) lines.push(`… 还有 ${list.length - maxLines} 个标签页`);
    return lines.join('\n');
  }

  function getConversationOpenTabsState(conversationId) {
    if (!conversationPresence?.getConversationTabs) return { tabs: [], selfTabId: null, otherTabs: [] };
    const tabs = conversationPresence.getConversationTabs(conversationId) || [];
    const selfTabId = conversationPresence.getSelfTabId?.() ?? null;
    const normalizedSelfTabId = Number.isFinite(Number(selfTabId)) ? Number(selfTabId) : null;
    const otherTabs = (normalizedSelfTabId !== null)
      ? tabs.filter((t) => Number.isFinite(Number(t?.tabId)) && Number(t.tabId) !== normalizedSelfTabId)
      : tabs;
    return { tabs, selfTabId: normalizedSelfTabId, otherTabs };
  }

  function updateConversationItemOpenTabUi(item, conversationId) {
    if (!item || !conversationId) return;
    const actions = item.querySelector('.chat-history-item-actions');
    if (!actions) return;

    const statusEl = actions.querySelector('.open-tab-status');
    const jumpBtn = actions.querySelector('.jump-to-open-tab-btn');
    if (!statusEl || !jumpBtn) return;

    const { tabs, selfTabId, otherTabs } = getConversationOpenTabsState(conversationId);
    const isOpen = tabs.length > 0;
    const isOpenElsewhere = otherTabs.length > 0;
    const tooltip = buildOpenTabsTooltipText(tabs, selfTabId);

    if (!isOpen) {
      statusEl.style.display = 'none';
      jumpBtn.style.display = 'none';
      statusEl.classList.remove('open-self', 'open-elsewhere');
      return;
    }

    statusEl.style.display = 'inline-flex';
    statusEl.classList.toggle('open-elsewhere', isOpenElsewhere);
    statusEl.classList.toggle('open-self', !isOpenElsewhere);
    statusEl.title = tooltip;
    statusEl.textContent = isOpenElsewhere ? `已在 ${tabs.length} 个标签页打开` : '当前标签页已打开';

    // 只有当“其它标签页”确实存在时才显示跳转按钮（避免跳转回当前标签页造成困惑）
    jumpBtn.style.display = isOpenElsewhere ? 'inline-flex' : 'none';
    jumpBtn.title = tooltip ? `${tooltip}\n\n点击跳转到已打开的标签页` : '点击跳转到已打开的标签页';
  }

  function refreshOpenTabUiIfPanelVisible() {
    try {
      const panel = document.getElementById('chat-history-panel');
      if (!panel || !panel.classList.contains('visible')) return;
      const list = panel.querySelector('#chat-history-list');
      if (!list) return;
      list.querySelectorAll('.chat-history-item').forEach((item) => {
        const id = item.getAttribute('data-id') || '';
        if (id) updateConversationItemOpenTabUi(item, id);
      });
    } catch (_) {}
  }

  // 订阅存在性快照更新：仅在聊天记录面板可见时增量更新右侧标记
  if (conversationPresence?.subscribe) {
    conversationPresence.subscribe(() => refreshOpenTabUiIfPanelVisible());
  }

  function createConversationItemElement(conv, filterText, isPinned) {
    const item = document.createElement('div');
    item.className = 'chat-history-item';
    item.setAttribute('data-id', conv.id);
    if (isPinned) {
      item.classList.add('pinned');
    }

    // --- 分支树状显示（UI 专用字段，来自 buildConversationBranchTreeDisplayList）---
    const branchDepth = Number.isFinite(Number(conv?.__branchDepth)) ? Number(conv.__branchDepth) : 0;
    const declaredParentId = typeof conv?.parentConversationId === 'string' ? conv.parentConversationId.trim() : '';
    const isForkConversation = !!declaredParentId;
    const isOrphanFork = !!conv?.__branchIsOrphan;

    if (branchDepth > 0) {
      item.classList.add('branch-tree-child');
      item.style.setProperty('--branch-depth', String(branchDepth));
    }
    if (isForkConversation) {
      item.classList.add('forked-conversation');
      // 便于未来做“跳转父会话”等交互：把 parentId 放到 DOM dataset
      try { item.dataset.parentConversationId = declaredParentId; } catch (_) {}
    }
    if (isOrphanFork) {
      item.classList.add('forked-orphan');
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
    // URL 快速筛选模式下，为每条会话标注“匹配等级”，便于用户理解来源范围
    // - 等级越小越严格（越接近当前页面 URL）
    // - 鼠标悬停可查看匹配前缀
    const hasUrlMatchLevel = Number.isFinite(Number(conv?.urlMatchLevel));
    if (hasUrlMatchLevel) {
      const level = Number(conv.urlMatchLevel);
      const prefix = typeof conv?.urlMatchPrefix === 'string' ? conv.urlMatchPrefix : '';
      const badge = document.createElement('span');
      badge.className = `url-match-badge url-match-level-${level}`;
      badge.textContent = `L${level}`;
      badge.title = prefix
        ? `URL 匹配等级 L${level}（越小越精确）\n匹配前缀: ${prefix}`
        : `URL 匹配等级 L${level}（越小越精确）`;
      infoDiv.appendChild(badge);
      infoDiv.appendChild(document.createTextNode(displayInfos));
    } else {
      infoDiv.textContent = displayInfos;
    }
    const detailsLines = [
      `开始: ${convDate.toLocaleString()} (${relativeTime})`,
      `最新: ${endTime.toLocaleString()} (${relativeEndTime})`,
      title,
      conv.url
    ].filter(Boolean);
    if (isForkConversation) {
      const parentLabel = (typeof conv?.__branchParentSummary === 'string' && conv.__branchParentSummary.trim())
        ? conv.__branchParentSummary.trim()
        : declaredParentId;
      detailsLines.push(isOrphanFork ? `分支自: ${parentLabel}（父会话缺失）` : `分支自: ${parentLabel}`);
    }
    item.title = detailsLines.join('\n');

    const mainDiv = document.createElement('div');
    mainDiv.className = 'chat-history-item-main';
    mainDiv.appendChild(summaryDiv);
    mainDiv.appendChild(infoDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'chat-history-item-actions';
    const openStatusEl = document.createElement('div');
    openStatusEl.className = 'open-tab-status';
    openStatusEl.style.display = 'none';
    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'jump-to-open-tab-btn';
    jumpBtn.type = 'button';
    jumpBtn.style.display = 'none';
    jumpBtn.setAttribute('aria-label', '跳转到已打开该会话的标签页');
    jumpBtn.innerHTML = '<i class="fa-solid fa-up-right-from-square"></i>';
    jumpBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!conversationPresence?.focusConversation) return;

      try {
        jumpBtn.disabled = true;
        const selfTabId = conversationPresence.getSelfTabId?.() ?? null;
        const result = await conversationPresence.focusConversation(conv.id, { excludeTabId: selfTabId });
        if (result?.status === 'ok') {
          closeChatHistoryPanel();
          return;
        }
        showNotification?.({ message: '跳转失败', type: 'error', description: result?.message || '' });
      } finally {
        jumpBtn.disabled = false;
      }
    });
    actionsDiv.appendChild(openStatusEl);
    actionsDiv.appendChild(jumpBtn);

    item.appendChild(mainDiv);
    item.appendChild(actionsDiv);

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
      mainDiv.appendChild(snippetDiv);
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
        mainDiv.appendChild(snippetDiv);
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
      showChatHistoryItemContextMenu(e, conv.id, conv.url);
    });

    // 根据最新快照更新右侧“已打开/跳转”标记
    updateConversationItemOpenTabUi(item, conv.id);

    return item;
  }

  /**
   * 默认分页模式下，从 IndexedDB 继续按 endTime 倒序加载下一页“轻量元数据”。
   *
   * 设计要点：
   * - 只在 mode==='paged' 且已渲染到当前已加载数据末尾时触发；
   * - 仅追加“非置顶”会话（置顶会话已在首屏批量读取并固定在顶部）。
   *
   * @param {HTMLElement|null} panel
   * @param {string[]} pinnedIds
   * @param {string} currentPanelFilter
   * @param {string} currentRunId
   * @returns {Promise<boolean>} 是否成功追加了新条目
   */
  async function appendNextUnpinnedPageForPagedMode(panel, pinnedIds, currentPanelFilter, currentRunId) {
    const dataSource = panel?._historyDataSource;
    if (!dataSource || dataSource.mode !== 'paged' || !dataSource.hasMore) return false;

    // 若期间用户切换筛选条件/触发新的加载流程，则直接放弃本次追加，避免旧数据污染
    if (!panel || panel.dataset.currentFilter !== currentPanelFilter || panel.dataset.runId !== currentRunId) {
      return false;
    }

    const limit = Math.max(1, Number(dataSource.pageSize) || PAGED_UNPINNED_LOAD_SIZE);

    let page = null;
    try {
      page = await getConversationMetadataPageByEndTimeDesc({
        limit,
        cursor: dataSource.cursor || null,
        excludeIds: pinnedIds
      });
    } catch (error) {
      console.error('分页加载聊天记录失败:', error);
      dataSource.hasMore = false;
      return false;
    }

    if (panel.dataset.currentFilter !== currentPanelFilter || panel.dataset.runId !== currentRunId) {
      return false;
    }

    const items = Array.isArray(page?.items) ? page.items : [];
    dataSource.cursor = page?.cursor || null;
    dataSource.hasMore = !!page?.hasMore;

    if (items.length === 0) {
      dataSource.hasMore = false;
      return false;
    }

    if (!(dataSource.loadedIdSet instanceof Set)) {
      dataSource.loadedIdSet = new Set(currentDisplayItems.map((item) => item?.id).filter(Boolean));
    }

    let appended = false;
    for (const item of items) {
      if (!item || !item.id) continue;
      if (dataSource.loadedIdSet.has(item.id)) continue;
      dataSource.loadedIdSet.add(item.id);
      currentDisplayItems.push(item);
      appended = true;
    }

    // 极端兜底：若没有任何新增条目，避免 hasMore 一直为 true 导致空转
    if (!appended) {
      dataSource.hasMore = false;
    }

    return appended;
  }

  /**
   * 渲染下一批聊天记录项。
   * @param {HTMLElement} listContainer - 列表容器元素
   * @param {string[]} pinnedIds - 当前置顶的ID列表
   * @param {string} originalFilterTextForHighlight - 用于文本高亮的原始过滤文本
   * @param {string} currentPanelFilter - 调用此函数时面板当前的过滤条件，用于一致性检查
   */
  async function renderMoreItems(listContainer, pinnedIds, originalFilterTextForHighlight, currentPanelFilter, currentRunId) {
    if (isLoadingMoreItems) {
      return;
    }
    isLoadingMoreItems = true;

    const panel = listContainer.closest('#chat-history-panel');
    if (panel && (panel.dataset.currentFilter !== currentPanelFilter || panel.dataset.runId !== currentRunId)) {
      isLoadingMoreItems = false;
      return;
    }
    // 树状视图（且无筛选）时：不插入“时间分组标题”，保证父子节点紧邻显示。
    const isBranchTreeOrderingActive = !!(
      panel &&
      panel.dataset.branchViewMode === 'tree' &&
      !(panel.dataset.currentFilter || '').trim()
    );

    // 若已渲染到当前已加载数据末尾：在 paged 模式下尝试继续从 DB 追加下一页
    if (currentlyRenderedCount >= currentDisplayItems.length) {
      const appended = await appendNextUnpinnedPageForPagedMode(panel, pinnedIds, currentPanelFilter, currentRunId);
      if (!appended || currentlyRenderedCount >= currentDisplayItems.length) {
        isLoadingMoreItems = false;
        return;
      }
    }

    const fragment = document.createDocumentFragment();
    let itemsRenderedInThisCall = 0;

    for (let i = 0; (currentlyRenderedCount + i) < currentDisplayItems.length && i < BATCH_SIZE; i++) {
      const convIndex = currentlyRenderedCount + i;
      const conv = currentDisplayItems[convIndex];
      const isConvPinned = pinnedIds.includes(conv.id);

      if (!isConvPinned && !isBranchTreeOrderingActive) {
        const isFirstUnpinnedAfterPinnedBlock = (convIndex === currentPinnedItemsCountInDisplay);

        let groupKey = '';
        let groupText = '';
        let groupTitle = '';

        if (panel?._historyDataSource?.mode === 'url') {
          const level = Number.isFinite(Number(conv?.urlMatchLevel)) ? Number(conv.urlMatchLevel) : null;
          const prefix = typeof conv?.urlMatchPrefix === 'string' ? conv.urlMatchPrefix : '';
          groupKey = `urlMatchLevel:${level == null ? 'unknown' : level}`;
          if (level == null) {
            groupText = 'URL 匹配';
            groupTitle = prefix ? `URL 前缀匹配\n匹配前缀: ${prefix}` : 'URL 前缀匹配';
          } else {
            groupText = `匹配 L${level}`;
            groupTitle = prefix
              ? `URL 匹配等级：L${level}（越小越精确）\n匹配前缀: ${prefix}`
              : `URL 匹配等级：L${level}（越小越精确）`;
          }
        } else {
          const convDate = new Date(conv.endTime);
          const groupLabel = getGroupLabel(convDate);
          groupKey = groupLabel;
          groupText = groupLabel;
        }

        if (isFirstUnpinnedAfterPinnedBlock || currentGroupLabelForBatchRender !== groupKey) {
          const groupHeader = document.createElement('div');
          groupHeader.className = 'chat-history-group-header';
          groupHeader.textContent = groupText;
          if (groupTitle) groupHeader.title = groupTitle;
          fragment.appendChild(groupHeader);
          currentGroupLabelForBatchRender = groupKey;
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

    if (itemsRenderedInThisCall > 0) {
      requestAnimationFrame(() => {
        const panelNow = listContainer.closest('#chat-history-panel');
        if (!panelNow) return;
        if (panelNow.dataset.currentFilter !== currentPanelFilter || panelNow.dataset.runId !== currentRunId) return;
        const ds = panelNow._historyDataSource;
        const mayHaveMore = ds && ds.mode === 'paged' && ds.hasMore;
        if (listContainer.scrollHeight <= listContainer.clientHeight && (currentlyRenderedCount < currentDisplayItems.length || mayHaveMore)) {
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
        const normalizedContent = normalizeStoredMessageContent(msg?.content);
        if (Array.isArray(normalizedContent)) {
          for (let idx = 0; idx < normalizedContent.length; idx++) {
            const part = normalizedContent[idx];
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
  async function activateChatHistoryTab(panel, tabName) {
    if (!panel) return;

    const tabBar = panel.querySelector('.history-tab-bar');
    const tabContents = panel.querySelector('.history-tab-contents');
    if (!tabBar || !tabContents) return;

    const safeTabName = (typeof tabName === 'string' && tabName.trim()) ? tabName.trim() : 'history';
    const targetTabEl = tabBar.querySelector(`.history-tab[data-tab="${safeTabName}"]`)
      || tabBar.querySelector('.history-tab[data-tab="history"]')
      || tabBar.querySelector('.history-tab');
    if (!targetTabEl) return;

    const resolvedTabName = targetTabEl.dataset.tab || 'history';
    const targetContent = tabContents.querySelector(`.history-tab-content[data-tab="${resolvedTabName}"]`);

    tabBar.querySelectorAll('.history-tab').forEach(tab => tab.classList.remove('active'));
    tabContents.querySelectorAll('.history-tab-content').forEach(content => content.classList.remove('active'));

    targetTabEl.classList.add('active');
    if (targetContent) {
      targetContent.classList.add('active');
    }

    if (resolvedTabName === 'history') {
      const filterInput = panel.querySelector('.filter-container input[type="text"]');
      requestAnimationFrame(() => filterInput?.focus());
      return;
    }

    if (resolvedTabName === 'gallery') {
      if (targetContent) await renderGalleryTab(targetContent);
      return;
    }

    if (resolvedTabName === 'stats') {
      if (!targetContent) return;
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
      return;
    }

    if (resolvedTabName === 'api-settings') {
      try {
        // 说明：保持与旧逻辑一致——进入 API 设置时刷新一次配置并重新渲染卡片。
        await services.apiManager?.loadAPIConfigs?.();
        services.apiManager?.renderAPICards?.();
        services.apiManager?.renderFavoriteApis?.();
      } catch (e) {
        console.error('切换到 API 设置标签失败:', e);
      }
      return;
    }

    if (resolvedTabName === 'prompt-settings') {
      try {
        // 说明：提示词面板内部本身带有 storage 监听；这里刷新一次，确保跨标签页修改后立即可见。
        await services.promptSettingsManager?.loadPromptSettings?.();
      } catch (e) {
        console.error('切换到提示词设置标签失败:', e);
      }
      return;
    }
  }

  function getActiveChatHistoryTabName() {
    const panel = document.getElementById('chat-history-panel');
    return panel?.querySelector('.history-tab.active')?.dataset?.tab || null;
  }

  async function showChatHistoryPanel(initialTab = 'history') {
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

      const promptTab = document.createElement('div');
      promptTab.className = 'history-tab';
      promptTab.textContent = '提示词设置';
      promptTab.dataset.tab = 'prompt-settings';

      const apiTab = document.createElement('div');
      apiTab.className = 'history-tab';
      apiTab.textContent = 'API 设置';
      apiTab.dataset.tab = 'api-settings';
      
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
      tabBar.appendChild(promptTab);
      tabBar.appendChild(apiTab);
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
        // 若输入值与当前已加载筛选一致，则无需重复触发（例如输入法 compositionend 后紧跟的 input 事件）
        if (panel.dataset.currentFilter === filterInput.value) return;
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(triggerSearch, HISTORY_SEARCH_DEBOUNCE_MS);
      };
      filterInput.addEventListener('input', onFilterInput);
      filterInput.addEventListener('compositionstart', () => { isComposingFilter = true; });
      filterInput.addEventListener('compositionend', () => {
        isComposingFilter = false;
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        triggerSearch();
      });
      // Enter：立即触发一次搜索，适合“输入完成后快速确认”场景
      filterInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (isComposingFilter) return;
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        triggerSearch();
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

      // 当前 URL 快速筛选按钮：只显示与当前页面 URL 相关的历史会话（按前缀匹配分级）
      const urlFilterButton = document.createElement('button');
      urlFilterButton.textContent = '本页';
      // 说明：额外加 role class，避免未来同容器内出现多个“类似按钮”时 querySelector 误选
      urlFilterButton.className = 'url-filter-btn url-filter-toggle';
      urlFilterButton.style.marginLeft = '5px';

      const updateFilterInputPlaceholder = () => {
        if (!filterInput) return;
        const isUrlMode = panel.dataset.urlFilterMode === 'currentUrl';
        const isTreeMode = panel.dataset.branchViewMode === 'tree';
        const base = isUrlMode
          ? '本页会话内筛选（仍可输入文本或 >10, <5, =20...）'
          : '筛选文本 或 >10, <5, =20...';
        // 树状视图本身只在“无筛选”时改变排序；这里仅提示用户当前处于该模式
        filterInput.placeholder = isTreeMode ? `${base}（树状）` : base;
      };

      const updateUrlFilterButtonState = () => {
        const currentUrl = state.pageInfo?.url;
        const hasUrl = !!(currentUrl && typeof currentUrl === 'string' && currentUrl.trim());
        urlFilterButton.disabled = !hasUrl;
        urlFilterButton.title = hasUrl
          ? '快速筛选出与当前页面 URL 相关的历史会话（按 URL 前缀分级匹配）'
          : '未能获取当前页面 URL，无法启用“本页”筛选';
        urlFilterButton.classList.toggle('active', panel.dataset.urlFilterMode === 'currentUrl');
        updateFilterInputPlaceholder();
      };

      urlFilterButton.addEventListener('click', () => {
        const currentUrl = state.pageInfo?.url;
        const hasUrl = !!(currentUrl && typeof currentUrl === 'string' && currentUrl.trim());
        if (!hasUrl) return;
        const nextActive = panel.dataset.urlFilterMode !== 'currentUrl';
        panel.dataset.urlFilterMode = nextActive ? 'currentUrl' : '';
        updateUrlFilterButtonState();
        loadConversationHistories(panel, filterInput ? filterInput.value : '');
        filterInput?.focus();
      });

      updateUrlFilterButtonState();
      filterContainer.appendChild(urlFilterButton);

      // 分支树状视图开关：按 parentConversationId 以缩进方式展示“分支会话”结构
      const branchTreeButton = document.createElement('button');
      branchTreeButton.textContent = '树状';
      branchTreeButton.className = 'url-filter-btn branch-tree-btn';
      branchTreeButton.style.marginLeft = '5px';
      branchTreeButton.title = '树状显示分支对话（需要读取全部会话元数据，列表加载可能比默认模式稍慢）';

      const updateBranchTreeButtonState = () => {
        const active = panel.dataset.branchViewMode === 'tree';
        branchTreeButton.classList.toggle('active', active);
        updateFilterInputPlaceholder();
      };

      branchTreeButton.addEventListener('click', () => {
        const nextActive = panel.dataset.branchViewMode !== 'tree';
        panel.dataset.branchViewMode = nextActive ? 'tree' : '';
        updateBranchTreeButtonState();
        loadConversationHistories(panel, filterInput ? filterInput.value : '');
        filterInput?.focus();
      });

      updateBranchTreeButtonState();
      filterContainer.appendChild(branchTreeButton);
      
      historyContent.appendChild(filterContainer);

      // 列表容器
      const listContainer = document.createElement('div');
      listContainer.id = 'chat-history-list';
      historyContent.appendChild(listContainer);

      // 提示词设置标签内容（复用 sidebar.html 中的 DOM）
      const promptSettingsContent = dom.promptSettingsPanel;
      if (promptSettingsContent) {
        promptSettingsContent.classList.add('history-tab-content');
        promptSettingsContent.dataset.tab = 'prompt-settings';
        // 旧样式通过 .visible 控制显示；嵌入标签页后统一由 .active 控制。
        promptSettingsContent.classList.remove('visible');
      }

      // API 设置标签内容（复用 sidebar.html 中的 DOM）
      const apiSettingsContent = dom.apiSettingsPanel;
      if (apiSettingsContent) {
        apiSettingsContent.classList.add('history-tab-content');
        apiSettingsContent.dataset.tab = 'api-settings';
        apiSettingsContent.classList.remove('visible');
      }
      
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
      if (promptSettingsContent) tabContents.appendChild(promptSettingsContent);
      if (apiSettingsContent) tabContents.appendChild(apiSettingsContent);
      tabContents.appendChild(galleryContent);
      tabContents.appendChild(statsContent);
      tabContents.appendChild(backupSettingsContent);
      panel.appendChild(tabContents);
      
      // 设置标签切换事件（异步以支持 await 刷新）
      tabBar.addEventListener('click', async (e) => {
        if (!e.target.classList.contains('history-tab')) return;
        await activateChatHistoryTab(panel, e.target.dataset.tab);
      });
      
      document.body.appendChild(panel);
    } else {
      // 如果面板已存在，获取 filterInput 引用
      filterInput = panel.querySelector('.filter-container input[type="text"]');
      const urlFilterButton = panel.querySelector('.filter-container .url-filter-btn.url-filter-toggle');
      const branchTreeButton = panel.querySelector('.filter-container .branch-tree-btn');
      if (urlFilterButton) {
        const currentUrl = state.pageInfo?.url;
        const hasUrl = !!(currentUrl && typeof currentUrl === 'string' && currentUrl.trim());
        urlFilterButton.disabled = !hasUrl;
        urlFilterButton.title = hasUrl
          ? '快速筛选出与当前页面 URL 相关的历史会话（按 URL 前缀分级匹配）'
          : '未能获取当前页面 URL，无法启用“本页”筛选';
        urlFilterButton.classList.toggle('active', panel.dataset.urlFilterMode === 'currentUrl');
      }
      if (branchTreeButton) {
        branchTreeButton.classList.toggle('active', panel.dataset.branchViewMode === 'tree');
      }
      if (filterInput) {
        const isUrlMode = panel.dataset.urlFilterMode === 'currentUrl';
        const isTreeMode = panel.dataset.branchViewMode === 'tree';
        const base = isUrlMode
          ? '本页会话内筛选（仍可输入文本或 >10, <5, =20...）'
          : '筛选文本 或 >10, <5, =20...';
        filterInput.placeholder = isTreeMode ? `${base}（树状）` : base;
      }
    }
    
    // 使用已有的筛选值加载历史记录
    const currentFilter = filterInput ? filterInput.value : '';
    loadConversationHistories(panel, currentFilter);

    // 刷新一次“会话-标签页存在性”快照，确保右侧“已打开/跳转”标记尽快准确
    try { conversationPresence?.refreshOpenConversations?.(); } catch (_) {}

    // 切换到目标标签（同步更新 active 类；耗时渲染逻辑异步执行）
    // 说明：这里不 await，避免打开面板被 “图片/统计/API加载” 阻塞。
    void activateChatHistoryTab(panel, initialTab);

    panel.style.display = 'flex';
    void panel.offsetWidth;  
    panel.classList.add('visible');

    // 预热全量元数据（idle），降低“首次全文搜索”的启动延迟
    scheduleConversationMetadataWarmup(panel);
    
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
      try { conversationPresence?.refreshOpenConversations?.(); } catch (_) {}
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
    
    // 恢复当前活动会话到缓存
    if (activeId && activeConv) {
      loadedConversations.set(activeId, activeConv);
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
      // 记录分支来源（保存后 currentConversationId 必然存在）
      const parentConversationId = currentConversationId || null;

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

      // 说明：
      // - 这里必须“物化(materialize)”每条消息的 content，禁止把旧会话的 contentRef 直接带进新会话；
      // - 否则新会话会与旧会话共享同一个 messageContents 记录：
      //   1) 一旦删除分支会话，deleteConversation 会把共享 contentRef 删掉，导致原会话图片丢失；
      //   2) 若分支消息仅有 contentRef 而无 content，putConversation 可能误判并清理引用，进一步造成丢失。
      const cloneSafely = (obj) => {
        try { return structuredClone(obj); } catch (_) {}
        try { return JSON.parse(JSON.stringify(obj)); } catch (_) {}
        return obj;
      };

      const resolveMessageContent = async (msg) => {
        if (!msg) return '';
        if (msg.content !== undefined && msg.content !== null) return cloneSafely(msg.content);
        if (msg.content === null) return '';
        if (msg.contentRef) {
          try {
            const loaded = await loadMessageContent(msg.contentRef);
            return cloneSafely(loaded);
          } catch (e) {
            console.warn('创建分支对话：读取消息内容引用失败，将回退为空内容', msg.contentRef, e);
            return '';
          }
        }
        return '';
      };

      const generateForkMessageId = () => `fork_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // 复制截取的消息到新的ChatHistory
      let previousId = null;
      for (let i = 0; i <= targetIndex; i++) {
        const originalMsg = currentChain[i];
        const resolvedContent = await resolveMessageContent(originalMsg);
        const newMsg = {
          ...cloneSafely(originalMsg), // 深拷贝（尽量不共享引用，避免后续修改污染原会话）
          id: generateForkMessageId(),
          parentId: previousId,
          children: [],
          content: normalizeStoredMessageContent(resolvedContent)
        };
        // 永远不要复用旧会话的 contentRef（避免跨会话共享 messageContents 记录）
        if (newMsg.contentRef) delete newMsg.contentRef;
        
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
      
      // 分支对话摘要：复用同一套“指令类型驱动”的标题逻辑，并保持旧行为（先截断再追加分支后缀）
      const promptsConfig = promptSettingsManager.getPrompts();
      const baseSummary = buildConversationSummaryFromMessages(newChatHistory.messages, {
        promptsConfig,
        pageTitle: pageInfo?.title || '',
        maxLength: 50
      });
      const summary = baseSummary ? `${baseSummary} (分支)` : '分支对话';
      
      // 创建新的会话对象
      const newConversation = {
        id: newConversationId,
        messages: newChatHistory.messages,
        summary: summary,
        startTime: startTime,
        endTime: endTime,
        title: pageInfo?.title || '',
        url: pageInfo?.url || '',
        // --- 分支元信息（用于“历史面板树状显示”）---
        // 设计说明：
        // - 分支对话本质上是“从某个会话的某条消息处截断并复制出一个新会话”；
        // - 这里显式记录父会话 ID + 分支点消息 ID，避免后续只能靠正则/内容猜测；
        // - 允许父会话被删除：UI 侧渲染树时可将其作为“孤儿分支”顶层展示。
        parentConversationId,
        forkedFromMessageId: targetMessageId || null,
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
    activateTab: async (tabName) => {
      const panel = document.getElementById('chat-history-panel');
      if (!panel) return;
      await activateChatHistoryTab(panel, tabName);
    },
    getActiveTabName: getActiveChatHistoryTabName,
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
