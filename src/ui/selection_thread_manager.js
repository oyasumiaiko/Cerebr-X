import { normalizeStoredMessageContent, splitStoredMessageContent } from '../utils/message_content.js';

/**
 * 划词线程管理器
 *
 * 负责：
 * - 侧栏消息的划词识别与线程元数据管理
 * - 线程高亮渲染与预览气泡
 * - 线程模式的进入/退出状态管理（具体布局与发送在上层接入）
 */

export function createSelectionThreadManager(appContext) {
  const { dom, services, utils } = appContext;
  const chatContainer = dom.chatContainer;
  const chatLayout = dom.chatLayout;
  const threadPanel = dom.threadPanel;
  const threadContainer = dom.threadContainer;
  const chatHistoryManager = services.chatHistoryManager;
  const chatHistoryUI = services.chatHistoryUI;
  const messageProcessor = services.messageProcessor;
  const messageSender = services.messageSender;
  const promptSettingsManager = services.promptSettingsManager;
  const imageHandler = services.imageHandler;
  const apiManager = services.apiManager;
  const showNotification = utils?.showNotification;

  const state = {
    activeThreadId: null,
    activeAnchorMessageId: null,
    activeSelectionText: '',
    pendingSelection: null,
    bubblePinned: false,
    bubbleType: 'hidden',
    bubbleHovered: false,
    highlightHovered: false,
    bubbleHideTimer: null,
    bubbleHideAnimationTimer: null,
    bubbleClickHandler: null,
    bubbleActionHandlers: new Map()
  };

  const threadPanelHome = {
    parent: threadPanel?.parentNode || null,
    nextSibling: threadPanel?.nextSibling || null
  };

  let layoutObserver = null;

  let bubbleEl = null;
  let bubbleHeaderEl = null;
  let bubbleTitleEl = null;
  let bubbleContentEl = null;
  let bubbleContentTextEl = null;
  let bubbleContentIconEl = null;

  let threadBannerEl = null;
  let threadBannerTextEl = null;

  function ensureBubble() {
    if (bubbleEl) return;
    bubbleEl = document.createElement('div');
    bubbleEl.className = 'selection-thread-bubble';
    bubbleEl.style.display = 'none';

    bubbleHeaderEl = document.createElement('div');
    bubbleHeaderEl.className = 'selection-thread-bubble__header';

    bubbleTitleEl = document.createElement('div');
    bubbleTitleEl.className = 'selection-thread-bubble__title';
    bubbleHeaderEl.appendChild(bubbleTitleEl);

    bubbleContentEl = document.createElement('div');
    bubbleContentEl.className = 'selection-thread-bubble__content';
    bubbleContentTextEl = document.createElement('div');
    bubbleContentTextEl.className = 'selection-thread-bubble__content-text';
    bubbleContentIconEl = document.createElement('div');
    bubbleContentIconEl.className = 'selection-thread-bubble__content-icon';
    bubbleContentEl.appendChild(bubbleContentTextEl);
    bubbleContentEl.appendChild(bubbleContentIconEl);

    bubbleEl.appendChild(bubbleHeaderEl);
    bubbleEl.appendChild(bubbleContentEl);
    bubbleEl.addEventListener('mouseenter', handleBubbleMouseEnter);
    bubbleEl.addEventListener('mouseleave', handleBubbleMouseLeave);
    bubbleEl.addEventListener('click', handleBubbleClick, true);
    const host = chatContainer || document.body;
    // 气泡挂在聊天滚动容器内，确保随消息滚动而移动，同时不打断“最后一条消息”的底部间距。
    if (host.firstChild) {
      host.insertBefore(bubbleEl, host.firstChild);
    } else {
      host.appendChild(bubbleEl);
    }
  }

  function handleBubbleMouseEnter() {
    state.bubbleHovered = true;
    clearBubbleHideTimer();
  }

  function handleBubbleMouseLeave() {
    state.bubbleHovered = false;
    scheduleBubbleHide();
  }

  function handleBubbleClick(event) {
    if (event && bubbleEl) {
      const actionButton = event.target?.closest?.('.selection-thread-bubble__icon-button');
      const actionId = actionButton?.dataset?.actionId || '';
      if (actionId && state.bubbleActionHandlers?.has(actionId)) {
        event.preventDefault();
        event.stopPropagation();
        const handler = state.bubbleActionHandlers.get(actionId);
        if (typeof handler === 'function') {
          handler();
        }
        return;
      }
    }
    if (typeof state.bubbleClickHandler !== 'function') return;
    event.preventDefault();
    event.stopPropagation();
    state.bubbleClickHandler();
  }

  function clearBubbleHideTimer() {
    if (!state.bubbleHideTimer) return;
    clearTimeout(state.bubbleHideTimer);
    state.bubbleHideTimer = null;
  }

  function clearBubbleHideAnimationTimer() {
    if (!state.bubbleHideAnimationTimer) return;
    clearTimeout(state.bubbleHideAnimationTimer);
    state.bubbleHideAnimationTimer = null;
  }

  function scheduleBubbleHide(delay = 220) {
    if (!bubbleEl || bubbleEl.style.display === 'none') return;
    if (state.bubblePinned) return;
    clearBubbleHideTimer();
    // 鼠标从高亮移动到气泡会经过空白区域，留出缓冲时间避免误关闭预览。
    state.bubbleHideTimer = window.setTimeout(() => {
      if (state.bubblePinned || state.bubbleHovered || state.highlightHovered) return;
      hideBubble();
    }, delay);
  }

  function showBubbleAtRect(rect, options = {}) {
    ensureBubble();
    if (!bubbleEl) return;

    const {
      title = '',
      content = '',
      contentHtml = '',
      contentItems = null,
      iconClass = '',
      iconButtons = null,
      onClick = null,
      onItemClick = null,
      pinned = false,
      type = 'preview',
      variant = ''
    } = options;

    bubbleTitleEl.textContent = title;
    bubbleTitleEl.style.display = title ? 'block' : 'none';
    const hasItems = Array.isArray(contentItems) && contentItems.length > 0;
    const hasContent = hasItems || !!contentHtml || !!content;
    if (hasItems) {
      bubbleContentTextEl.innerHTML = '';
      const list = document.createElement('div');
      list.className = 'selection-thread-bubble__preview-list';
      contentItems.forEach((item) => {
        const itemId = item?.messageId || item?.threadId || '';
        if (!item || !itemId) return;
        const entry = document.createElement('div');
        entry.className = 'selection-thread-bubble__preview-item';
        if (item.messageId) {
          entry.dataset.messageId = item.messageId;
        }
        if (item.threadId) {
          entry.dataset.threadId = item.threadId;
        }
        entry.setAttribute('role', 'button');
        entry.setAttribute('tabindex', '0');
        if (item.role === 'user') {
          entry.classList.add('selection-thread-bubble__preview-item--user');
        } else if (item.role === 'assistant') {
          entry.classList.add('selection-thread-bubble__preview-item--assistant');
        } else if (item.role) {
          entry.classList.add('selection-thread-bubble__preview-item--system');
        }
        if (item.variant) {
          entry.classList.add(`selection-thread-bubble__preview-item--${item.variant}`);
        }

        const contentBox = document.createElement('div');
        contentBox.className = 'selection-thread-bubble__preview-content';
        renderPreviewMarkdownToElement(contentBox, item.text || '');

        entry.appendChild(contentBox);
        entry.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof onItemClick === 'function') {
            onItemClick(item);
          }
        });
        entry.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          if (typeof onItemClick === 'function') {
            onItemClick(item);
          }
        });
        list.appendChild(entry);
      });
      bubbleContentTextEl.appendChild(list);
      bubbleContentTextEl.style.display = 'block';
    } else if (contentHtml) {
      bubbleContentTextEl.innerHTML = contentHtml;
      bubbleContentTextEl.style.display = hasContent ? 'block' : 'none';
    } else {
      bubbleContentTextEl.textContent = content;
      bubbleContentTextEl.style.display = hasContent ? 'block' : 'none';
    }

    state.bubbleActionHandlers?.clear?.();
    if (Array.isArray(iconButtons) && iconButtons.length) {
      bubbleContentIconEl.innerHTML = '';
      iconButtons.forEach((button, index) => {
        if (!button || !button.iconClass) return;
        const iconButton = document.createElement('button');
        iconButton.type = 'button';
        iconButton.className = `selection-thread-bubble__icon-button${button.className ? ` ${button.className}` : ''}`;
        if (button.title) iconButton.title = button.title;
        const actionId = `bubble_action_${Date.now()}_${index}`;
        iconButton.dataset.actionId = actionId;
        if (typeof button.onClick === 'function') {
          state.bubbleActionHandlers.set(actionId, button.onClick);
        }
        if (button.disabled) {
          iconButton.disabled = true;
          iconButton.classList.add('is-disabled');
        }
        const icon = document.createElement('i');
        icon.className = button.iconClass;
        iconButton.appendChild(icon);
        bubbleContentIconEl.appendChild(iconButton);
      });
      if (iconClass) {
        const icon = document.createElement('i');
        icon.className = `${iconClass} selection-thread-bubble__icon-static`;
        bubbleContentIconEl.appendChild(icon);
      }
      bubbleContentIconEl.style.display = bubbleContentIconEl.childElementCount ? 'flex' : 'none';
      bubbleContentEl.classList.toggle(
        'selection-thread-bubble__content--icon',
        bubbleContentIconEl.childElementCount > 0
      );
    } else if (iconClass) {
      bubbleContentIconEl.innerHTML = '';
      const icon = document.createElement('i');
      icon.className = iconClass;
      bubbleContentIconEl.appendChild(icon);
      bubbleContentIconEl.style.display = 'flex';
      bubbleContentEl.classList.add('selection-thread-bubble__content--icon');
    } else {
      bubbleContentIconEl.innerHTML = '';
      bubbleContentIconEl.style.display = 'none';
      bubbleContentEl.classList.remove('selection-thread-bubble__content--icon');
    }

    bubbleContentEl.style.display = hasContent ? '' : 'none';
    bubbleHeaderEl.style.display = title ? 'flex' : 'none';

    state.bubbleClickHandler = typeof onClick === 'function' ? onClick : null;
    bubbleEl.classList.toggle('selection-thread-bubble--action', !!state.bubbleClickHandler);
    if (variant) {
      bubbleEl.dataset.variant = variant;
    } else {
      delete bubbleEl.dataset.variant;
    }
    if (state.bubbleClickHandler) {
      bubbleEl.setAttribute('role', 'button');
      bubbleEl.setAttribute('tabindex', '0');
    } else {
      bubbleEl.removeAttribute('role');
      bubbleEl.removeAttribute('tabindex');
    }

    bubbleEl.style.display = 'block';
    bubbleEl.dataset.visible = 'true';
    bubbleEl.dataset.type = type;
    clearBubbleHideAnimationTimer();
    bubbleEl.classList.remove('selection-thread-bubble--hiding');
    bubbleEl.classList.remove('selection-thread-bubble--visible');
    if (type === 'preview') {
      applyPreviewBubbleWidth();
    } else {
      bubbleEl.style.width = '';
      bubbleEl.style.maxWidth = '';
    }
    state.bubblePinned = !!pinned;
    state.bubbleType = type;
    state.bubbleHovered = false;
    clearBubbleHideTimer();

    positionBubble(rect);
    window.requestAnimationFrame(() => {
      if (!bubbleEl || bubbleEl.style.display === 'none') return;
      bubbleEl.classList.add('selection-thread-bubble--visible');
    });
  }

  function applyPreviewBubbleWidth() {
    if (!bubbleEl) return;
    const host = chatContainer;
    if (!host) {
      bubbleEl.style.width = '';
      bubbleEl.style.maxWidth = '';
      return;
    }
    const style = window.getComputedStyle(host);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const contentWidth = host.clientWidth - paddingLeft - paddingRight;
    if (!Number.isFinite(contentWidth) || contentWidth <= 0) {
      bubbleEl.style.width = '';
      bubbleEl.style.maxWidth = '';
      return;
    }
    const targetWidth = Math.round(contentWidth * 0.7);
    bubbleEl.style.width = `${targetWidth}px`;
    bubbleEl.style.maxWidth = `${targetWidth}px`;
  }

  function positionBubble(rect) {
    if (!bubbleEl || !rect) return;
    const padding = 12;
    // 说明：把 viewport 坐标换算为滚动容器的内容坐标（包含 scrollTop/Left），
    // 这样气泡定位随内容滚动，不再“固定在屏幕上”。
    const host = chatContainer || document.body;
    const hostRect = host.getBoundingClientRect ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const scrollLeft = Number.isFinite(host.scrollLeft) ? host.scrollLeft : 0;
    const scrollTop = Number.isFinite(host.scrollTop) ? host.scrollTop : 0;
    const hostWidth = Number.isFinite(host.clientWidth) ? host.clientWidth : window.innerWidth;
    const hostHeight = Number.isFinite(host.clientHeight) ? host.clientHeight : window.innerHeight;

    const bubbleRect = bubbleEl.getBoundingClientRect();
    const anchorCenterX = rect.left - hostRect.left + scrollLeft + rect.width / 2;
    const anchorTop = rect.top - hostRect.top + scrollTop;
    const anchorBottom = rect.bottom - hostRect.top + scrollTop;
    let left = anchorCenterX - bubbleRect.width / 2;
    let top = anchorTop - bubbleRect.height - 10;
    let placement = 'top';

    const visibleTop = scrollTop + padding;
    const visibleBottom = scrollTop + hostHeight - padding;
    if (top < visibleTop) {
      top = anchorBottom + 10;
      placement = 'bottom';
    }

    const minLeft = scrollLeft + padding;
    const maxLeft = scrollLeft + hostWidth - bubbleRect.width - padding;
    if (Number.isFinite(minLeft) && Number.isFinite(maxLeft)) {
      left = Math.max(minLeft, Math.min(left, maxLeft));
    }

    bubbleEl.style.left = `${Math.round(left)}px`;
    bubbleEl.style.top = `${Math.round(top)}px`;
    bubbleEl.dataset.placement = placement;
  }

  function hideBubble(force = false) {
    if (!bubbleEl) return;
    if (!force && state.bubblePinned) return;
    clearBubbleHideTimer();
    clearBubbleHideAnimationTimer();
    bubbleEl.dataset.visible = 'false';
    bubbleEl.classList.remove('selection-thread-bubble--visible');
    bubbleEl.classList.add('selection-thread-bubble--hiding');
    bubbleEl.classList.remove('selection-thread-bubble--action');
    state.bubblePinned = false;
    state.bubbleType = 'hidden';
    state.bubbleHovered = false;
    state.highlightHovered = false;
    state.bubbleClickHandler = null;
    state.bubbleActionHandlers?.clear?.();
    const hideDelay = 120;
    state.bubbleHideAnimationTimer = window.setTimeout(() => {
      if (!bubbleEl) return;
      bubbleEl.style.display = 'none';
      bubbleEl.classList.remove('selection-thread-bubble--hiding');
      delete bubbleEl.dataset.variant;
      delete bubbleEl.dataset.placement;
      state.bubbleHideAnimationTimer = null;
    }, hideDelay);
  }

  function isFullscreenLayout() {
    return !!document.documentElement?.classList?.contains('fullscreen-mode');
  }

  function updateThreadPanelTitle(selectionText) {
    const safeText = typeof selectionText === 'string' ? selectionText.trim() : '';
    if (threadBannerTextEl) {
      threadBannerTextEl.textContent = safeText;
    }
    if (threadBannerEl) {
      threadBannerEl.title = safeText || '';
    }
  }

  function resetHiddenMessages() {
    if (!chatContainer) return;
    chatContainer.querySelectorAll('.thread-hidden-message').forEach((node) => {
      node.classList.remove('thread-hidden-message');
    });
  }

  function hideMessagesAfterAnchor(anchorElement) {
    if (!chatContainer || !anchorElement) return;
    let hideFollowing = false;
    const messages = chatContainer.querySelectorAll('.message');
    messages.forEach((message) => {
      if (message === anchorElement) {
        hideFollowing = true;
        return;
      }
      if (hideFollowing) {
        message.classList.add('thread-hidden-message');
      } else {
        message.classList.remove('thread-hidden-message');
      }
    });
  }

  function moveThreadPanelHome() {
    if (!threadPanel) return;
    threadPanel.classList.remove('thread-panel-inline');
    threadPanel.setAttribute('aria-hidden', 'false');
    const parent = threadPanelHome.parent || chatLayout;
    if (!parent) return;
    if (threadPanelHome.nextSibling && threadPanelHome.nextSibling.parentNode === parent) {
      parent.insertBefore(threadPanel, threadPanelHome.nextSibling);
    } else {
      parent.appendChild(threadPanel);
    }
  }

  function moveThreadPanelInline(anchorElement) {
    if (!threadPanel || !chatContainer || !anchorElement) return;
    threadPanel.classList.add('thread-panel-inline');
    threadPanel.setAttribute('aria-hidden', 'false');
    if (anchorElement.nextSibling) {
      chatContainer.insertBefore(threadPanel, anchorElement.nextSibling);
    } else {
      chatContainer.appendChild(threadPanel);
    }
  }

  function applyThreadLayout() {
    // 线程模式布局策略：
    // - 全屏：线程面板固定在右侧，不隐藏主消息；
    // - 侧栏：线程面板插入锚点之后，并隐藏锚点之后的主消息。
    if (!threadPanel) return;
    const anchorNode = state.activeAnchorMessageId
      ? chatHistoryManager?.chatHistory?.messages?.find(m => m.id === state.activeAnchorMessageId)
      : null;
    const anchorElement = anchorNode ? getMessageElementFromNode(anchorNode) : null;

    if (isFullscreenLayout()) {
      resetHiddenMessages();
      moveThreadPanelHome();
      return;
    }

    if (anchorElement) {
      hideMessagesAfterAnchor(anchorElement);
      moveThreadPanelInline(anchorElement);
    } else {
      resetHiddenMessages();
      moveThreadPanelHome();
    }
  }

  function normalizePath(value) {
    return (value || '').replace(/\\/g, '/');
  }

  async function loadDownloadRoot() {
    if (loadDownloadRoot.cached) return loadDownloadRoot.cached;
    try {
      if (!chrome?.storage?.local?.get) return null;
      const res = await chrome.storage.local.get(['image_download_root']);
      const root = res?.image_download_root;
      if (root && typeof root === 'string') {
        loadDownloadRoot.cached = normalizePath(root).replace(/\/+$/, '') + '/';
        return loadDownloadRoot.cached;
      }
    } catch (_) {}
    return null;
  }

  function buildFileUrlFromRelative(relPath, rootPath) {
    if (!relPath) return null;
    const root = normalizePath(rootPath || '');
    const rel = normalizePath(relPath).replace(/^\/+/, '');
    if (!root) return rel;
    const full = `${root}${rel}`;
    let normalized = normalizePath(full);
    if (/^[A-Za-z]:\//.test(normalized)) {
      normalized = '/' + normalized;
    } else if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return `file://${normalized}`;
  }

  async function resolveImageUrlForDisplay(imageUrlObj) {
    if (!imageUrlObj) return '';
    const rawUrl = imageUrlObj.url;
    const relPath = imageUrlObj.path || (rawUrl && !rawUrl.startsWith('file://') ? rawUrl : null);
    if (typeof rawUrl === 'string' && rawUrl.startsWith('file://')) return rawUrl;
    if (relPath) {
      const root = await loadDownloadRoot();
      const fileUrl = root ? buildFileUrlFromRelative(relPath, root) : null;
      return fileUrl || relPath;
    }
    return rawUrl || '';
  }

  function extractInlineImgSrcs(html) {
    const set = new Set();
    if (typeof html !== 'string' || !html.includes('<img')) return set;
    const re = /<img\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/gi;
    let m = null;
    while ((m = re.exec(html)) !== null) {
      const src = m[2] || '';
      if (src) set.add(src);
    }
    return set;
  }

  function renderApiFooterForNode(messageElem, node) {
    if (!messageElem || !node || node.role !== 'assistant') return;
    const footer = messageElem.querySelector('.api-footer') || (() => {
      const f = document.createElement('div');
      f.className = 'api-footer';
      messageElem.appendChild(f);
      return f;
    })();

    const allConfigs = apiManager?.getAllConfigs?.() || [];
    let label = '';
    let matchedConfig = null;
    if (node.apiUuid) {
      matchedConfig = allConfigs.find(c => c.id === node.apiUuid) || null;
    }
    if (!label && matchedConfig && typeof matchedConfig.displayName === 'string' && matchedConfig.displayName.trim()) {
      label = matchedConfig.displayName.trim();
    }
    if (!label && matchedConfig && typeof matchedConfig.modelName === 'string' && matchedConfig.modelName.trim()) {
      label = matchedConfig.modelName.trim();
    }
    if (!label) label = (node.apiDisplayName || '').trim();
    if (!label) label = (node.apiModelId || '').trim();

    const hasThoughtSignature = !!node.thoughtSignature;
    let displayLabel = label || '';
    if (hasThoughtSignature) {
      displayLabel = label ? `signatured · ${label}` : 'signatured';
    }
    footer.textContent = displayLabel;

    const titleDisplayName = matchedConfig?.displayName || node.apiDisplayName || '-';
    const titleModelId = matchedConfig?.modelName || node.apiModelId || '-';
    const thoughtFlag = hasThoughtSignature ? ' | thought_signature: stored' : '';
    footer.title = `API uuid: ${node.apiUuid || '-'} | displayName: ${titleDisplayName} | model: ${titleModelId}${thoughtFlag}`;
  }

  function collectThreadChain(annotation) {
    // 通过 parentId 从最后一条回溯到 root，保证线程消息顺序可控
    if (!annotation?.rootMessageId) return [];
    const rootId = annotation.rootMessageId;
    const lastId = annotation.lastMessageId || rootId;
    const chain = [];
    let currentId = lastId;

    while (currentId) {
      const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === currentId);
      if (!node) break;
      chain.unshift(node);
      if (currentId === rootId) break;
      currentId = node.parentId;
    }

    if (chain.length && chain[0].id !== rootId) {
      const rootNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === rootId);
      if (rootNode) chain.unshift(rootNode);
    }
    return chain;
  }

  function stripHtmlToText(html) {
    if (typeof html !== 'string' || !html) return '';
    const container = document.createElement('div');
    container.innerHTML = html;
    return (container.textContent || '').trim();
  }

  function summarizePreviewText(text, maxLength = 80) {
    const safe = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
    if (!safe) return '';
    if (safe.length <= maxLength) return safe;
    return `${safe.slice(0, maxLength)}…`;
  }

  function renderPreviewMarkdownToElement(target, text) {
    if (!target) return;
    const content = typeof text === 'string' ? text : '';
    if (messageProcessor?.processMathAndMarkdown) {
      target.innerHTML = messageProcessor.processMathAndMarkdown(content);
    } else {
      target.textContent = content;
    }
  }

  function extractPlainTextFromContent(content) {
    const normalized = normalizeStoredMessageContent(content);
    if (Array.isArray(normalized)) {
      const { text } = splitStoredMessageContent(normalized);
      return summarizePreviewText(stripHtmlToText(text || ''));
    }
    return summarizePreviewText(stripHtmlToText(normalized || ''));
  }

  function getThreadActivityTimestamp(annotation) {
    if (!annotation) return 0;
    const candidateId = annotation.lastMessageId || annotation.rootMessageId || '';
    const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === candidateId);
    if (node && Number.isFinite(node.timestamp)) {
      return node.timestamp;
    }
    return Number(annotation.createdAt || 0) || 0;
  }

  function sortThreadsByActivity(threads) {
    if (!Array.isArray(threads)) return [];
    return threads.slice().sort((a, b) => getThreadActivityTimestamp(b) - getThreadActivityTimestamp(a));
  }

  function buildThreadSummaryItems(threads) {
    if (!Array.isArray(threads) || !threads.length) return [];
    const sorted = sortThreadsByActivity(threads);
    return sorted.map((annotation) => {
      const chain = collectThreadChain(annotation)
        .filter(node => !node?.threadHiddenSelection);
      const count = chain.length;
      let lastUserText = '';
      for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i];
        if (node?.role === 'user') {
          lastUserText = extractPlainTextFromContent(node.content);
          break;
        }
      }
      if (!lastUserText) {
        lastUserText = '(暂无用户提问)';
      }
      return {
        threadId: annotation.id,
        variant: 'thread',
        text: `共 ${count} 条 · ${lastUserText}`
      };
    });
  }

  function buildThreadPreviewLines(threadId, maxItems = 3) {
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return [];
    const chain = collectThreadChain(info.annotation)
      .filter(node => !node?.threadHiddenSelection);
    if (!chain.length) return [];

    const sliced = chain.slice(-Math.max(1, maxItems));
    return sliced.map((node) => {
      const roleLabel = node.role === 'assistant' ? 'AI' : '用户';
      const text = extractPlainTextFromContent(node.content);
      return text ? `${roleLabel}: ${text}` : `${roleLabel}: (空)`;
    });
  }

  function buildThreadPreviewItems(threadId) {
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return [];
    const chain = collectThreadChain(info.annotation)
      .filter(node => !node?.threadHiddenSelection);
    if (!chain.length) return [];

    return chain.map((node) => {
      const normalized = normalizeStoredMessageContent(node.content);
      let text = '';
      if (Array.isArray(normalized)) {
        const { text: extractedText } = splitStoredMessageContent(normalized);
        text = extractedText || '';
      } else {
        text = normalized || '';
      }
      const safeText = typeof text === 'string' ? text : '';
      return {
        messageId: node.id,
        role: node.role || '',
        text: safeText.trim() ? safeText : '(空)'
      };
    });
  }

  function parseThreadIdsFromHighlight(target) {
    if (!target) return [];
    const raw = target.dataset.threadIds || target.dataset.threadId || '';
    return raw.split(',').map(item => item.trim()).filter(Boolean);
  }

  function buildSelectionInfoFromHighlight(target) {
    const selectionText = target?.dataset?.selectionText || target?.textContent || '';
    const matchIndex = Number.isFinite(Number(target?.dataset?.matchIndex))
      ? Number(target.dataset.matchIndex)
      : null;
    const selectionStartOffset = Number.isFinite(Number(target?.dataset?.selectionStartOffset))
      ? Number(target.dataset.selectionStartOffset)
      : null;
    const selectionEndOffset = Number.isFinite(Number(target?.dataset?.selectionEndOffset))
      ? Number(target.dataset.selectionEndOffset)
      : null;
    return {
      selectionText,
      matchIndex,
      selectionStartOffset,
      selectionEndOffset
    };
  }

  function pickPrimaryThread(threads) {
    const sorted = sortThreadsByActivity(threads);
    return sorted[0] || null;
  }

  function renderThreadSelectionBanner(selectionText) {
    if (!threadContainer) return;
    const banner = document.createElement('div');
    banner.className = 'thread-selection-banner';
    banner.title = (selectionText || '').trim();

    const header = document.createElement('div');
    header.className = 'thread-selection-banner__header';

    const label = document.createElement('div');
    label.className = 'thread-selection-banner__label';
    label.textContent = '划词内容';

    const actions = document.createElement('div');
    actions.className = 'thread-selection-banner__actions';

    const confirmButton = document.createElement('button');
    confirmButton.className = 'thread-selection-banner__button thread-selection-banner__button--confirm';
    confirmButton.setAttribute('type', 'button');
    confirmButton.textContent = '确认删除';
    confirmButton.style.display = 'none';

    const deleteButton = document.createElement('button');
    deleteButton.className = 'thread-selection-banner__button thread-selection-banner__button--delete';
    deleteButton.setAttribute('type', 'button');
    deleteButton.textContent = '删除';
    const resetDeleteConfirm = () => {
      confirmButton.style.display = 'none';
      deleteButton.textContent = '删除';
      deleteButton.dataset.confirmArmed = 'false';
    };
    // 两段式确认：先点击“删除”露出左侧确认按钮，再移动鼠标点击确认按钮执行删除。
    deleteButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isArmed = deleteButton.dataset.confirmArmed === 'true';
      if (isArmed) {
        resetDeleteConfirm();
        return;
      }
      deleteButton.dataset.confirmArmed = 'true';
      deleteButton.textContent = '取消';
      confirmButton.style.display = 'inline-flex';
    });

    confirmButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetDeleteConfirm();
      deleteActiveThread();
    });

    const exitButton = document.createElement('button');
    exitButton.className = 'thread-selection-banner__button thread-selection-banner__button--exit';
    exitButton.setAttribute('type', 'button');
    exitButton.textContent = '退出';
    exitButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetDeleteConfirm();
      exitThread();
    });

    actions.appendChild(confirmButton);
    actions.appendChild(deleteButton);
    actions.appendChild(exitButton);

    header.appendChild(label);
    header.appendChild(actions);

    const text = document.createElement('div');
    text.className = 'thread-selection-banner__text';
    text.textContent = (selectionText || '').trim();

    banner.appendChild(header);
    banner.appendChild(text);
    threadContainer.appendChild(banner);

    threadBannerEl = banner;
    threadBannerTextEl = text;
  }

  async function renderThreadMessages(threadId, options = {}) {
    // 将线程链路渲染到线程面板，仅用于展示，不写回历史
    if (!threadContainer || !messageProcessor) return;
    if (state.activeThreadId !== threadId) return;
    const focusMessageId = options?.focusMessageId || '';
    threadContainer.classList.add('thread-container--static');
    threadContainer.innerHTML = '';
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return;

    const chain = collectThreadChain(info.annotation)
      .filter(node => !node?.threadHiddenSelection);
    renderThreadSelectionBanner(info.annotation?.selectionText || '');
    if (!chain.length) return;

    const fragment = document.createDocumentFragment();
    for (const node of chain) {
      if (state.activeThreadId !== threadId) return;
      const role = node.role === 'assistant' ? 'ai' : node.role;
      const normalizedContent = normalizeStoredMessageContent(node.content);
      const thoughtsToDisplay = node.thoughtsRaw || null;
      let messageElem = null;

      if (Array.isArray(normalizedContent)) {
        const { text, images } = splitStoredMessageContent(normalizedContent);
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
          messageElem = messageProcessor.appendMessage(
            combinedContent,
            role,
            true,
            fragment,
            null,
            thoughtsToDisplay,
            null,
            null,
            { container: threadContainer }
          );
        } else {
          const legacyImagesContainer = document.createElement('div');
          uniqueDisplayUrls.forEach((u) => {
            const imageTag = imageHandler?.createImageTag ? imageHandler.createImageTag(u, null) : null;
            if (imageTag) legacyImagesContainer.appendChild(imageTag);
          });
          const imagesHTML = legacyImagesContainer.innerHTML;
          messageElem = messageProcessor.appendMessage(
            combinedContent,
            role,
            true,
            fragment,
            imagesHTML,
            thoughtsToDisplay,
            null,
            null,
            { container: threadContainer }
          );
        }
      } else {
        messageElem = messageProcessor.appendMessage(
          normalizedContent,
          role,
          true,
          fragment,
          null,
          thoughtsToDisplay,
          null,
          null,
          { container: threadContainer }
        );
      }

      if (messageElem) {
        messageElem.classList.remove('batch-load');
        messageElem.classList.add('thread-jump-skip-animation');
        messageElem.setAttribute('data-message-id', node.id);
        renderApiFooterForNode(messageElem, node);
      }
    }

    threadContainer.appendChild(fragment);
    if (focusMessageId) {
      requestAnimationFrame(() => {
        scrollThreadMessageIntoView(focusMessageId);
      });
    }
  }

  function getMessageElementFromNode(node) {
    if (!node) return null;
    const messageId = node.id || '';
    if (!messageId) return null;
    return chatContainer?.querySelector(`[data-message-id="${messageId}"]`) || null;
  }

  function ensureThreadAnnotations(node) {
    if (!node) return [];
    if (!Array.isArray(node.threadAnnotations)) {
      node.threadAnnotations = [];
    }
    return node.threadAnnotations;
  }

  function removeThreadAnnotationFromAnchor(anchorNode, threadId) {
    if (!anchorNode || !threadId) return false;
    if (!Array.isArray(anchorNode.threadAnnotations)) return false;
    const beforeCount = anchorNode.threadAnnotations.length;
    anchorNode.threadAnnotations = anchorNode.threadAnnotations.filter(item => item?.id !== threadId);
    return anchorNode.threadAnnotations.length !== beforeCount;
  }

  function buildThreadId() {
    return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // 过滤 Markdown 预处理插入的零宽字符，避免划词索引与渲染文本错位。
  const ZERO_WIDTH_REGEX = /[\u200B\u200C\u200D\uFEFF]/g;
  const ZERO_WIDTH_CHARS = new Set(['\u200B', '\u200C', '\u200D', '\uFEFF']);

  // 仅移除零宽字符，不做 trim，保证长度与索引可预测。
  function stripZeroWidth(text) {
    if (typeof text !== 'string') return '';
    return text.replace(ZERO_WIDTH_REGEX, '');
  }

  // 划词文本统一规范化：移除零宽字符并去除首尾空白，便于匹配。
  function normalizeSelectionText(text) {
    return stripZeroWidth(text).trim();
  }

  // 构建“可见文本”到原始文本的索引映射，便于恢复 DOM Range。
  function buildNormalizedTextMap(text) {
    if (!text) return { normalizedText: '', indexMap: [] };
    const normalizedChars = [];
    const indexMap = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ZERO_WIDTH_CHARS.has(ch)) continue;
      indexMap.push(i);
      normalizedChars.push(ch);
    }
    return { normalizedText: normalizedChars.join(''), indexMap };
  }

  // 将规范化后的索引映射回原始文本索引，失败时返回 null。
  function mapNormalizedIndexToOriginal(indexMap, normalizedIndex) {
    if (!Array.isArray(indexMap)) return null;
    if (!Number.isFinite(normalizedIndex)) return null;
    if (normalizedIndex < 0 || normalizedIndex >= indexMap.length) return null;
    return indexMap[normalizedIndex];
  }

  function findThreadById(threadId) {
    if (!threadId) return null;
    const messages = chatHistoryManager?.chatHistory?.messages || [];
    for (const msg of messages) {
      const annotations = Array.isArray(msg?.threadAnnotations) ? msg.threadAnnotations : [];
      const found = annotations.find(item => item?.id === threadId);
      if (found) {
        return { anchorMessageId: msg.id, annotation: found };
      }
    }
    return null;
  }

  function findThreadBySelection(anchorNode, selectionText, matchIndex = null, selectionStartOffset = null) {
    const threads = findThreadsBySelection(anchorNode, selectionText, matchIndex, selectionStartOffset);
    return threads.length ? threads[0] : null;
  }

  function findThreadsBySelection(anchorNode, selectionText, matchIndex = null, selectionStartOffset = null) {
    if (!anchorNode || !selectionText) return [];
    const annotations = Array.isArray(anchorNode.threadAnnotations) ? anchorNode.threadAnnotations : [];
    const normalizedText = normalizeSelectionText(selectionText);
    if (!normalizedText) return [];

    if (Number.isFinite(selectionStartOffset)) {
      const targetOffset = Math.max(0, selectionStartOffset);
      const byOffset = annotations.filter(item => (
        normalizeSelectionText(item?.selectionText || '') === normalizedText
        && Number.isFinite(item?.selectionStartOffset)
        && item.selectionStartOffset === targetOffset
      ));
      if (byOffset.length) return byOffset;
    }

    if (matchIndex == null) {
      return annotations.filter(item => normalizeSelectionText(item?.selectionText || '') === normalizedText);
    }
    return annotations.filter(item => (
      normalizeSelectionText(item?.selectionText || '') === normalizedText
      && item?.matchIndex === matchIndex
    ));
  }

  function createThreadAnnotation(anchorNode, info) {
    if (!anchorNode || !info || !info.selectionText) return null;
    const normalizedSelectionText = normalizeSelectionText(info.selectionText);
    if (!normalizedSelectionText) return null;
    const annotations = ensureThreadAnnotations(anchorNode);
    const threadId = buildThreadId();
    const selectionStartOffset = Number.isFinite(info.selectionStartOffset)
      ? Math.max(0, info.selectionStartOffset)
      : null;
    const selectionEndOffset = Number.isFinite(info.selectionEndOffset)
      ? Math.max(0, info.selectionEndOffset)
      : null;
    const payload = {
      id: threadId,
      anchorMessageId: anchorNode.id,
      selectionText: normalizedSelectionText,
      matchIndex: Number.isFinite(info.matchIndex) ? info.matchIndex : 0,
      // 记录选区在“规范化文本”中的偏移，兜底用于复杂格式/多节点文本的定位。
      selectionStartOffset,
      selectionEndOffset,
      createdAt: Date.now(),
      rootMessageId: null,
      lastMessageId: null
    };
    annotations.push(payload);
    return payload;
  }

  /**
   * 修复/补齐线程注解的根节点与末尾节点，避免删除/重生成后链路断裂。
   * 规则：
   * - rootMessageId 缺失时优先使用 threadHiddenSelection 标记的节点；
   * - lastMessageId 缺失或不可达时，选取“线程内无后继”的最新节点。
   *
   * @param {string} threadId
   * @returns {Object|null} 返回修复后的 annotation（同一引用），失败则返回 null
   */
  function repairThreadAnnotation(threadId) {
    if (!threadId) return null;
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return null;

    const annotation = info.annotation;
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    if (!nodes.length) return annotation;

    const findNode = (id) => nodes.find(n => n.id === id) || null;
    const hasNode = (id) => !!(id && findNode(id));

    const rawRootId = annotation.rootMessageId;
    let resolvedRootId = hasNode(rawRootId) ? rawRootId : null;
    const threadNodes = nodes.filter((node) => {
      if (!node) return false;
      if (node.threadId === threadId) return true;
      if (rawRootId && node.threadRootId === rawRootId) return true;
      if (resolvedRootId && node.threadRootId === resolvedRootId) return true;
      return false;
    });

    if (!resolvedRootId) {
      const hiddenRoot = threadNodes.find(n => n.threadHiddenSelection);
      if (hiddenRoot) {
        resolvedRootId = hiddenRoot.id;
      } else if (threadNodes.length) {
        const oldest = threadNodes.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0];
        resolvedRootId = oldest?.id || null;
      }
    }

    if (resolvedRootId && resolvedRootId !== annotation.rootMessageId) {
      annotation.rootMessageId = resolvedRootId;
    }

    const threadIdSet = new Set(threadNodes.map(n => n.id));
    if (resolvedRootId) threadIdSet.add(resolvedRootId);

    const isReachableFromRoot = (startId) => {
      if (!resolvedRootId || !startId) return false;
      const visited = new Set();
      let currentId = startId;
      while (currentId) {
        if (currentId === resolvedRootId) return true;
        if (visited.has(currentId)) break;
        visited.add(currentId);
        const currentNode = findNode(currentId);
        currentId = currentNode?.parentId || null;
      }
      return false;
    };

    const lastNode = hasNode(annotation.lastMessageId) ? findNode(annotation.lastMessageId) : null;
    const lastValid = !!(lastNode && threadIdSet.has(lastNode.id) && isReachableFromRoot(lastNode.id));
    if (!lastValid) {
      const leafCandidates = threadNodes.filter((node) => {
        const children = Array.isArray(node.children) ? node.children : [];
        return !children.some(childId => threadIdSet.has(childId));
      });
      if (leafCandidates.length) {
        const latest = leafCandidates.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
        annotation.lastMessageId = latest?.id || resolvedRootId || null;
      } else {
        annotation.lastMessageId = resolvedRootId || null;
      }
    }

    return annotation;
  }

  function getSelectionInfoFromRange(range, messageElement) {
    if (!range || !messageElement) return null;
    const textContainer = messageElement.querySelector('.text-content');
    if (!textContainer || !textContainer.contains(range.startContainer) || !textContainer.contains(range.endContainer)) {
      return null;
    }

    const rawText = range.toString();
    const selectionText = normalizeSelectionText(rawText || '');
    if (!selectionText) return null;

    let startOffset = 0;
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(textContainer);
      preRange.setEnd(range.startContainer, range.startOffset);
      startOffset = stripZeroWidth(preRange.toString()).length;
    } catch (_) {
      startOffset = 0;
    }

    const fullText = textContainer.textContent || '';
    const normalizedFullText = stripZeroWidth(fullText);
    const matchIndex = findClosestOccurrenceIndex(normalizedFullText, selectionText, startOffset);
    const selectionStartOffset = Math.max(0, startOffset);
    const selectionEndOffset = selectionStartOffset + selectionText.length;

    return {
      selectionText,
      matchIndex,
      selectionStartOffset,
      selectionEndOffset,
      fullTextLength: normalizedFullText.length
    };
  }

  function findClosestOccurrenceIndex(fullText, selectionText, startOffset) {
    if (!fullText || !selectionText) return 0;
    const positions = [];
    let pos = fullText.indexOf(selectionText);
    while (pos >= 0) {
      positions.push(pos);
      pos = fullText.indexOf(selectionText, pos + selectionText.length);
    }
    if (!positions.length) return 0;

    let bestIndex = 0;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    positions.forEach((p, idx) => {
      const distance = Math.abs(p - startOffset);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = idx;
      }
    });
    return bestIndex;
  }

  function unwrapThreadHighlights(container) {
    if (!container) return;
    const highlights = container.querySelectorAll('.thread-highlight');
    highlights.forEach((el) => {
      const text = document.createTextNode(el.textContent || '');
      el.replaceWith(text);
    });
  }

  function findNthOccurrence(fullText, selectionText, matchIndex) {
    if (!fullText || !selectionText) return -1;
    const targetIndex = Math.max(0, Number(matchIndex) || 0);
    let count = 0;
    let pos = fullText.indexOf(selectionText);
    while (pos >= 0) {
      if (count === targetIndex) return pos;
      count += 1;
      pos = fullText.indexOf(selectionText, pos + selectionText.length);
    }
    return -1;
  }

  function resolveRangeFromIndices(container, startIndex, endIndex) {
    if (!container || startIndex < 0 || endIndex <= startIndex) return null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('.thread-highlight')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let currentIndex = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue || '';
      const nextIndex = currentIndex + text.length;

      if (!startNode && startIndex >= currentIndex && startIndex <= nextIndex) {
        startNode = node;
        startOffset = startIndex - currentIndex;
      }
      if (!endNode && endIndex >= currentIndex && endIndex <= nextIndex) {
        endNode = node;
        endOffset = endIndex - currentIndex;
        break;
      }
      currentIndex = nextIndex;
    }

    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function wrapRangeWithSpan(range, span) {
    if (!range || !span) return false;
    try {
      range.surroundContents(span);
      return true;
    } catch (error) {
      const node = range.startContainer;
      if (node && node === range.endContainer && node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue || '';
        const start = range.startOffset;
        const end = range.endOffset;
        const before = document.createTextNode(text.slice(0, start));
        const middle = document.createTextNode(text.slice(start, end));
        const after = document.createTextNode(text.slice(end));
        span.appendChild(middle);
        const parent = node.parentNode;
        if (!parent) return false;
        parent.insertBefore(before, node);
        parent.insertBefore(span, node);
        parent.insertBefore(after, node);
        parent.removeChild(node);
        return true;
      }
    }
    // 多节点/复杂结构 fallback：逐个文本节点包裹，避免 <strong>/<em> 等分割导致 surroundContents 失败。
    try {
      const textNodes = [];
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('.thread-highlight')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      if (!textNodes.length) return false;

      const wrapTextNodeRange = (targetNode, startOffset, endOffset, template) => {
        const text = targetNode.nodeValue || '';
        const safeStart = Math.max(0, Math.min(startOffset, text.length));
        const safeEnd = Math.max(safeStart, Math.min(endOffset, text.length));
        if (safeEnd <= safeStart) return false;
        const before = document.createTextNode(text.slice(0, safeStart));
        const middle = document.createTextNode(text.slice(safeStart, safeEnd));
        const after = document.createTextNode(text.slice(safeEnd));
        const parent = targetNode.parentNode;
        if (!parent) return false;
        template.appendChild(middle);
        parent.insertBefore(before, targetNode);
        parent.insertBefore(template, targetNode);
        parent.insertBefore(after, targetNode);
        parent.removeChild(targetNode);
        return true;
      };

      let wrappedAny = false;
      textNodes.forEach((node, index) => {
        const isStart = node === range.startContainer;
        const isEnd = node === range.endContainer;
        const startOffset = isStart ? range.startOffset : 0;
        const endOffset = isEnd ? range.endOffset : (node.nodeValue || '').length;
        if (startOffset === 0 && endOffset === 0) return;
        const spanClone = span.cloneNode(false);
        const didWrap = wrapTextNodeRange(node, startOffset, endOffset, spanClone);
        if (didWrap) wrappedAny = true;
      });

      return wrappedAny;
    } catch (_) {}
    return false;
  }

  function scrollThreadMessageIntoView(messageId) {
    if (!threadContainer || !messageId) return;
    const target = threadContainer.querySelector(`[data-message-id="${messageId}"]`);
    if (!target) return;
    const applyScroll = () => {
      if (!threadContainer || !target) return;
      const containerRect = threadContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const style = window.getComputedStyle(threadContainer);
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const delta = targetRect.top - containerRect.top;
      const rawTop = threadContainer.scrollTop + delta - paddingTop;
      const maxTop = Math.max(0, threadContainer.scrollHeight - threadContainer.clientHeight);
      const nextTop = Math.max(0, Math.min(rawTop, maxTop));
      threadContainer.scrollTo({ top: nextTop, behavior: 'auto' });
    };

    applyScroll();
    requestAnimationFrame(applyScroll);

    const refreshAfterImages = () => applyScroll();
    const images = target.querySelectorAll('img');
    if (images.length) {
      let pending = 0;
      images.forEach((img) => {
        if (img.complete) return;
        pending += 1;
        const onDone = () => {
          pending -= 1;
          if (pending <= 0) {
            refreshAfterImages();
          }
        };
        img.addEventListener('load', onDone, { once: true });
        img.addEventListener('error', onDone, { once: true });
      });
    }

    target.classList.remove('thread-jump-highlight');
    void target.offsetWidth;
    target.classList.add('thread-jump-highlight');
    setTimeout(() => target.classList.remove('thread-jump-highlight'), 500);
  }

  function buildAnnotationHighlightRanges(textContainer, annotations) {
    if (!textContainer || !annotations.length) return [];
    const fullText = textContainer.textContent || '';
    const { normalizedText, indexMap } = buildNormalizedTextMap(fullText);
    if (!normalizedText) return [];
    // 同一选区允许多个线程，按起止位置分组，避免重复包裹导致嵌套高亮。
    const grouped = new Map();

    annotations.forEach((annotation) => {
      const selectionText = normalizeSelectionText(annotation?.selectionText || '');
      if (!selectionText) return;
      const matchIndex = Number.isFinite(annotation.matchIndex) ? annotation.matchIndex : 0;
      const hasOffsets = Number.isFinite(annotation.selectionStartOffset)
        && Number.isFinite(annotation.selectionEndOffset)
        && annotation.selectionEndOffset > annotation.selectionStartOffset;
      let startPos = hasOffsets ? Math.max(0, annotation.selectionStartOffset) : -1;
      let endPos = hasOffsets
        ? Math.max(0, annotation.selectionEndOffset)
        : -1;

      if (!hasOffsets || endPos <= startPos || startPos >= normalizedText.length) {
        startPos = findNthOccurrence(normalizedText, selectionText, matchIndex);
        if (startPos < 0) return;
        endPos = startPos + selectionText.length;
      }

      if (endPos > normalizedText.length) {
        endPos = Math.min(normalizedText.length, endPos);
        if (endPos <= startPos) return;
      }

      const mappedStart = mapNormalizedIndexToOriginal(indexMap, startPos);
      const mappedEnd = mapNormalizedIndexToOriginal(indexMap, endPos - 1);
      if (!Number.isFinite(mappedStart) || !Number.isFinite(mappedEnd)) return;
      if (mappedEnd + 1 <= mappedStart) return;
      const key = `${mappedStart}:${mappedEnd + 1}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          startPos: mappedStart,
          endPos: mappedEnd + 1,
          annotations: []
        });
      }
      grouped.get(key).annotations.push(annotation);
    });

    return Array.from(grouped.values());
  }

  function applyHighlightRange(textContainer, rangeGroup) {
    if (!textContainer || !rangeGroup) return;
    const { annotations, startPos, endPos } = rangeGroup;
    if (!Array.isArray(annotations) || !annotations.length) return;
    if (startPos < 0 || endPos <= startPos) return;
    const range = resolveRangeFromIndices(textContainer, startPos, endPos);
    if (!range) return;

    const span = document.createElement('span');
    span.className = 'thread-highlight';
    const primary = annotations[0];
    const threadIds = annotations.map(item => item?.id).filter(Boolean);
    if (threadIds.length) {
      span.dataset.threadIds = threadIds.join(',');
      span.dataset.threadId = threadIds[0];
      span.dataset.threadCount = String(threadIds.length);
    }
    span.dataset.threadAnchorId = primary?.anchorMessageId || '';
    span.dataset.selectionText = primary?.selectionText || '';
    if (Number.isFinite(primary?.matchIndex)) {
      span.dataset.matchIndex = String(primary.matchIndex);
    }
    if (Number.isFinite(primary?.selectionStartOffset)) {
      span.dataset.selectionStartOffset = String(primary.selectionStartOffset);
    }
    if (Number.isFinite(primary?.selectionEndOffset)) {
      span.dataset.selectionEndOffset = String(primary.selectionEndOffset);
    }

    wrapRangeWithSpan(range, span);
  }

  function decorateMessageElement(messageElement, messageNode) {
    if (!messageElement || !messageNode) return;
    const annotations = Array.isArray(messageNode.threadAnnotations)
      ? messageNode.threadAnnotations
      : [];

    const textContainer = messageElement.querySelector('.text-content');
    if (!textContainer) return;

    unwrapThreadHighlights(textContainer);
    if (!annotations.length) return;
    const ranges = buildAnnotationHighlightRanges(textContainer, annotations);
    // 从后往前包裹高亮，避免前面的高亮拆分文本节点后导致索引偏移。
    ranges.sort((a, b) => b.startPos - a.startPos);
    ranges.forEach((rangeGroup) => {
      applyHighlightRange(textContainer, rangeGroup);
    });
  }

  function clearSelectionRanges() {
    try {
      const selection = window.getSelection();
      selection?.removeAllRanges();
    } catch (_) {}
  }

  function runSelectionPromptInThread(anchorNode, selectionInfo, messageElement, existingThread) {
    const selectionText = (selectionInfo?.selectionText || '').trim();
    if (!selectionText) {
      showNotification?.({ message: '选中内容为空，无法发送划词方式1', type: 'warning' });
      return false;
    }

    if (!promptSettingsManager?.getPrompts) {
      showNotification?.({ message: '未找到划词方式1配置', type: 'warning' });
      return false;
    }

    const prompts = promptSettingsManager.getPrompts();
    const selectionPromptText = (prompts?.query?.prompt || '').trim();
    if (!selectionPromptText) {
      showNotification?.({ message: '尚未配置划词方式1，请在设置中补充', type: 'warning' });
      return false;
    }

    if (!messageSender?.sendMessage) {
      showNotification?.({ message: '发送器未就绪，暂时无法发送', type: 'warning' });
      return false;
    }

    let targetThread = existingThread;
    if (!targetThread) {
      const created = createThreadAnnotation(anchorNode, selectionInfo);
      if (!created) {
        showNotification?.({ message: '创建划词对话失败', type: 'warning' });
        return false;
      }
      decorateMessageElement(messageElement, anchorNode);
      targetThread = created;
    }

    // 进入线程后，用划词方式1自动发送一条消息（效果等同于手动使用划词方式1）。
    enterThread(targetThread.id);
    const userMessageText = selectionPromptText.replace('<SELECTION>', selectionText);
    const apiPref = (prompts.query?.model || '').trim();
    const apiParam = apiPref || 'follow_current';
    messageSender.sendMessage({
      originalMessageText: userMessageText,
      specificPromptType: 'query',
      promptMeta: { selectionText },
      api: apiParam
    });
    return true;
  }

  function createThreadFromSelection(anchorNode, selectionInfo, messageElement) {
    if (!anchorNode || !selectionInfo) return null;
    const created = createThreadAnnotation(anchorNode, selectionInfo);
    if (!created) {
      showNotification?.({ message: '创建划词对话失败', type: 'warning' });
      return null;
    }
    if (messageElement) {
      decorateMessageElement(messageElement, anchorNode);
    }
    enterThread(created.id);
    return created;
  }

  function showSelectionBubble(selectionInfo, messageElement, range) {
    if (!selectionInfo || !messageElement || !range) return;
    const rect = range.getBoundingClientRect();
    const messageId = messageElement.getAttribute('data-message-id') || '';
    if (!messageId) return;

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === messageId);
    if (!anchorNode) return;

    const matchingThreads = findThreadsBySelection(
      anchorNode,
      selectionInfo.selectionText,
      selectionInfo.matchIndex,
      selectionInfo.selectionStartOffset
    );
    const primaryThread = pickPrimaryThread(matchingThreads);
    state.pendingSelection = {
      messageId,
      selectionText: selectionInfo.selectionText,
      matchIndex: selectionInfo.matchIndex
    };

    const hasMultipleThreads = matchingThreads.length > 1;
    const previewItems = hasMultipleThreads
      ? buildThreadSummaryItems(matchingThreads)
      : (primaryThread ? buildThreadPreviewItems(primaryThread.id) : []);
    const previewText = selectionInfo.selectionText;

    showBubbleAtRect(rect, {
      title: matchingThreads.length ? '划词对话' : '',
      content: previewText,
      contentItems: previewItems,
      iconButtons: [
        {
          iconClass: 'fa-solid fa-paper-plane',
          title: '使用划词方式1发送',
          onClick: () => {
            const didSend = runSelectionPromptInThread(
              anchorNode,
              selectionInfo,
              messageElement,
              primaryThread
            );
            if (didSend) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        },
        {
          iconClass: 'fa-solid fa-plus',
          title: '新建划词对话',
          onClick: () => {
            const created = createThreadFromSelection(anchorNode, selectionInfo, messageElement);
            if (created) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        }
      ],
      onClick: hasMultipleThreads ? null : () => {
        if (primaryThread) {
          enterThread(primaryThread.id);
        } else {
          const created = createThreadFromSelection(anchorNode, selectionInfo, messageElement);
          if (!created) return;
        }
        hideBubble(true);
        clearSelectionRanges();
      },
      onItemClick: (item) => {
        if (item?.threadId) {
          enterThread(item.threadId);
          hideBubble(true);
          clearSelectionRanges();
          return;
        }
        if (item?.messageId && primaryThread) {
          enterThread(primaryThread.id, { focusMessageId: item.messageId });
          hideBubble(true);
          clearSelectionRanges();
        }
      },
      pinned: true,
      type: 'selection'
    });
  }

  function showPreviewBubbleForHighlight(target, options = {}) {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const threadIds = parseThreadIdsFromHighlight(target);
    const threadInfos = threadIds
      .map(id => findThreadById(id))
      .filter(info => info?.annotation);
    const threads = threadInfos.map(info => info.annotation);
    const primaryThread = pickPrimaryThread(threads);
    const selectionText = target.dataset.selectionText || target.textContent || '';
    const hasMultipleThreads = threads.length > 1;
    const previewItems = hasMultipleThreads
      ? buildThreadSummaryItems(threads)
      : (primaryThread ? buildThreadPreviewItems(primaryThread.id) : []);
    const fallbackText = selectionText ? `“${selectionText}”` : '';
    const fallbackHtml = fallbackText
      ? (messageProcessor?.processMathAndMarkdown?.(fallbackText) || fallbackText)
      : '';
    const anchorMessageId = target.dataset.threadAnchorId || '';
    const anchorNode = anchorMessageId
      ? chatHistoryManager?.chatHistory?.messages?.find(m => m.id === anchorMessageId)
      : null;
    const anchorElement = anchorNode ? getMessageElementFromNode(anchorNode) : null;
    const selectionInfo = buildSelectionInfoFromHighlight(target);

    showBubbleAtRect(rect, {
      title: threads.length ? '划词对话' : '划词对话预览',
      content: fallbackText,
      contentHtml: previewItems.length ? '' : fallbackHtml,
      contentItems: previewItems,
      iconButtons: [
        {
          iconClass: 'fa-solid fa-paper-plane',
          title: '使用划词方式1发送',
          onClick: () => {
            if (!anchorNode || !selectionInfo.selectionText) return;
            const didSend = runSelectionPromptInThread(
              anchorNode,
              selectionInfo,
              anchorElement,
              primaryThread
            );
            if (didSend) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        },
        {
          iconClass: 'fa-solid fa-plus',
          title: '新建划词对话',
          onClick: () => {
            if (!anchorNode || !selectionInfo.selectionText) return;
            const created = createThreadFromSelection(anchorNode, selectionInfo, anchorElement);
            if (created) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        }
      ],
      onItemClick: (item) => {
        if (item?.threadId) {
          enterThread(item.threadId);
          hideBubble(true);
          return;
        }
        if (item?.messageId && primaryThread) {
          enterThread(primaryThread.id, { focusMessageId: item.messageId });
          hideBubble(true);
        }
      },
      pinned: !!options.pinned,
      type: 'preview'
    });
  }

  async function enterThread(threadId, options = {}) {
    const info = findThreadById(threadId);
    if (!info) {
      showNotification?.({ message: '未找到对应的划词对话', type: 'warning' });
      return;
    }
    state.activeThreadId = threadId;
    state.activeAnchorMessageId = info.anchorMessageId;
    state.activeSelectionText = info.annotation?.selectionText || '';
    document.body.classList.add('thread-mode-active');
    updateThreadPanelTitle(state.activeSelectionText);
    applyThreadLayout();
    await renderThreadMessages(threadId, options);
  }

  function removeThreadMessageElements(messageId) {
    if (!messageId) return;
    document.querySelectorAll(`[data-message-id="${messageId}"]`).forEach((node) => {
      node.remove();
    });
  }

  async function deleteThreadById(threadId) {
    if (!threadId) return;
    const info = findThreadById(threadId);
    if (!info || !info.annotation) {
      showNotification?.({ message: '未找到要删除的划词对话', type: 'warning' });
      return;
    }

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === info.anchorMessageId) || null;
    const chain = collectThreadChain(info.annotation)
      .filter(node => node?.threadId === threadId || node?.threadRootId === info.annotation?.rootMessageId);

    // 先从线程末端开始删除，避免父子关系被提前改写导致链路错乱。
    chain.slice().reverse().forEach((node) => {
      removeThreadMessageElements(node.id);
      chatHistoryManager?.deleteMessage?.(node.id);
    });

    if (anchorNode) {
      removeThreadAnnotationFromAnchor(anchorNode, threadId);
    }

    const anchorElement = anchorNode ? getMessageElementFromNode(anchorNode) : null;
    if (anchorElement && anchorNode) {
      decorateMessageElement(anchorElement, anchorNode);
    }

    if (state.activeThreadId === threadId) {
      exitThread({ skipDraftCleanup: true });
    }

    if (chatHistoryUI?.saveCurrentConversation) {
      await chatHistoryUI.saveCurrentConversation(true);
    }

    showNotification?.({ message: '已删除划词对话', type: 'info' });
  }

  async function deleteActiveThread() {
    const threadId = state.activeThreadId;
    if (!threadId) return;
    await deleteThreadById(threadId);
  }

  function cleanupDraftThreadIfNeeded(threadId) {
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return false;
    if (info.annotation?.rootMessageId) return false;

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === info.anchorMessageId) || null;
    if (!anchorNode) return false;
    const removed = removeThreadAnnotationFromAnchor(anchorNode, threadId);
    if (!removed) return false;

    const anchorElement = getMessageElementFromNode(anchorNode);
    if (anchorElement) {
      decorateMessageElement(anchorElement, anchorNode);
    }

    if (chatHistoryUI?.saveCurrentConversation) {
      // 无实际对话内容的临时线程，退出时自动清理并保存，避免堆积空线程。
      const savePromise = chatHistoryUI.saveCurrentConversation(true);
      if (savePromise?.catch) {
        savePromise.catch(() => {});
      }
    }
    return true;
  }

  function exitThread(options = {}) {
    const { skipDraftCleanup = false } = options || {};
    const currentThreadId = state.activeThreadId;
    if (!skipDraftCleanup && currentThreadId) {
      cleanupDraftThreadIfNeeded(currentThreadId);
    }
    state.activeThreadId = null;
    state.activeAnchorMessageId = null;
    state.activeSelectionText = '';
    document.body.classList.remove('thread-mode-active');
    if (threadPanel) threadPanel.setAttribute('aria-hidden', 'true');
    if (threadContainer) threadContainer.innerHTML = '';
    threadBannerEl = null;
    threadBannerTextEl = null;
    updateThreadPanelTitle('');
    resetHiddenMessages();
    moveThreadPanelHome();
  }

  function resetForClearChat() {
    // 清空聊天时同时重置线程与气泡状态，避免残留 UI 影响后续划词。
    hideBubble(true);
    clearBubbleHideAnimationTimer();
    clearSelectionRanges();
    state.pendingSelection = null;
    exitThread({ skipDraftCleanup: true });
    if (bubbleEl) {
      bubbleEl.remove();
      bubbleEl = null;
      bubbleHeaderEl = null;
      bubbleTitleEl = null;
      bubbleContentEl = null;
      bubbleContentTextEl = null;
      bubbleContentIconEl = null;
    }
  }

  function isThreadModeActive() {
    return !!state.activeThreadId;
  }

  function handleSelectionMouseUp(event) {
    if (event && bubbleEl && bubbleEl.contains(event.target)) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      if (!state.bubblePinned) hideBubble();
      return;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range) return;

    const startEl = range.startContainer?.parentElement || range.startContainer;
    const endEl = range.endContainer?.parentElement || range.endContainer;
    const startMessage = startEl?.closest?.('.message');
    const endMessage = endEl?.closest?.('.message');

    if (!startMessage || startMessage !== endMessage) {
      hideBubble(true);
      return;
    }

    if (threadPanel && threadPanel.contains(startMessage)) {
      hideBubble(true);
      return;
    }

    if (startMessage.classList.contains('loading-message')) {
      hideBubble(true);
      return;
    }

    const selectionInfo = getSelectionInfoFromRange(range, startMessage);
    if (!selectionInfo) {
      hideBubble(true);
      return;
    }

    showSelectionBubble(selectionInfo, startMessage, range);
  }

  function handleHighlightMouseOver(event) {
    const target = event.target.closest('.thread-highlight');
    if (!target || state.bubblePinned) return;
    state.highlightHovered = true;
    clearBubbleHideTimer();
    showPreviewBubbleForHighlight(target);
  }

  function handleHighlightMouseOut(event) {
    const target = event.target.closest('.thread-highlight');
    if (!target) return;
    if (state.bubblePinned) return;
    state.highlightHovered = false;
    if (bubbleEl && event.relatedTarget && bubbleEl.contains(event.relatedTarget)) return;
    scheduleBubbleHide();
  }

  function handleHighlightClick(event) {
    const target = event.target.closest('.thread-highlight');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const threadIds = parseThreadIdsFromHighlight(target);
    const threadId = threadIds[0] || '';
    if (!threadId) return;
    hideBubble(true);
    if (threadIds.length > 1) {
      showPreviewBubbleForHighlight(target, { pinned: true });
      return;
    }
    if (state.activeThreadId && state.activeThreadId === threadId) {
      exitThread();
      return;
    }
    enterThread(threadId);
  }

  function handleDocumentClick(event) {
    if (!bubbleEl || bubbleEl.style.display === 'none') return;
    if (bubbleEl.contains(event.target)) return;
    if (event.target.closest('.thread-highlight')) return;
    if (state.bubbleType === 'selection') {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
    }
    hideBubble(true);
  }

  function bindHighlightEvents(container) {
    if (!container) return;
    container.addEventListener('mouseover', handleHighlightMouseOver);
    container.addEventListener('mouseout', handleHighlightMouseOut);
    container.addEventListener('click', handleHighlightClick);
  }

  function init() {
    if (!chatContainer) return;
    document.addEventListener('mouseup', handleSelectionMouseUp);
    document.addEventListener('click', handleDocumentClick);
    bindHighlightEvents(chatContainer);
    if (threadPanel) {
      threadPanel.setAttribute('aria-hidden', 'true');
    }
    if (document.documentElement) {
      layoutObserver = new MutationObserver(() => {
        if (state.activeThreadId) {
          applyThreadLayout();
        }
      });
      layoutObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
  }

  return {
    init,
    decorateMessageElement,
    enterThread,
    exitThread,
    resetForClearChat,
    isThreadModeActive,
    getActiveThreadId: () => state.activeThreadId,
    getActiveAnchorMessageId: () => state.activeAnchorMessageId,
    getActiveSelectionText: () => state.activeSelectionText,
    findThreadById,
    repairThreadAnnotation
  };
}
