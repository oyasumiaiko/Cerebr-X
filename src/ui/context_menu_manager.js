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
  const threadContainer = dom.threadContainer;
  const forkConversationButton = dom.forkConversationButton;
  const copyAsImageButton = dom.copyAsImageButton; // Assuming it's in dom
  const editMessageButton = document.getElementById('edit-message');
  const insertMessageMenu = document.getElementById('insert-message-menu');
  const insertMessageSubmenu = insertMessageMenu?.querySelector('.context-menu-submenu');
  const insertMessageSubmenuList = insertMessageSubmenu?.querySelector('.context-menu-submenu-list');
  const regenerateSubmenu = regenerateButton?.querySelector('.context-menu-submenu');
  const regenerateSubmenuList = regenerateSubmenu?.querySelector('.context-menu-submenu-list');
  const regenerateApiHint = document.getElementById('regenerate-message-api-hint');
  const lockApiFromMessageButton = document.getElementById('lock-api-from-message');

  // Services from appContext.services
  const messageSender = services.messageSender;
  const messageProcessor = services.messageProcessor;
  const chatHistoryUI = services.chatHistoryUI;
  const chatHistoryManager = services.chatHistoryManager;
  const chatHistory = chatHistoryManager.chatHistory; // The actual history data object
  const apiManager = services.apiManager;

  // Private state
  let currentMessageElement = null;
  let currentMessageContainer = null;
  let currentCodeBlock = null;
  let isEditing = false;

  function resolveMessageContainer(messageElement) {
    if (!messageElement) return chatContainer;
    if (threadContainer && threadContainer.contains(messageElement)) return threadContainer;
    if (chatContainer && chatContainer.contains(messageElement)) return chatContainer;
    return chatContainer;
  }

  function findHistoryMessageById(messageId) {
    const id = (typeof messageId === 'string') ? messageId.trim() : '';
    if (!id || !chatHistoryManager?.chatHistory?.messages) return null;
    return chatHistoryManager.chatHistory.messages.find(node => node?.id === id) || null;
  }

  /**
   * 从历史树中收集某条用户消息后“同一层”的所有 AI 回复（用于并行重生成）。
   *
   * 说明：
   * - 仅收集直接 children，避免误把后续轮次的 AI 回复混入当前批次；
   * - 若历史链暂时不完整，会用 fallbackAiMessageId 兜底，确保至少能重生成当前目标。
   *
   * @param {string} userMessageId
   * @param {string|null} [fallbackAiMessageId=null]
   * @returns {Array<string>}
   */
  function collectParallelAiMessageIdsForUser(userMessageId, fallbackAiMessageId = null) {
    const userNode = findHistoryMessageById(userMessageId);
    const fallbackId = (typeof fallbackAiMessageId === 'string') ? fallbackAiMessageId.trim() : '';
    if (!userNode) {
      return fallbackId ? [fallbackId] : [];
    }

    const childIds = Array.isArray(userNode.children) ? userNode.children : [];
    const threadId = userNode.threadId || null;
    const aiChildren = childIds
      .map((childId, index) => {
        const node = findHistoryMessageById(childId);
        if (!node || node.role !== 'assistant') return null;
        if (threadId && node.threadId !== threadId) return null;
        if (node.threadHiddenSelection) return null;
        return {
          id: node.id,
          timestamp: Number(node.timestamp) || 0,
          order: index
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
        return a.order - b.order;
      })
      .map(item => item.id)
      .filter(Boolean);

    if (fallbackId && !aiChildren.includes(fallbackId)) {
      aiChildren.push(fallbackId);
    }

    return aiChildren;
  }

  /**
   * 在线程容器内，优先使用历史链路解析“重新生成”的目标，避免 DOM 被隐藏/重排时误判。
   * @param {HTMLElement} messageElement
   * @param {HTMLElement|null} container
   * @returns {Object|null}
   */
  function resolveRegenerateTargetFromHistory(messageElement, container) {
    const messageId = messageElement?.getAttribute?.('data-message-id') || '';
    if (!messageId) return null;
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    const findNode = (id) => nodes.find(n => n.id === id) || null;
    const node = findNode(messageId);
    if (!node) return null;

    const isAi = node.role === 'assistant';
    const isUser = node.role === 'user';
    if (!isAi && !isUser) return null;

    const findParentUser = (startNode) => {
      let current = startNode;
      const visited = new Set();
      while (current) {
        if (current.role === 'user') return current;
        if (visited.has(current.id)) break;
        visited.add(current.id);
        current = current.parentId ? findNode(current.parentId) : null;
      }
      return null;
    };

    const findNextAi = (startNode, threadId) => {
      let current = startNode;
      const visited = new Set();
      while (current) {
        const children = Array.isArray(current.children) ? current.children : [];
        const candidates = children
          .map(id => findNode(id))
          .filter(Boolean)
          .filter(child => !threadId || child.threadId === threadId);
        if (!candidates.length) return null;
        // 线程内默认按时间最早的子节点作为“下一条”
        const next = candidates.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0];
        if (!next || visited.has(next.id)) return null;
        if (next.role === 'assistant') return next;
        visited.add(next.id);
        current = next;
      }
      return null;
    };

    const userNode = isUser ? node : findParentUser(node);
    if (!userNode) return null;

    let targetAiNode = isAi ? node : findNextAi(userNode, userNode.threadId || null);
    // 说明：当连续出现多条 user 消息时，重新生成应等价于“最后一条 user -> 下一条 AI”，
    // 这样上下文会覆盖整个连续 user 片段，避免在中途选中时丢掉后续用户消息。
    let effectiveUserNode = userNode;
    if (targetAiNode) {
      const parentUser = findParentUser(targetAiNode);
      if (parentUser) {
        effectiveUserNode = parentUser;
      }
    } else {
      // 没有 AI（例如尚未回复）：沿着最早子链向后，找到连续 user 的最后一条。
      let cursor = userNode;
      let lastUser = userNode;
      const visited = new Set();
      while (cursor) {
        const children = Array.isArray(cursor.children) ? cursor.children : [];
        const candidates = children
          .map(id => findNode(id))
          .filter(Boolean)
          .filter(child => !userNode.threadId || child.threadId === userNode.threadId);
        if (!candidates.length) break;
        const next = candidates.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0];
        if (!next || visited.has(next.id)) break;
        if (next.role === 'assistant') break;
        if (next.role === 'user') {
          lastUser = next;
        }
        visited.add(next.id);
        cursor = next;
      }
      effectiveUserNode = lastUser || userNode;
    }

    if (!effectiveUserNode || effectiveUserNode.threadHiddenSelection) return null;

    const userMessageId = effectiveUserNode.id || '';
    if (!userMessageId) return null;

    let userMessageElement = null;
    if (container) {
      const rawId = String(userMessageId);
      let safeId = rawId;
      try {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
          safeId = CSS.escape(rawId);
        }
      } catch (_) {
        safeId = rawId.replace(/["\\]/g, '\\$&');
      }
      userMessageElement = container.querySelector(`.message[data-message-id="${safeId}"]`);
    }

    // 线程内链路可能因编辑/删除造成 children 不完整，这里用 DOM 兜底匹配下一条 AI。
    const findNextAiElement = (startElement) => {
      let cursor = startElement ? startElement.nextElementSibling : null;
      while (cursor) {
        if (cursor.classList?.contains('ai-message')) return cursor;
        cursor = cursor.nextElementSibling;
      }
      return null;
    };

    let targetAiMessageElement = isAi ? messageElement : null;
    if (!targetAiNode && !isAi && userMessageElement && container) {
      const nextAiElement = findNextAiElement(userMessageElement);
      if (nextAiElement) {
        targetAiMessageElement = nextAiElement;
        const fallbackId = nextAiElement.getAttribute('data-message-id') || '';
        if (fallbackId) {
          targetAiNode = findNode(fallbackId);
        }
      }
    }

    const originalMessageText = userMessageElement?.getAttribute?.('data-original-text')
      || (typeof effectiveUserNode.content === 'string' ? effectiveUserNode.content : '');
    const targetAiMessageId = targetAiNode ? targetAiNode.id : (targetAiMessageElement?.getAttribute?.('data-message-id') || null);
    const targetAiMessageIds = isAi
      ? (targetAiMessageId ? [targetAiMessageId] : [])
      : collectParallelAiMessageIdsForUser(userMessageId, targetAiMessageId);

    return {
      sourceRole: isAi ? 'assistant' : 'user',
      sourceMessageId: node.id,
      userMessageElement,
      userMessageId,
      originalMessageText,
      targetAiMessageElement,
      targetAiMessageId,
      targetAiMessageIds
    };
  }

  /**
   * 解析“重新生成”的目标：
   * - 若右键/触发点是 AI 消息：重生成该 AI 消息（目标=自身），其对应的用户消息为「向上最近的一条 user」；
   * - 若右键/触发点是用户消息：重生成该用户消息之后的第一条 AI 消息（目标=下一条 AI）。
   *
   * 设计约束：
   * - 必须做到“只替换目标 AI 消息的内容”，不删除/不改动其他消息；
   * - 连续 user 消息视作同一“用户片段”：重生成应等价于“最后一条 user -> 下一条 AI”，
   *   上下文裁剪到该最后 user（messageId=该用户消息ID），以保留同片段内的所有 user 输入。
   *
   * @param {HTMLElement|null} messageElement
   * @returns {{
   *   sourceRole: 'assistant'|'user',
   *   sourceMessageId: string,
   *   userMessageElement: HTMLElement,
   *   userMessageId: string,
   *   originalMessageText: string,
   *   targetAiMessageElement: HTMLElement|null,
   *   targetAiMessageId: string|null,
   *   targetAiMessageIds: Array<string>
   * }|null}
   */
  function resolveRegenerateTarget(messageElement) {
    if (!messageElement || !(messageElement instanceof HTMLElement)) return null;

    const activeContainer = resolveMessageContainer(messageElement);
    if (activeContainer === threadContainer) {
      const threadTarget = resolveRegenerateTargetFromHistory(messageElement, activeContainer);
      if (threadTarget) return threadTarget;
    }

    // loading/error 占位消息不支持作为“目标消息”
    if (messageElement.classList.contains('loading-message')) return null;

    const isAi = messageElement.classList.contains('ai-message');
    const isUser = messageElement.classList.contains('user-message');
    if (!isAi && !isUser) return null;

    const findPrevUser = (start) => {
      let el = start;
      while (el && el.previousElementSibling) {
        el = el.previousElementSibling;
        if (el.classList && el.classList.contains('user-message')) return el;
      }
      return null;
    };

    const findNextAi = (start) => {
      let el = start;
      while (el && el.nextElementSibling) {
        el = el.nextElementSibling;
        if (el.classList && el.classList.contains('ai-message')) return el;
      }
      return null;
    };

    const findLastUserInBlock = (start) => {
      let lastUser = start;
      let cursor = start;
      while (cursor && cursor.nextElementSibling) {
        cursor = cursor.nextElementSibling;
        if (!cursor.classList || !cursor.classList.contains('message')) continue;
        if (cursor.classList.contains('user-message')) {
          lastUser = cursor;
          continue;
        }
        if (cursor.classList.contains('ai-message')) break;
        break;
      }
      return lastUser || start;
    };

    const baseUserElement = isAi ? findPrevUser(messageElement) : messageElement;
    // 说明：连续 user 消息时，把“最后一条 user”视为真正触发重生成的消息。
    const userMessageElement = (!isAi && baseUserElement) ? findLastUserInBlock(baseUserElement) : baseUserElement;
    if (!userMessageElement) return null;

    const userMessageId = userMessageElement.getAttribute('data-message-id') || '';
    const originalMessageText = userMessageElement.getAttribute('data-original-text') || '';

    // 用户消息允许为空（例如纯图片/截图场景），但必须有 messageId 才能裁剪上下文
    if (!userMessageId) return null;

    const targetAiMessageElement = isAi ? messageElement : findNextAi(userMessageElement);
    const targetAiMessageId = targetAiMessageElement
      ? (targetAiMessageElement.getAttribute('data-message-id') || null)
      : null;
    const targetAiMessageIds = isAi
      ? (targetAiMessageId ? [targetAiMessageId] : [])
      : collectParallelAiMessageIdsForUser(userMessageId, targetAiMessageId);

    return {
      sourceRole: isAi ? 'assistant' : 'user',
      sourceMessageId: messageElement.getAttribute('data-message-id') || '',
      userMessageElement,
      userMessageId,
      originalMessageText,
      targetAiMessageElement,
      targetAiMessageId,
      targetAiMessageIds
    };
  }

  function getFavoriteApiConfigs() {
    if (!apiManager || typeof apiManager.getAllConfigs !== 'function') return [];
    const configs = apiManager.getAllConfigs();
    if (!Array.isArray(configs)) return [];
    return configs.filter(config => config && config.isFavorite);
  }

  function getFavoriteApiLabel(config, index) {
    const displayName = (typeof config?.displayName === 'string') ? config.displayName.trim() : '';
    if (displayName) return displayName;
    const modelName = (typeof config?.modelName === 'string') ? config.modelName.trim() : '';
    if (modelName) return modelName;
    const baseUrl = (typeof config?.baseUrl === 'string') ? config.baseUrl.trim() : '';
    if (baseUrl) return baseUrl;
    return `收藏 API ${index + 1}`;
  }

  // 将任意 API 配置转换为可展示名称，避免出现空白小字。
  function getApiDisplayName(config) {
    const displayName = (typeof config?.displayName === 'string') ? config.displayName.trim() : '';
    if (displayName) return displayName;
    const modelName = (typeof config?.modelName === 'string') ? config.modelName.trim() : '';
    if (modelName) return modelName;
    const baseUrl = (typeof config?.baseUrl === 'string') ? config.baseUrl.trim() : '';
    if (baseUrl) return baseUrl;
    return 'API';
  }

  function resolveApiConfigFromHistoryNode(node) {
    if (!node || node.role !== 'assistant') return null;
    if (node.apiUuid && apiManager?.resolveApiParam) {
      const resolved = apiManager.resolveApiParam({ id: node.apiUuid });
      if (resolved) return resolved;
    }
    if (node.apiDisplayName && apiManager?.resolveApiParam) {
      const resolved = apiManager.resolveApiParam(node.apiDisplayName);
      if (resolved) return resolved;
    }
    if (node.apiModelId && apiManager?.resolveApiParam) {
      const resolved = apiManager.resolveApiParam(node.apiModelId);
      if (resolved) return resolved;
    }
    return null;
  }

  function resolveApiConfigFromMessage(messageElement) {
    if (!messageElement) return null;
    const messageId = messageElement.getAttribute('data-message-id') || '';
    if (!messageId) return null;
    const node = findHistoryMessageById(messageId);
    return resolveApiConfigFromHistoryNode(node);
  }

  function getRegenerateTargetAiIds(regenTarget) {
    if (!regenTarget || typeof regenTarget !== 'object') return [];
    if (Array.isArray(regenTarget.targetAiMessageIds) && regenTarget.targetAiMessageIds.length > 0) {
      return regenTarget.targetAiMessageIds
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean);
    }
    const single = (typeof regenTarget.targetAiMessageId === 'string') ? regenTarget.targetAiMessageId.trim() : '';
    return single ? [single] : [];
  }

  function resolveRegenerateTargetApiConfigMap(regenTarget) {
    const configMap = new Map();
    const targetIds = getRegenerateTargetAiIds(regenTarget);
    targetIds.forEach((targetId) => {
      if (!targetId || configMap.has(targetId)) return;
      const node = findHistoryMessageById(targetId);
      const config = resolveApiConfigFromHistoryNode(node);
      if (config) {
        configMap.set(targetId, config);
      }
    });
    return configMap;
  }

  function resolvePromptPreferredApiParam(originalMessageText) {
    let apiParam = 'follow_current';
    try {
      const promptSettingsManager = appContext.services.promptSettingsManager;
      const prompts = (typeof promptSettingsManager?.getPrompts === 'function')
        ? (promptSettingsManager.getPrompts() || {})
        : {};
      const content = (typeof originalMessageText === 'string') ? originalMessageText : '';
      const promptType = (typeof messageProcessor?.getPromptTypeFromContent === 'function')
        ? (messageProcessor.getPromptTypeFromContent(content, prompts) || 'none')
        : 'none';
      const modelPref = (prompts[promptType]?.model || '').trim();
      apiParam = modelPref || 'follow_current';
    } catch (_) {
      apiParam = 'follow_current';
    }
    return apiParam;
  }

  /**
   * 统一解析“重新生成”的 API 参数，确保展示与实际发送一致。
   * - 若传入 apiOverride（如收藏 API/指定 ID），直接使用；
   * - 否则优先沿用“被重生成目标 AI 消息”的原始 API；
   * - 若目标未记录 API，再回退到 prompt 设置中的 model 偏好；仍未命中则 follow_current。
   *
   * @param {Object|null} regenTarget
   * @param {any} [apiOverride=null]
   * @returns {any}
   */
  function resolveRegenerateApiParam(regenTarget, apiOverride = null) {
    if (apiOverride != null) return apiOverride;
    const configMap = resolveRegenerateTargetApiConfigMap(regenTarget);
    const targetIds = getRegenerateTargetAiIds(regenTarget);
    for (let i = 0; i < targetIds.length; i += 1) {
      const config = configMap.get(targetIds[i]);
      if (config) return config;
    }
    const originalMessageText = (typeof regenTarget?.originalMessageText === 'string')
      ? regenTarget.originalMessageText
      : '';
    return resolvePromptPreferredApiParam(originalMessageText);
  }

  /**
   * 获取“重新生成”默认将使用的 API 配置，用于右键菜单小字提示。
   * 说明：这里与发送逻辑保持一致——只有当 apiParam 能解析到明确配置时才覆盖。
   *
   * @param {Object|null} regenTarget
   * @returns {Object|null}
   */
  function resolveRegenerateDisplayConfig(regenTarget) {
    const apiParam = resolveRegenerateApiParam(regenTarget, null);
    let overrideConfig = null;
    if (apiParam != null && typeof apiManager?.resolveApiParam === 'function') {
      if (typeof apiParam === 'string' && (apiParam === 'follow_current' || apiParam === 'selected')) {
        overrideConfig = null;
      } else {
        overrideConfig = apiManager.resolveApiParam(apiParam) || null;
      }
    }
    const apiContext = (typeof chatHistoryUI?.resolveActiveConversationApiConfig === 'function')
      ? chatHistoryUI.resolveActiveConversationApiConfig()
      : null;
    const displayConfig = apiContext?.displayConfig || apiManager?.getSelectedConfig?.() || null;
    return overrideConfig || displayConfig;
  }

  function buildRegenerateApiHintLabel(regenTarget) {
    const targetIds = getRegenerateTargetAiIds(regenTarget);
    const shouldShowCombo = regenTarget?.sourceRole === 'user' && targetIds.length > 1;
    if (shouldShowCombo) {
      const configMap = resolveRegenerateTargetApiConfigMap(regenTarget);
      const grouped = [];
      const groupedIndex = new Map();
      targetIds.forEach((targetId) => {
        const config = configMap.get(targetId);
        if (!config) return;
        const key = (typeof config.id === 'string' && config.id)
          ? config.id
          : `${config.baseUrl || ''}::${config.modelName || ''}::${config.displayName || ''}`;
        if (groupedIndex.has(key)) {
          const index = groupedIndex.get(key);
          grouped[index].count += 1;
          return;
        }
        groupedIndex.set(key, grouped.length);
        grouped.push({ config, count: 1 });
      });

      if (grouped.length > 0) {
        return grouped
          .map(item => `${getApiDisplayName(item.config)}${item.count > 1 ? ` x${item.count}` : ''}`)
          .join(' + ');
      }
    }

    const config = resolveRegenerateDisplayConfig(regenTarget);
    return getApiDisplayName(config);
  }

  function updateRegenerateApiHint(regenTarget) {
    if (!regenerateApiHint) return;
    const label = buildRegenerateApiHintLabel(regenTarget);
    regenerateApiHint.textContent = label;
    regenerateApiHint.title = label;
  }

  function buildApiParamFromSubmenuItem(item) {
    if (!item) return null;
    const apiId = item.dataset.apiId;
    if (apiId) return { id: apiId };
    const favoriteIndex = Number(item.dataset.favoriteIndex);
    if (!Number.isNaN(favoriteIndex)) return { favoriteIndex };
    return null;
  }

  function renderRegenerateSubmenu() {
    if (!regenerateSubmenuList) return;
    regenerateSubmenuList.innerHTML = '';
    const favorites = getFavoriteApiConfigs();
    if (!favorites.length) {
      const emptyItem = document.createElement('div');
      emptyItem.className = 'context-menu-submenu-item is-disabled';
      emptyItem.textContent = '暂无收藏 API';
      emptyItem.dataset.disabled = 'true';
      regenerateSubmenuList.appendChild(emptyItem);
      return;
    }
    favorites.forEach((config, index) => {
      const item = document.createElement('div');
      item.className = 'context-menu-submenu-item';
      item.textContent = getFavoriteApiLabel(config, index);
      if (config?.id) item.dataset.apiId = config.id;
      item.dataset.favoriteIndex = String(index);
      regenerateSubmenuList.appendChild(item);
    });
  }

  function updateSubmenuDirection(menuItem, submenu) {
    if (!menuItem || !submenu) return;
    menuItem.classList.remove('context-menu-item--submenu-left');
    const buttonRect = menuItem.getBoundingClientRect();
    const submenuWidth = submenu.offsetWidth || 180;
    const spaceRight = window.innerWidth - buttonRect.right;
    const spaceLeft = buttonRect.left;
    if (spaceRight < submenuWidth && spaceLeft >= submenuWidth) {
      menuItem.classList.add('context-menu-item--submenu-left');
    }
  }

  /**
   * 显示上下文菜单
   * @param {MouseEvent} e - 鼠标事件
   * @param {HTMLElement} messageElement - 消息元素
   */
  function showContextMenu(e, messageElement) {
    e.preventDefault();
    currentMessageElement = messageElement;
    currentMessageContainer = resolveMessageContainer(messageElement);
    const activeContainer = currentMessageContainer || chatContainer;

    // 设置菜单位置
    contextMenu.style.display = 'block';

    // 获取点击的代码块元素
    const codeBlock = e.target.closest('pre code');

    // 根据消息状态显示或隐藏停止更新按钮
    // 除了当前消息为 updating 外，只要有任意 AI 消息处于 updating（包括“正在等待回复”的占位消息），也显示“停止更新”
    const hasUpdating = (container) => !!container?.querySelector?.('.ai-message.updating, .loading-message.updating');
    const anyUpdating = hasUpdating(chatContainer) || hasUpdating(threadContainer);
    if (messageElement.classList.contains('updating') || anyUpdating) {
      stopUpdateButton.style.display = 'flex';
    } else {
      stopUpdateButton.style.display = 'none';
    }
    // 每次打开菜单时刷新 click 处理，保证调用最新的 messageSender.abortCurrentRequest()
    stopUpdateButton.onclick = () => {
      if (messageSender) messageSender.abortCurrentRequest(currentMessageElement || messageElement);
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

    // “重新生成”支持任意消息：根据当前消息解析目标是否可重生成
    const regenTarget = resolveRegenerateTarget(messageElement);
    regenerateButton.style.display = regenTarget ? 'flex' : 'none';
    if (regenTarget) {
      renderRegenerateSubmenu();
      updateSubmenuDirection(regenerateButton, regenerateSubmenu);
      updateRegenerateApiHint(regenTarget);
    } else {
      regenerateButton.classList.remove('context-menu-item--submenu-left');
      if (regenerateApiHint) {
        regenerateApiHint.textContent = '';
        regenerateApiHint.removeAttribute('title');
      }
    }

    if (lockApiFromMessageButton) {
      const apiConfig = resolveApiConfigFromMessage(messageElement);
      if (apiConfig) {
        const label = getApiDisplayName(apiConfig);
        lockApiFromMessageButton.style.display = 'flex';
        lockApiFromMessageButton.title = `固定该对话到：${label}`;
      } else {
        lockApiFromMessageButton.style.display = 'none';
        lockApiFromMessageButton.removeAttribute('title');
      }
    }

    // “在此处插入”仅对有 messageId 的正式消息生效
    const canShowInsertOptions = !!(
      messageElement &&
      messageElement.getAttribute('data-message-id') &&
      !messageElement.classList.contains('loading-message')
    );
    if (insertMessageMenu) {
      insertMessageMenu.style.display = canShowInsertOptions ? 'flex' : 'none';
      if (canShowInsertOptions) {
        updateSubmenuDirection(insertMessageMenu, insertMessageSubmenu);
      } else {
        insertMessageMenu.classList.remove('context-menu-item--submenu-left');
      }
    }
    // 始终显示创建分支对话按钮，但只有在有足够消息时才可用
    if (forkConversationButton) {
      if (activeContainer === threadContainer) {
        const selectionThreadManager = services.selectionThreadManager;
        const messageId = messageElement?.getAttribute?.('data-message-id') || '';
        const canForkThread = !!(
          messageId
          && !messageElement?.classList?.contains?.('loading-message')
          && selectionThreadManager?.isThreadModeActive?.()
        );
        forkConversationButton.style.display = 'flex';
        if (canForkThread) {
          forkConversationButton.classList.remove('disabled');
        } else {
          forkConversationButton.classList.add('disabled');
        }
      } else {
        const messageCount = activeContainer ? activeContainer.querySelectorAll('.message').length : 0;
        if (messageCount > 1) {
          forkConversationButton.style.display = 'flex';
          forkConversationButton.classList.remove('disabled');
        } else {
          forkConversationButton.style.display = 'flex';
          forkConversationButton.classList.add('disabled');
        }
      }
    }
  }

  /**
   * 隐藏上下文菜单
   */
  function hideContextMenu() {
    contextMenu.style.display = 'none';
    currentMessageElement = null;
    currentMessageContainer = null;
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
  async function regenerateMessage(targetMessageElement = null, apiOverride = null) {
    // 注意：该函数既会被按钮 click 事件直接调用（参数是 MouseEvent），
    // 也会被 Ctrl+Enter 场景传入“被编辑的消息元素”。这里统一做一次参数归一化。
    const elementArg = (targetMessageElement && targetMessageElement.nodeType === 1)
      ? targetMessageElement
      : null;
    const baseElement = elementArg || currentMessageElement;
    const regenTarget = resolveRegenerateTarget(baseElement);
    if (!regenTarget) {
      hideContextMenu();
      return;
    }

    const {
      sourceRole,
      userMessageId,
      originalMessageText,
      targetAiMessageId
    } = regenTarget;
    const targetAiMessageIds = getRegenerateTargetAiIds(regenTarget);

    try {
      const shouldRegenerateParallelGroup = apiOverride == null
        && sourceRole === 'user'
        && targetAiMessageIds.length > 1;

      if (shouldRegenerateParallelGroup) {
        const configMap = resolveRegenerateTargetApiConfigMap(regenTarget);
        const fallbackApiParam = resolveRegenerateApiParam(regenTarget, null);
        targetAiMessageIds.forEach((currentAiMessageId) => {
          const apiParam = configMap.get(currentAiMessageId) || fallbackApiParam;
          messageSender.sendMessage({
            originalMessageText,
            regenerateMode: true,
            messageId: userMessageId,
            targetAiMessageId: currentAiMessageId || null,
            api: apiParam
          });
        });
        return;
      }

      const apiParam = resolveRegenerateApiParam(regenTarget, apiOverride);

      // 关键：指定 targetAiMessageId，让发送层“原地替换”目标 AI 消息内容（不删除/不新增其他消息）
      messageSender.sendMessage({
        originalMessageText,
        regenerateMode: true,
        messageId: userMessageId,
        targetAiMessageId: targetAiMessageId || targetAiMessageIds[0] || null,
        api: apiParam
      });
    } catch (err) {
      console.error('准备重新生成消息时出错:', err);
    } finally {
      hideContextMenu();
    }
  }

  /**
   * 在指定消息下方插入一条空白消息。
   *
   * 设计说明：
   * - UI 插入位置以 DOM 为准：插入到基准消息的下方（也就是其后第一条 .message 之前）；
   * - 历史插入以 messageId 为准：使用 chatHistoryManager.insertMessageAfter() 同步维护 parentId/children，
   *   并把新节点插入到 messages 数组的正确位置，保证保存/重载后顺序一致。
   *
   * @param {'ai'|'user'} sender
   * @param {HTMLElement} baseElement
   * @param {{ openEditor?: boolean, skipSave?: boolean }} [options]
   * @returns {Promise<HTMLElement|null>}
   */
  async function insertBlankMessageAfter(sender, baseElement, options = {}) {
    let newMessageDiv = null;
    try {
      if (!baseElement) return null;
      const targetContainer = currentMessageContainer || resolveMessageContainer(baseElement) || chatContainer;
      const afterMessageId = baseElement.getAttribute('data-message-id') || '';
      if (!afterMessageId) return null;
      if (!chatHistoryManager || typeof chatHistoryManager.insertMessageAfter !== 'function') {
        console.warn('insertMessageAfter 不存在，无法插入消息');
        return null;
      }
      if (!messageProcessor || typeof messageProcessor.appendMessage !== 'function') {
        console.warn('messageProcessor.appendMessage 不存在，无法插入消息');
        return null;
      }

      // 找到“基准消息下方”的那条消息（如果存在），用于精确插入位置
      const findNextMessageElement = (el) => {
        let next = el ? el.nextElementSibling : null;
        while (next && !(next.classList && next.classList.contains('message'))) {
          next = next.nextElementSibling;
        }
        return next;
      };

      const nextMessageElement = findNextMessageElement(baseElement);
      const nextMessageId = nextMessageElement
        ? (nextMessageElement.getAttribute('data-message-id') || null)
        : null;

      // 1) 先插入到历史结构中（生成新 messageId）
      const role = (sender === 'ai') ? 'assistant' : 'user';
      const newNode = chatHistoryManager.insertMessageAfter(
        afterMessageId,
        role,
        '',
        { nextMessageId }
      );
      if (!newNode || !newNode.id) return null;

      // 2) 构建消息 DOM（跳过历史写入），再移动到目标位置
      newMessageDiv = messageProcessor.appendMessage('', sender, true, null, null, null, null, null, {
        container: targetContainer
      });
      if (!newMessageDiv) return null;
      newMessageDiv.setAttribute('data-message-id', newNode.id);

      // AI 消息：补一个空的 api-footer，保证样式稳定（与普通 AI 消息一致）
      if (sender === 'ai') {
        const footer = newMessageDiv.querySelector('.api-footer');
        if (!footer) {
          const apiFooter = document.createElement('div');
          apiFooter.className = 'api-footer';
          newMessageDiv.appendChild(apiFooter);
        }
      }

      // 将新消息插到“基准消息的下方”
      if (nextMessageElement && nextMessageElement.parentNode === targetContainer) {
        targetContainer.insertBefore(newMessageDiv, nextMessageElement);
      } else {
        // 没有下一条消息：插到末尾（appendMessage 已经 append 到末尾，这里确保位置正确即可）
        if (newMessageDiv.parentNode !== targetContainer) {
          targetContainer.appendChild(newMessageDiv);
        }
      }

      const shouldOpenEditor = options.openEditor === true;
      if (shouldOpenEditor && !isEditing) {
        try { startInlineEdit(newMessageDiv); } catch (e) { console.error('打开新插入消息的编辑器失败:', e); }
      }
      if (!options.skipSave) {
        await chatHistoryUI.saveCurrentConversation(true);
      }
      return newMessageDiv;
    } catch (e) {
      console.error('插入空白消息失败:', e);
      return null;
    }
  }

  /**
   * 在“当前右键选中的消息”下方插入一条空白消息。
   * @param {'ai'|'user'} sender
   */
  async function insertBlankMessageBelow(sender) {
    const baseElement = currentMessageElement;
    try {
      if (!baseElement) return;
      hideContextMenu();
      await insertBlankMessageAfter(sender, baseElement, { openEditor: true });
    } finally {
      hideContextMenu();
    }
  }

  /**
   * 在“当前右键选中的消息”下方依次插入用户消息与 AI 消息，并打开用户消息编辑。
   */
  async function insertCombinedMessagesBelow() {
    let userMessageDiv = null;
    const baseElement = currentMessageElement;
    try {
      if (!baseElement) return;
      hideContextMenu();
      userMessageDiv = await insertBlankMessageAfter('user', baseElement, {
        openEditor: false,
        skipSave: true
      });
      if (!userMessageDiv) return;
      await insertBlankMessageAfter('ai', userMessageDiv, { openEditor: false, skipSave: true });
      if (!isEditing) {
        try { startInlineEdit(userMessageDiv); } catch (e) { console.error('打开新插入用户消息的编辑器失败:', e); }
      }
      await chatHistoryUI.saveCurrentConversation(true);
    } catch (e) {
      console.error('同时插入消息失败:', e);
    } finally {
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
      if (!messageId) {
        console.error('无法创建分支对话: 缺少必要信息');
        hideContextMenu();
        return;
      }

      const activeContainer = resolveMessageContainer(currentMessageElement);
      if (activeContainer === threadContainer) {
        const selectionThreadManager = services.selectionThreadManager;
        if (!selectionThreadManager?.forkThreadFromMessage) {
          console.error('无法创建分支线程: selectionThreadManager 未就绪');
          hideContextMenu();
          return;
        }
        const task = selectionThreadManager.forkThreadFromMessage(messageId);
        if (task?.catch) {
          task.catch((error) => {
            console.error('创建分支线程失败:', error);
          });
        }
        hideContextMenu();
        return;
      }

      if (!chatHistory || !chatHistory.messages) {
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
          // 需求：右键“复制为图片”时隐藏思考内容块，避免截图包含该区域。
          filter: (node) => {
            if (!(node instanceof Element)) return true;
            if (node.classList?.contains('thoughts-content')) return false;
            // 兼容：有些节点可能是 thoughts-content 的子孙节点
            if (typeof node.closest === 'function' && node.closest('.thoughts-content')) return false;
            return true;
          }
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
    const attachContextMenuListeners = (container) => {
      if (!container) return;
      // 监听消息（用户或 AI）右键点击
      container.addEventListener('contextmenu', (e) => {
        // 检查是否有文本被选中
        const selectedText = window.getSelection().toString();
        
        // 说明：
        // - 有选中文本时，优先保留浏览器默认菜单（复制/查找等）；
        // - Ctrl/Alt 作为“强制默认菜单”的快捷方式。
        if (selectedText || e.ctrlKey || e.altKey) {
          return;
        }
        
        // 允许用户和 AI 消息都触发右键菜单
        const messageElement = e.target.closest('.message');
        if (messageElement && container.contains(messageElement)) {
          e.preventDefault();
          showContextMenu(e, messageElement);
        }
      });

      // 滚动时隐藏菜单
      container.addEventListener('scroll', hideContextMenu);
    };

    attachContextMenuListeners(chatContainer);
    attachContextMenuListeners(threadContainer);

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
      if (messageSender) messageSender.abortCurrentRequest(currentMessageElement);
      hideContextMenu();
    });
    deleteMessageButton.addEventListener('click', () => {
      if (currentMessageElement) {
        utils.deleteMessageContent(currentMessageElement);
      } else {
        console.error('消息元素未找到。');
      }
    });
    regenerateButton.addEventListener('click', (event) => {
      const target = event?.target instanceof Element ? event.target : null;
      if (target && target.closest('.context-menu-submenu')) return;
      regenerateMessage(event);
    });
    if (lockApiFromMessageButton) {
      lockApiFromMessageButton.addEventListener('click', async () => {
        const apiConfig = resolveApiConfigFromMessage(currentMessageElement);
        if (!apiConfig) {
          utils?.showNotification?.({ message: '该消息未记录可用的 API 信息', type: 'warning', duration: 1800 });
          hideContextMenu();
          return;
        }
        await chatHistoryUI?.setConversationApiLock?.(null, apiConfig);
        hideContextMenu();
      });
    }
    if (regenerateSubmenuList) {
      regenerateSubmenuList.addEventListener('click', (event) => {
        const target = event?.target instanceof Element ? event.target : null;
        const item = target ? target.closest('.context-menu-submenu-item') : null;
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        if (item.dataset.disabled === 'true') return;
        const apiParam = buildApiParamFromSubmenuItem(item);
        if (!apiParam) return;
        regenerateMessage(null, apiParam);
      });
    }

    if (insertMessageSubmenuList) {
      insertMessageSubmenuList.addEventListener('click', (event) => {
        const target = event?.target instanceof Element ? event.target : null;
        const item = target ? target.closest('.context-menu-submenu-item') : null;
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        const insertType = item.dataset.insertType;
        if (insertType === 'both') {
          insertCombinedMessagesBelow();
          return;
        }
        if (insertType === 'user') {
          insertBlankMessageBelow('user');
          return;
        }
        if (insertType === 'ai') {
          insertBlankMessageBelow('ai');
        }
      });
    }
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
        const container = resolveMessageContainer(messageElement);
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
    // 宽度：以原消息宽度为基准，额外增加 2em，并设置最小宽度 10em，上限 100%
    textarea.style.minWidth = '10em';
    if (baseWidth > 0) {
      textarea.style.width = `calc(${baseWidth}px + 2em)`;
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
          // Ctrl+Enter：
          // - 编辑用户消息：重生成其后的第一条 AI 消息；
          // - 编辑 AI 消息：重生成该条 AI 消息本身。
          await regenerateMessage(messageElement);
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
          // AI 消息：使用与初始渲染相同的 Markdown + 数学渲染管线（包含 $/$ 过滤逻辑）
          const processed = appContext.services.messageProcessor.processMathAndMarkdown(newText);
          textDiv.innerHTML = processed;
          // 复用 appendMessage 中的后处理逻辑：链接与代码高亮
          appContext.services.messageProcessor.decorateMarkdownLinks?.(textDiv);
          textDiv
            .querySelectorAll('pre code')
            .forEach(block => {
              try { hljs.highlightElement(block); } catch (_) {}
            });
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
