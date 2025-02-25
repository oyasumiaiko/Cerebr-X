/**
 * 聊天历史界面管理模块 - 负责聊天历史的UI展示、交互和持久化
 * @module ChatHistoryUI
 */

import { getAllConversations, putConversation, deleteConversation, getConversationById } from './indexeddb_helper.js';

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

    let urlToSave = currentPageInfo?.url || '';
    let titleToSave = currentPageInfo?.title || '';
    // 如果是更新操作并且已存在记录，则固定使用首次保存的 url
    if (isUpdate && currentConversationId) {
      try {
        const existingConversation = await getConversationById(currentConversationId);
        if (existingConversation) {
          urlToSave = existingConversation.url;
          titleToSave = existingConversation.title;
        }
      } catch (error) {
        console.error("获取会话记录失败:", error);
      }
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
    currentConversationId = conversation.id;
    console.log(`已${isUpdate ? '更新' : '保存'}对话记录:`, conversation);
  }

  /**
   * 加载选中的对话记录到当前聊天窗口
   * @param {Object} conversation - 对话记录对象
   */
  function loadConversationIntoChat(conversation) {
    // 清空当前聊天容器
    chatContainer.innerHTML = '';
    // 遍历对话中的每条消息并显示
    conversation.messages.forEach(msg => {
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
    chatHistory.messages = conversation.messages.slice();
    // 若存在消息，则设置第一条消息的 id 为根节点
    chatHistory.root = conversation.messages.length > 0 ? conversation.messages[0].id : null;
    // 将 currentNode 更新为最后一条消息的 id
    chatHistory.currentNode = conversation.messages.length > 0 ? conversation.messages[conversation.messages.length - 1].id : null;
    // 保存加载的对话记录ID，用于后续更新操作
    currentConversationId = conversation.id;
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
  function loadConversationHistories(panel, filterText) {
    const listContainer = panel.querySelector('#chat-history-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    getAllConversations().then(histories => {
      if (filterText) {
        const lowerFilter = filterText.toLowerCase();
        histories = histories.filter(conv => {
          const url = (conv.url || '').toLowerCase();
          const summary = (conv.summary || '').toLowerCase();
          const messagesContent = conv.messages && conv.messages.length
            ? conv.messages.map(msg => msg.content || '').join(' ')
            : '';
          const lowerMessages = messagesContent.toLowerCase();
          return url.includes(lowerFilter) || summary.includes(lowerFilter) || lowerMessages.includes(lowerFilter);
        });
      }

      if (histories.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.textContent = '暂无聊天记录';
        listContainer.appendChild(emptyMsg);
        return;
      }
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

          const summaryDiv = document.createElement('div');
          summaryDiv.className = 'summary';
          let displaySummary = conv.summary;
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
          // 新增：鼠标悬停显示具体的日期时间

          const details = [convDate.toLocaleString(), title, conv.url].filter(Boolean).join('\n');
          infoDiv.title = details;

          item.appendChild(summaryDiv);
          item.appendChild(infoDiv);

          // 如果有筛选关键字, 尝试提取所有匹配关键字附近的内容作为 snippet
          if (filterText && filterText.trim() !== "") {
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

          // 添加聊天记录项的点击事件（加载对话）
          item.addEventListener('click', () => {
            loadConversationIntoChat(conv);
            // 保持聊天记录面板打开
          });
          // 新增：添加右键事件，显示删除菜单
          item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showChatHistoryItemContextMenu(e, conv.id);
          });

          listContainer.appendChild(item);
        });
      });
    }).catch(err => {
      console.error("加载聊天记录失败", err);
    });
  }

  /**
   * 显示聊天记录面板
   */
  function showChatHistoryPanel() {
    let panel = document.getElementById('chat-history-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'chat-history-panel';

      // 添加标题栏（包含标题、备份、还原和关闭按钮在同一行）
      const header = document.createElement('div');
      header.className = 'panel-header';

      const title = document.createElement('span');
      title.textContent = '聊天记录';
      title.className = 'panel-title';

      // 创建按钮容器，将备份、还原和关闭按钮放在同一行，样式与关闭按钮一致
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
      panel.appendChild(filterContainer);

      // 列表容器
      const listContainer = document.createElement('div');
      listContainer.id = 'chat-history-list';
      panel.appendChild(listContainer);
      document.body.appendChild(panel);
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
            const existing = await getConversationById(conv.id);
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
    getCurrentConversationId: () => currentConversationId
  };
} 