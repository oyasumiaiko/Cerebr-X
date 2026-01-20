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
      // 调试：确认气泡动作按钮是否收到点击事件
      if (actionId) {
        console.log('[划词气泡] 点击动作按钮:', actionId);
      } else {
        console.log('[划词气泡] 点击气泡主体');
      }
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
      iconClass = '',
      iconButtons = null,
      onClick = null,
      pinned = false,
      type = 'preview',
      variant = ''
    } = options;

    bubbleTitleEl.textContent = title;
    bubbleTitleEl.style.display = title ? 'block' : 'none';
    const hasContent = !!content;
    bubbleContentTextEl.textContent = content;
    bubbleContentTextEl.style.display = hasContent ? 'block' : 'none';

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
    state.bubblePinned = !!pinned;
    state.bubbleType = type;
    state.bubbleHovered = false;
    clearBubbleHideTimer();

    positionBubble(rect);
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
    bubbleEl.style.display = 'none';
    bubbleEl.dataset.visible = 'false';
    delete bubbleEl.dataset.variant;
    delete bubbleEl.dataset.placement;
    bubbleEl.classList.remove('selection-thread-bubble--action');
    state.bubblePinned = false;
    state.bubbleType = 'hidden';
    state.bubbleHovered = false;
    state.highlightHovered = false;
    state.bubbleClickHandler = null;
    state.bubbleActionHandlers?.clear?.();
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

  function extractPlainTextFromContent(content) {
    const normalized = normalizeStoredMessageContent(content);
    if (Array.isArray(normalized)) {
      const { text } = splitStoredMessageContent(normalized);
      return summarizePreviewText(stripHtmlToText(text || ''));
    }
    return summarizePreviewText(stripHtmlToText(normalized || ''));
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

  async function renderThreadMessages(threadId) {
    // 将线程链路渲染到线程面板，仅用于展示，不写回历史
    if (!threadContainer || !messageProcessor) return;
    if (state.activeThreadId !== threadId) return;
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
        messageElem.setAttribute('data-message-id', node.id);
        renderApiFooterForNode(messageElem, node);
      }
    }

    threadContainer.appendChild(fragment);
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

  function findThreadBySelection(anchorNode, selectionText, matchIndex = null) {
    if (!anchorNode || !selectionText) return null;
    const annotations = Array.isArray(anchorNode.threadAnnotations) ? anchorNode.threadAnnotations : [];
    const normalizedText = selectionText.trim();
    if (!normalizedText) return null;

    if (matchIndex == null) {
      return annotations.find(item => item?.selectionText === normalizedText) || null;
    }
    return annotations.find(item => item?.selectionText === normalizedText && item?.matchIndex === matchIndex) || null;
  }

  function createThreadAnnotation(anchorNode, info) {
    if (!anchorNode || !info || !info.selectionText) return null;
    const annotations = ensureThreadAnnotations(anchorNode);
    const threadId = buildThreadId();
    const payload = {
      id: threadId,
      anchorMessageId: anchorNode.id,
      selectionText: info.selectionText,
      matchIndex: Number.isFinite(info.matchIndex) ? info.matchIndex : 0,
      createdAt: Date.now(),
      rootMessageId: null,
      lastMessageId: null
    };
    annotations.push(payload);
    return payload;
  }

  function getSelectionInfoFromRange(range, messageElement) {
    if (!range || !messageElement) return null;
    const textContainer = messageElement.querySelector('.text-content');
    if (!textContainer || !textContainer.contains(range.startContainer) || !textContainer.contains(range.endContainer)) {
      return null;
    }

    const rawText = range.toString();
    const selectionText = rawText ? rawText.trim() : '';
    if (!selectionText) return null;

    let startOffset = 0;
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(textContainer);
      preRange.setEnd(range.startContainer, range.startOffset);
      startOffset = preRange.toString().length;
    } catch (_) {
      startOffset = 0;
    }

    const fullText = textContainer.textContent || '';
    const matchIndex = findClosestOccurrenceIndex(fullText, selectionText, startOffset);

    return {
      selectionText,
      matchIndex,
      fullTextLength: fullText.length
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
    return false;
  }

  function buildAnnotationHighlightRanges(textContainer, annotations) {
    if (!textContainer || !annotations.length) return [];
    const fullText = textContainer.textContent || '';
    return annotations.map((annotation) => {
      const selectionText = annotation?.selectionText || '';
      if (!selectionText) return null;
      const matchIndex = Number.isFinite(annotation.matchIndex) ? annotation.matchIndex : 0;
      const startPos = findNthOccurrence(fullText, selectionText, matchIndex);
      if (startPos < 0) return null;
      return {
        annotation,
        startPos,
        endPos: startPos + selectionText.length
      };
    }).filter(Boolean);
  }

  function applyHighlightRange(textContainer, annotation, startPos, endPos) {
    if (!textContainer || !annotation || startPos < 0 || endPos <= startPos) return;
    const range = resolveRangeFromIndices(textContainer, startPos, endPos);
    if (!range) return;

    const span = document.createElement('span');
    span.className = 'thread-highlight';
    span.dataset.threadId = annotation.id;
    span.dataset.threadAnchorId = annotation.anchorMessageId || '';
    span.dataset.selectionText = annotation.selectionText || '';

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
    ranges.forEach(({ annotation, startPos, endPos }) => {
      applyHighlightRange(textContainer, annotation, startPos, endPos);
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
      showNotification?.({ message: '选中内容为空，无法发送划词提示', type: 'warning' });
      console.warn('[划词气泡] 选中内容为空，跳过发送');
      return false;
    }

    if (!promptSettingsManager?.getPrompts) {
      showNotification?.({ message: '未找到划词提示词配置', type: 'warning' });
      console.warn('[划词气泡] promptSettingsManager 未就绪');
      return false;
    }

    const prompts = promptSettingsManager.getPrompts();
    const selectionPromptText = (prompts?.selection?.prompt || '').trim();
    if (!selectionPromptText) {
      showNotification?.({ message: '尚未配置划词提示词，请在设置中补充', type: 'warning' });
      console.warn('[划词气泡] 划词提示词为空');
      return false;
    }

    if (!messageSender?.sendMessage) {
      showNotification?.({ message: '发送器未就绪，暂时无法发送', type: 'warning' });
      console.warn('[划词气泡] messageSender 未就绪');
      return false;
    }

    console.log('[划词气泡] 准备发送划词提示', { selectionText });
    let targetThread = existingThread;
    if (!targetThread) {
      const created = createThreadAnnotation(anchorNode, selectionInfo);
      if (!created) {
        showNotification?.({ message: '创建划词对话失败', type: 'warning' });
        console.warn('[划词气泡] 创建线程失败');
        return false;
      }
      decorateMessageElement(messageElement, anchorNode);
      targetThread = created;
    }

    // 进入线程后，用划词提示词自动发送一条消息（效果等同于手动使用划词提示词）。
    enterThread(targetThread.id);
    const userMessageText = selectionPromptText.replace('<SELECTION>', selectionText);
    const apiPref = (prompts.selection?.model || '').trim();
    const apiParam = apiPref || 'follow_current';
    console.log('[划词气泡] 发送参数', { api: apiParam, message: userMessageText });
    messageSender.sendMessage({
      originalMessageText: userMessageText,
      specificPromptType: 'selection',
      promptMeta: { selectionText },
      api: apiParam
    });
    return true;
  }

  function showSelectionBubble(selectionInfo, messageElement, range) {
    if (!selectionInfo || !messageElement || !range) return;
    const rect = range.getBoundingClientRect();
    const messageId = messageElement.getAttribute('data-message-id') || '';
    if (!messageId) return;

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === messageId);
    if (!anchorNode) return;

    const existingThread = findThreadBySelection(anchorNode, selectionInfo.selectionText, selectionInfo.matchIndex);
    console.log('[划词气泡] 展示气泡', {
      selectionText: selectionInfo.selectionText,
      hasExistingThread: !!existingThread
    });
    state.pendingSelection = {
      messageId,
      selectionText: selectionInfo.selectionText,
      matchIndex: selectionInfo.matchIndex
    };

    const previewLines = existingThread ? buildThreadPreviewLines(existingThread.id, 2) : [];
    const previewText = previewLines.length
      ? previewLines.join('\n')
      : selectionInfo.selectionText;
    const showQuoteIcon = !existingThread;

    showBubbleAtRect(rect, {
      title: existingThread ? '划词对话' : '',
      content: previewText,
      iconClass: showQuoteIcon ? 'fa-solid fa-quote-right' : '',
      iconButtons: [
        {
          iconClass: 'fa-solid fa-paper-plane',
          title: '使用划词提示词发送',
          onClick: () => {
            const didSend = runSelectionPromptInThread(
              anchorNode,
              selectionInfo,
              messageElement,
              existingThread
            );
            if (didSend) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        }
      ],
      onClick: () => {
        if (existingThread) {
          enterThread(existingThread.id);
        } else {
          const created = createThreadAnnotation(anchorNode, selectionInfo);
          if (created) {
            decorateMessageElement(messageElement, anchorNode);
            enterThread(created.id);
          } else {
            showNotification?.({ message: '创建划词对话失败', type: 'warning' });
          }
        }
        hideBubble(true);
        clearSelectionRanges();
      },
      pinned: true,
      type: 'selection'
    });
  }

  function showPreviewBubbleForHighlight(target) {
    const rect = target.getBoundingClientRect();
    const threadId = target.dataset.threadId || '';
    const selectionText = target.dataset.selectionText || target.textContent || '';
    const previewLines = buildThreadPreviewLines(threadId, 2);
    const previewText = previewLines.length
      ? previewLines.join('\n')
      : (selectionText ? `“${selectionText}”` : '');

    showBubbleAtRect(rect, {
      title: '划词对话预览',
      content: previewText,
      pinned: false,
      type: 'preview'
    });
  }

  function enterThread(threadId) {
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
    renderThreadMessages(threadId);
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
    const threadId = target.dataset.threadId || '';
    if (!threadId) return;
    hideBubble(true);
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
    isThreadModeActive,
    getActiveThreadId: () => state.activeThreadId,
    getActiveAnchorMessageId: () => state.activeAnchorMessageId,
    getActiveSelectionText: () => state.activeSelectionText,
    findThreadById
  };
}
