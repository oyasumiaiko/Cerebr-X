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
  const threadPanelTitle = dom.threadPanelTitle;
  const threadExitButton = dom.threadExitButton;
  const chatHistoryManager = services.chatHistoryManager;
  const messageProcessor = services.messageProcessor;
  const imageHandler = services.imageHandler;
  const apiManager = services.apiManager;
  const showNotification = utils?.showNotification;

  const state = {
    activeThreadId: null,
    activeAnchorMessageId: null,
    activeSelectionText: '',
    pendingSelection: null,
    bubblePinned: false,
    bubbleType: 'hidden'
  };

  const threadPanelHome = {
    parent: threadPanel?.parentNode || null,
    nextSibling: threadPanel?.nextSibling || null
  };

  let layoutObserver = null;

  let bubbleEl = null;
  let bubbleTitleEl = null;
  let bubbleContentEl = null;
  let bubbleActionEl = null;
  let bubbleSecondaryEl = null;
  let bubbleCloseEl = null;

  function ensureBubble() {
    if (bubbleEl) return;
    bubbleEl = document.createElement('div');
    bubbleEl.className = 'selection-thread-bubble';
    bubbleEl.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'selection-thread-bubble__header';

    bubbleTitleEl = document.createElement('div');
    bubbleTitleEl.className = 'selection-thread-bubble__title';
    header.appendChild(bubbleTitleEl);

    bubbleCloseEl = document.createElement('button');
    bubbleCloseEl.className = 'selection-thread-bubble__close';
    bubbleCloseEl.setAttribute('type', 'button');
    bubbleCloseEl.textContent = '×';
    bubbleCloseEl.addEventListener('click', () => hideBubble(true));
    header.appendChild(bubbleCloseEl);

    bubbleContentEl = document.createElement('div');
    bubbleContentEl.className = 'selection-thread-bubble__content';

    const actions = document.createElement('div');
    actions.className = 'selection-thread-bubble__actions';

    bubbleActionEl = document.createElement('button');
    bubbleActionEl.className = 'selection-thread-bubble__primary';
    bubbleActionEl.setAttribute('type', 'button');

    bubbleSecondaryEl = document.createElement('button');
    bubbleSecondaryEl.className = 'selection-thread-bubble__secondary';
    bubbleSecondaryEl.setAttribute('type', 'button');

    actions.appendChild(bubbleSecondaryEl);
    actions.appendChild(bubbleActionEl);

    bubbleEl.appendChild(header);
    bubbleEl.appendChild(bubbleContentEl);
    bubbleEl.appendChild(actions);
    document.body.appendChild(bubbleEl);
  }

  function showBubbleAtRect(rect, options = {}) {
    ensureBubble();
    if (!bubbleEl) return;

    const {
      title = '',
      content = '',
      primaryText = '',
      secondaryText = '',
      onPrimary = null,
      onSecondary = null,
      onClose = null,
      pinned = false,
      type = 'preview'
    } = options;

    bubbleTitleEl.textContent = title;
    bubbleContentEl.textContent = content;

    bubbleActionEl.textContent = primaryText;
    bubbleSecondaryEl.textContent = secondaryText;

    bubbleActionEl.style.display = primaryText ? 'inline-flex' : 'none';
    bubbleSecondaryEl.style.display = secondaryText ? 'inline-flex' : 'none';

    bubbleActionEl.onclick = typeof onPrimary === 'function' ? onPrimary : null;
    bubbleSecondaryEl.onclick = typeof onSecondary === 'function' ? onSecondary : null;

    bubbleCloseEl.onclick = () => {
      if (typeof onClose === 'function') onClose();
      hideBubble(true);
    };

    bubbleEl.style.display = 'block';
    bubbleEl.dataset.visible = 'true';
    bubbleEl.dataset.type = type;
    state.bubblePinned = !!pinned;
    state.bubbleType = type;

    positionBubble(rect);
  }

  function positionBubble(rect) {
    if (!bubbleEl || !rect) return;
    const padding = 12;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const bubbleRect = bubbleEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - bubbleRect.width / 2;
    let top = rect.top - bubbleRect.height - 10;

    if (top < padding) {
      top = rect.bottom + 10;
    }

    left = Math.max(padding, Math.min(left, viewportW - bubbleRect.width - padding));
    top = Math.max(padding, Math.min(top, viewportH - bubbleRect.height - padding));

    bubbleEl.style.left = `${Math.round(left)}px`;
    bubbleEl.style.top = `${Math.round(top)}px`;
  }

  function hideBubble(force = false) {
    if (!bubbleEl) return;
    if (!force && state.bubblePinned) return;
    bubbleEl.style.display = 'none';
    bubbleEl.dataset.visible = 'false';
    state.bubblePinned = false;
    state.bubbleType = 'hidden';
  }

  function isFullscreenLayout() {
    return !!document.documentElement?.classList?.contains('fullscreen-mode');
  }

  function updateThreadPanelTitle(selectionText) {
    if (!threadPanelTitle) return;
    const safeText = typeof selectionText === 'string' ? selectionText.trim() : '';
    const label = safeText ? `划词对话 · ${safeText}` : '划词对话';
    threadPanelTitle.textContent = label;
    threadPanelTitle.title = safeText || '';
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

  async function renderThreadMessages(threadId) {
    // 将线程链路渲染到线程面板，仅用于展示，不写回历史
    if (!threadContainer || !messageProcessor) return;
    if (state.activeThreadId !== threadId) return;
    threadContainer.innerHTML = '';
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return;

    const chain = collectThreadChain(info.annotation)
      .filter(node => !node?.threadHiddenSelection);
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

  function applyHighlightForAnnotation(textContainer, annotation) {
    if (!textContainer || !annotation?.selectionText) return;
    const fullText = textContainer.textContent || '';
    const selectionText = annotation.selectionText;
    const matchIndex = Number.isFinite(annotation.matchIndex) ? annotation.matchIndex : 0;
    const startPos = findNthOccurrence(fullText, selectionText, matchIndex);
    if (startPos < 0) return;
    const endPos = startPos + selectionText.length;

    const range = resolveRangeFromIndices(textContainer, startPos, endPos);
    if (!range) return;

    const span = document.createElement('span');
    span.className = 'thread-highlight';
    span.dataset.threadId = annotation.id;
    span.dataset.threadAnchorId = annotation.anchorMessageId || '';
    span.dataset.selectionText = selectionText;

    wrapRangeWithSpan(range, span);
  }

  function decorateMessageElement(messageElement, messageNode) {
    if (!messageElement || !messageNode) return;
    const annotations = Array.isArray(messageNode.threadAnnotations)
      ? messageNode.threadAnnotations
      : [];
    if (!annotations.length) return;

    const textContainer = messageElement.querySelector('.text-content');
    if (!textContainer) return;

    unwrapThreadHighlights(textContainer);
    annotations.forEach((annotation) => {
      applyHighlightForAnnotation(textContainer, annotation);
    });
  }

  function showSelectionBubble(selectionInfo, messageElement, range) {
    if (!selectionInfo || !messageElement || !range) return;
    const rect = range.getBoundingClientRect();
    const messageId = messageElement.getAttribute('data-message-id') || '';
    if (!messageId) return;

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === messageId);
    if (!anchorNode) return;

    const existingThread = findThreadBySelection(anchorNode, selectionInfo.selectionText, selectionInfo.matchIndex);
    state.pendingSelection = {
      messageId,
      selectionText: selectionInfo.selectionText,
      matchIndex: selectionInfo.matchIndex
    };

    showBubbleAtRect(rect, {
      title: existingThread ? '划词对话' : '创建划词对话',
      content: selectionInfo.selectionText,
      primaryText: existingThread ? '继续对话' : '进入对话',
      secondaryText: '取消',
      onPrimary: () => {
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
        try {
          const selection = window.getSelection();
          selection?.removeAllRanges();
        } catch (_) {}
      },
      onSecondary: () => hideBubble(true),
      pinned: true,
      type: 'selection'
    });
  }

  function showPreviewBubbleForHighlight(target) {
    const rect = target.getBoundingClientRect();
    const threadId = target.dataset.threadId || '';
    const selectionText = target.dataset.selectionText || target.textContent || '';

    const threadInfo = findThreadById(threadId);
    const previewLines = buildThreadPreviewLines(threadId, 2);
    const previewText = previewLines.length
      ? previewLines.join('\n')
      : (selectionText ? `“${selectionText}”` : '');

    showBubbleAtRect(rect, {
      title: '划词对话预览',
      content: previewText,
      primaryText: threadInfo ? '继续对话' : '',
      secondaryText: '',
      onPrimary: () => {
        if (threadInfo) {
          enterThread(threadId);
        }
        hideBubble(true);
      },
      pinned: false,
      type: 'preview'
    });
  }

  function showPinnedBubbleForHighlight(target) {
    const rect = target.getBoundingClientRect();
    const threadId = target.dataset.threadId || '';
    const selectionText = target.dataset.selectionText || target.textContent || '';
    const previewLines = buildThreadPreviewLines(threadId, 3);
    const lines = [];
    if (selectionText) {
      lines.push(`选中：${selectionText}`);
    }
    if (previewLines.length) {
      lines.push(...previewLines);
    }
    const previewText = lines.length ? lines.join('\n') : '';

    showBubbleAtRect(rect, {
      title: '划词对话',
      content: previewText,
      primaryText: '继续对话',
      secondaryText: '关闭',
      onPrimary: () => {
        enterThread(threadId);
        hideBubble(true);
      },
      onSecondary: () => hideBubble(true),
      pinned: true,
      type: 'pinned'
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

  function exitThread() {
    state.activeThreadId = null;
    state.activeAnchorMessageId = null;
    state.activeSelectionText = '';
    document.body.classList.remove('thread-mode-active');
    if (threadPanel) threadPanel.setAttribute('aria-hidden', 'true');
    if (threadContainer) threadContainer.innerHTML = '';
    updateThreadPanelTitle('');
    resetHiddenMessages();
    moveThreadPanelHome();
  }

  function isThreadModeActive() {
    return !!state.activeThreadId;
  }

  function handleSelectionMouseUp() {
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
    showPreviewBubbleForHighlight(target);
  }

  function handleHighlightMouseOut(event) {
    const target = event.target.closest('.thread-highlight');
    if (!target) return;
    if (state.bubblePinned) return;
    hideBubble();
  }

  function handleHighlightClick(event) {
    const target = event.target.closest('.thread-highlight');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    showPinnedBubbleForHighlight(target);
  }

  function handleDocumentClick(event) {
    if (!bubbleEl || bubbleEl.style.display === 'none') return;
    if (bubbleEl.contains(event.target)) return;
    if (event.target.closest('.thread-highlight')) return;
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
    if (threadExitButton) {
      threadExitButton.addEventListener('click', () => exitThread());
    }
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
