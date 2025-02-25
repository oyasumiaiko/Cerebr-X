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
 * @param {Function} options.appendMessage - 添加消息的函数
 * @param {Object} options.chatHistory - 聊天历史管理器实例
 * @param {Function} options.clearHistory - 清空聊天历史的函数
 * @param {Function} options.getPrompts - 获取提示词配置的函数
 * @param {Function} options.createImageTag - 创建图片标签的函数
 * @returns {Object} 聊天历史UI管理API
 */
export function createChatHistoryUI(options) {
  const {
    chatContainer,
    appendMessage,
    chatHistory,
    clearHistory,
    getPrompts,
    createImageTag
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
    
    // 如果是更新操作并且已存在记录，则固定使用首次保存的 url 和 title
    if (isUpdate && currentConversationId) {
      try {
        // 使用false参数，不加载完整内容，只获取元数据
        const existingConversation = await getConversationById(currentConversationId, false);
        if (existingConversation) {
          urlToSave = existingConversation.url || '';
          titleToSave = existingConversation.title || '';
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
      summary,
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
  }

  /**
   * 清空聊天记录
   * @returns {Promise<void>}
   */
  async function clearChatHistory() {
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
  }

  /**
   * 格式化相对时间字符串
   * @param {Date} date - 日期对象
   * @returns {string} 相对时间描述，例如 "5分钟前"、"2小时前"、"3天前"、"2周前"、"4月前"
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
    if (days < 7) return `${days}天前`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}周前`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}月前`;
    const years = Math.floor(days / 365);
    return `${years}年前`;
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
  function showChatHistoryItemContextMenu(e, conversationId) {
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

      // 刷新聊天记录面板
      const panel = document.getElementById('chat-history-panel');
      if (panel) {
        const filterInput = panel.querySelector('input[type="text"]');
        loadConversationHistories(panel, filterInput ? filterInput.value : '');
      }
    });

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
   * 加载聊天历史记录列表
   * @param {HTMLElement} panel - 聊天历史面板元素
   * @param {string} filterText - 过滤文本
   */
  async function loadConversationHistories(panel, filterText) {
    const listContainer = panel.querySelector('#chat-history-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    
    // 使用元数据加载，减少内存占用
    const histories = await getAllConversationMetadata();
    
    if (filterText) {
      const lowerFilter = filterText.toLowerCase();
      // 对于有过滤条件的情况，需要加载完整内容进行搜索
      // 这里为了避免内存压力，我们逐个加载并搜索，而不是一次性加载所有内容
      const filteredHistories = [];
      
      // 显示加载指示器
      const loadingIndicator = document.createElement('div');
      loadingIndicator.textContent = '正在搜索...';
      loadingIndicator.className = 'search-loading-indicator';
      listContainer.appendChild(loadingIndicator);
      
      // 异步搜索每个会话
      for (const historyMeta of histories) {
        // 先检查元数据是否匹配
        const url = (historyMeta.url || '').toLowerCase();
        const summary = (historyMeta.summary || '').toLowerCase();
        
        if (url.includes(lowerFilter) || summary.includes(lowerFilter)) {
          filteredHistories.push(historyMeta);
          continue;
        }
        
        // 如果元数据不匹配，则加载完整内容并搜索
        try {
          const fullConversation = await getConversationById(historyMeta.id);
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
              filteredHistories.push(fullConversation);
            } else {
              // 释放内存
              if (fullConversation.id !== activeConversation?.id) {
                loadedConversations.delete(fullConversation.id);
              }
            }
          }
        } catch (error) {
          console.error(`搜索会话 ${historyMeta.id} 失败:`, error);
        }
      }
      
      // 移除加载指示器
      loadingIndicator.remove();
      
      // 显示过滤结果
      if (filteredHistories.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.textContent = '没有匹配的聊天记录';
        listContainer.appendChild(emptyMsg);
        return;
      }
      
      displayConversationList(filteredHistories, filterText, listContainer);
    } else {
      // 没有过滤条件，直接显示元数据列表
      if (histories.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.textContent = '暂无聊天记录';
        listContainer.appendChild(emptyMsg);
        return;
      }
      
      displayConversationList(histories, '', listContainer);
    }
  }
  
  /**
   * 显示会话列表
   * @param {Array<Object>} histories - 会话历史数组
   * @param {string} filterText - 过滤文本
   * @param {HTMLElement} listContainer - 列表容器元素
   */
  function displayConversationList(histories, filterText, listContainer) {
    // 按结束时间降序排序
    histories.sort((a, b) => b.endTime - a.endTime);

    // 根据会话的开始时间进行分组
    const groups = {};
    const groupLatestTime = {}; // 用于记录各分组中最新的会话时间以便排序
    histories.forEach(conv => {
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

    // 根据每个分组中最新的时间降序排序分组
    const sortedGroupLabels = Object.keys(groups).sort((a, b) => groupLatestTime[b] - groupLatestTime[a]);

    sortedGroupLabels.forEach(groupLabel => {
      // 创建分组标题
      const groupHeader = document.createElement('div');
      groupHeader.className = 'chat-history-group-header';
      groupHeader.textContent = groupLabel;
      listContainer.appendChild(groupHeader);

      groups[groupLabel].forEach(conv => {
        const item = document.createElement('div');
        item.className = 'chat-history-item';
        // 保存会话ID作为属性，便于后续加载
        item.setAttribute('data-id', conv.id);

        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'summary';
        let displaySummary = conv.summary || '';
        if (filterText && filterText.trim() !== "") {
          const regex = new RegExp(`(${filterText})`, 'gi');
          displaySummary = displaySummary.replace(regex, '<mark>$1</mark>');
        }
        summaryDiv.innerHTML = displaySummary;
        
        const infoDiv = document.createElement('div');
        infoDiv.className = 'info';
        const convDate = new Date(conv.startTime);
        const relativeTime = formatRelativeTime(convDate);

        // 提取 URL 中的 domain
        let domain = '';
        if (conv.url) {
          try {
            const urlObj = new URL(conv.url);
            domain = urlObj.hostname;
          } catch (error) {
            domain = conv.url;
          }
        } else {
          domain = '未知';
        }

        let title = conv.title;

        const displayInfos = [relativeTime, `消息数: ${conv.messageCount}`, domain].filter(Boolean).join(' · ');
        infoDiv.textContent = displayInfos;
        // 鼠标悬停显示具体的日期时间
        const details = [convDate.toLocaleString(), title, conv.url].filter(Boolean).join('\n');
        infoDiv.title = details;

        item.appendChild(summaryDiv);
        item.appendChild(infoDiv);

        // 如果有筛选关键字且对象中包含完整消息，尝试提取所有匹配关键字附近的内容作为 snippet
        if (filterText && filterText.trim() !== "" && conv.messages) {
          let snippets = [];
          let totalMatches = 0;
          // 对 filterText 进行转义，避免正则特殊字符问题
          const escapedFilter = filterText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const lowerFilter = filterText.toLowerCase();
          // 预先构造用于高亮的正则对象
          const highlightRegex = new RegExp(escapedFilter, 'gi');
          if (conv.messages && Array.isArray(conv.messages)) {
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
                    // 高亮 snippet 中所有匹配关键字，复用 highlightRegex
                    snippet = snippet.replace(highlightRegex, '<mark>$&</mark>');
                    snippets.push(snippet);
                  }
                  startIndex = index + 1;
                }
              }
            }
          }
          if (snippets.length > 0) {
            const snippetDiv = document.createElement('div');
            snippetDiv.className = 'highlight-snippet';
            let displaySnippets = snippets.map(s => '…' + s + '…');
            if (totalMatches > snippets.length) {
              displaySnippets.push(`…… 共 ${totalMatches} 匹配`);
            }
            snippetDiv.innerHTML = displaySnippets.join('<br>');
            item.appendChild(snippetDiv);
          }
        }

        // 添加聊天记录项的点击事件
        item.addEventListener('click', async () => {
          // 加载对话到聊天窗口
          const conversation = await getConversationFromCacheOrLoad(conv.id);
          if (conversation) {
            loadConversationIntoChat(conversation);
          }
        });
        
        // 添加右键事件，显示删除菜单
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showChatHistoryItemContextMenu(e, conv.id);
        });

        listContainer.appendChild(item);
      });
    });
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
      const filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.placeholder = '筛选...';
      let debounceTimer;
      filterInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          loadConversationHistories(panel, filterInput.value);
        }, 300);
      });
      filterContainer.appendChild(filterInput);
      historyContent.appendChild(filterContainer);

      // 列表容器
      const listContainer = document.createElement('div');
      listContainer.id = 'chat-history-list';
      historyContent.appendChild(listContainer);
      
      // 统计数据标签内容
      const statsContent = document.createElement('div');
      statsContent.className = 'history-tab-content';
      statsContent.dataset.tab = 'stats';
      
      // 加载统计信息
      const statsData = await getDbStatsWithCache();
      const statsPanel = renderStatsPanel(statsData);
      statsContent.appendChild(statsPanel);
      
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
          tabContents.querySelector(`.history-tab-content[data-tab="${tabName}"]`).classList.add('active');
        }
      });
      
      document.body.appendChild(panel);
    } else {
      // 如果面板已存在，更新统计数据
      const statsContent = panel.querySelector('.history-tab-content[data-tab="stats"]');
      if (statsContent) {
        const statsData = await getDbStatsWithCache();
        const statsPanel = renderStatsPanel(statsData);
        
        const oldStatsPanel = statsContent.querySelector('.db-stats-panel');
        if (oldStatsPanel) {
          oldStatsPanel.replaceWith(statsPanel);
        } else {
          statsContent.appendChild(statsPanel);
        }
      }
    }
    
    // 加载默认（不过滤）的对话记录列表
    loadConversationHistories(panel, '');

    // 设置面板显示，并触发 CSS 淡入动画
    panel.style.display = 'flex';  // 面板采用 flex 布局
    void panel.offsetWidth;  // 强制重排，让 CSS transition 起效
    panel.classList.add('visible');
  }

  /**
   * 刷新聊天记录面板
   */
  function refreshChatHistory() {
    const panel = document.getElementById('chat-history-panel');
    if (panel) {
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
    clearMemoryCache
  };
} 