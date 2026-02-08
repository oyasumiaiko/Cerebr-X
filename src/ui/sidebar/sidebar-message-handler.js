// Lightweight handler for sidebar keyboard history navigation and injected commands
(() => {
  let clearChatButtonRef = null;

  function handleWindowMessage(event) {
    const message = event?.data;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'CLEAR_CHAT_COMMAND') {
      if (!clearChatButtonRef) {
        clearChatButtonRef = document.getElementById('clear-chat');
      }
      clearChatButtonRef?.click();
    }
  }

  window.addEventListener('message', handleWindowMessage);

  function init() {
    const chatLayout = document.getElementById('chat-layout');
    const chatContainer = document.getElementById('chat-container');
    const input = document.getElementById('message-input');
    clearChatButtonRef = document.getElementById('clear-chat');

    if (!chatLayout || !chatContainer || !input) return;

    const historyState = {
      items: [],
      pointer: 0,
      draft: '',
      inNavigation: false,
      applying: false
    };

    let rebuildTimer = null;
    let scrollbarRaf = null;
    let minimapRaf = null;
    let chatResizeObserver = null;
    let rootAttrObserver = null;
    let fontsDoneHandler = null;
    let minimapRoot = null;
    let minimapCanvas = null;
    let minimapThumb = null;
    let minimapNeedsMapRedraw = true;
    let minimapLastScrollHeight = 0;
    let minimapLastClientHeight = 0;
    let minimapLastMessageCount = 0;
    let minimapDragSession = null;

    const MINIMAP_WIDTH = 24;
    const MINIMAP_OUTER_GAP = 10;
    const MINIMAP_VERTICAL_GAP = 10;
    const MINIMAP_MIN_HEIGHT = 96;
    const MINIMAP_THUMB_MIN_HEIGHT = 28;

    // --- 阅读位置保持（宽度变化时） ---
    // 需求背景：侧栏宽度变化 / 切换全屏布局会导致消息重新换行，进而改变消息高度；
    // 若仅保留 scrollTop 数值，视口顶部会落到“另一段内容”上，产生明显的阅读跳动。
    //
    // 这里采用“阅读锚点”的方式：
    // - 捕获当前视口顶部所在的消息元素（消息 N）
    // - 记录视口顶部位于该消息内部的相对位置（例如 25%）
    // - 当可用宽度变化后，用相同的相对位置重新计算 scrollTop 并回填
    //
    // 说明：只在“影响换行宽度”的场景触发补偿（resize / 全屏切换 / padding 变化等），
    // 避免在流式渲染等高频 DOM 变动中引入额外开销。
    let readingAnchorRaf = null;
    let readingAnchorInfo = null;
    let lastWrapWidth = null;
    let lastObservedChatWidth = null;
    let pendingWrapWidthCompensation = false;
    let isRestoringReadingPosition = false;

    function clampNumber(value, min, max) {
      const v = Number(value);
      if (!Number.isFinite(v)) return min;
      return Math.min(max, Math.max(min, v));
    }

    function escapeMessageIdForSelector(id) {
      const raw = (id == null) ? '' : String(id);
      if (!raw) return '';
      try {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
          return CSS.escape(raw);
        }
      } catch (_) {}
      return raw.replace(/["\\]/g, '\\$&');
    }

    function findFirstVisibleMessageElement(container) {
      if (!container) return null;
      const children = container.children;
      const total = children ? children.length : 0;
      if (!total) return null;

      const viewportTop = container.scrollTop || 0;
      const EPS = 1;

      let low = 0;
      let high = total - 1;
      let firstIdx = total;

      while (low <= high) {
        const mid = (low + high) >> 1;
        const el = children[mid];
        const bottom = (el?.offsetTop || 0) + (el?.offsetHeight || 0);
        if (bottom <= viewportTop + EPS) {
          low = mid + 1;
        } else {
          firstIdx = mid;
          high = mid - 1;
        }
      }

      for (let i = firstIdx; i < total; i += 1) {
        const el = children[i];
        if (el && el.classList && el.classList.contains('message')) return el;
      }
      return null;
    }

    function captureReadingAnchor(container) {
      const anchorEl = findFirstVisibleMessageElement(container);
      if (!anchorEl) return null;

      const anchorId = anchorEl.getAttribute('data-message-id') || '';
      const anchorTop = anchorEl.offsetTop || 0;
      const anchorHeight = anchorEl.offsetHeight || 0;
      const viewportTop = container.scrollTop || 0;
      const offsetPx = viewportTop - anchorTop;

      // offsetPx 落在 [0, height] 内时，用“百分比”表达阅读位置；否则用像素兜底（例如刚好停在两条消息的 gap 中）。
      if (anchorHeight > 0 && offsetPx >= 0 && offsetPx <= anchorHeight) {
        const ratio = clampNumber(offsetPx / anchorHeight, 0, 1);
        return { anchorId, anchorEl, mode: 'ratio', ratio, offsetPx };
      }

      return { anchorId, anchorEl, mode: 'px', ratio: 0, offsetPx };
    }

    function resolveAnchorElement(container, anchorInfo) {
      if (!container || !anchorInfo) return null;
      const el = anchorInfo.anchorEl;
      if (el && typeof container.contains === 'function' && container.contains(el)) return el;
      const id = anchorInfo.anchorId || '';
      if (!id) return null;
      const safeId = escapeMessageIdForSelector(id);
      return container.querySelector(`.message[data-message-id="${safeId}"]`);
    }

    function measureChatWrapWidth(container) {
      if (!container) return 0;
      let paddingLeft = 0;
      let paddingRight = 0;
      try {
        const style = window.getComputedStyle(container);
        paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
        paddingRight = Number.parseFloat(style.paddingRight) || 0;
      } catch (_) {}
      const width = (container.clientWidth || 0) - paddingLeft - paddingRight;
      // 统一到整数像素，避免 sub-pixel 抖动导致反复触发补偿。
      return Math.max(0, Math.round(width));
    }

    function restoreReadingPosition(container, anchorInfo) {
      if (!container || !anchorInfo) return;
      const anchorEl = resolveAnchorElement(container, anchorInfo);
      if (!anchorEl) return;

      const baseTop = anchorEl.offsetTop || 0;
      const height = anchorEl.offsetHeight || 0;
      let targetScrollTop = baseTop;

      if (anchorInfo.mode === 'ratio' && height > 0) {
        targetScrollTop = baseTop + (Number(anchorInfo.ratio) || 0) * height;
      } else {
        targetScrollTop = baseTop + (Number(anchorInfo.offsetPx) || 0);
      }

      const maxScrollTop = Math.max(0, (container.scrollHeight || 0) - (container.clientHeight || 0));
      const clamped = clampNumber(targetScrollTop, 0, maxScrollTop);
      if (Math.abs((container.scrollTop || 0) - clamped) < 0.5) return;

      // 避免“程序性滚动”触发 scroll 监听后立刻覆盖掉我们刚恢复的锚点信息。
      isRestoringReadingPosition = true;
      container.scrollTop = clamped;
      requestAnimationFrame(() => {
        isRestoringReadingPosition = false;
        scheduleReadingAnchorCapture();
      });
    }

    function applyWrapWidthCompensationIfNeeded() {
      const currentWrapWidth = measureChatWrapWidth(chatContainer);
      if (lastWrapWidth == null) {
        lastWrapWidth = currentWrapWidth;
        return;
      }

      if (Math.abs(currentWrapWidth - lastWrapWidth) < 1) {
        lastWrapWidth = currentWrapWidth;
        return;
      }

      lastWrapWidth = currentWrapWidth;
      restoreReadingPosition(chatContainer, readingAnchorInfo);
    }

    function scheduleReadingAnchorCapture() {
      if (readingAnchorRaf) return;
      readingAnchorRaf = requestAnimationFrame(() => {
        readingAnchorRaf = null;
        if (isRestoringReadingPosition) return;
        readingAnchorInfo = captureReadingAnchor(chatContainer);
      });
    }

    function scheduleLayoutUpdate(options = {}) {
      const { checkWrapWidth = false } = options;
      if (checkWrapWidth) pendingWrapWidthCompensation = true;
      scheduleScrollbarUpdate();
      scheduleMinimapRender({ rebuildMap: true });
    }

    function isFullscreenLayoutActive() {
      return document.documentElement.classList.contains('fullscreen-mode')
        || document.body.classList.contains('standalone-mode');
    }

    function ensureMinimapElements() {
      if (minimapRoot && minimapCanvas && minimapThumb) return true;
      const root = document.createElement('div');
      root.id = 'chat-scroll-minimap';
      root.className = 'chat-scroll-minimap';
      root.setAttribute('aria-hidden', 'true');

      const canvas = document.createElement('canvas');
      canvas.className = 'chat-scroll-minimap__canvas';
      canvas.width = 1;
      canvas.height = 1;

      const thumb = document.createElement('div');
      thumb.className = 'chat-scroll-minimap__thumb';

      root.appendChild(canvas);
      root.appendChild(thumb);
      chatLayout.appendChild(root);

      root.addEventListener('pointerdown', handleMinimapPointerDown);
      thumb.addEventListener('pointerdown', handleMinimapThumbPointerDown);
      thumb.addEventListener('pointermove', handleMinimapThumbPointerMove);
      thumb.addEventListener('pointerup', finishMinimapThumbDrag);
      thumb.addEventListener('pointercancel', finishMinimapThumbDrag);
      thumb.addEventListener('lostpointercapture', finishMinimapThumbDrag);

      minimapRoot = root;
      minimapCanvas = canvas;
      minimapThumb = thumb;
      return true;
    }

    function collectDirectMessageElements() {
      const result = [];
      const children = chatContainer.children;
      const total = children ? children.length : 0;
      for (let i = 0; i < total; i += 1) {
        const el = children[i];
        if (el?.classList?.contains('message')) {
          result.push(el);
        }
      }
      return result;
    }

    function syncMinimapGeometry() {
      if (!minimapRoot) return { trackHeight: 0 };
      const layoutRect = chatLayout.getBoundingClientRect();
      const chatRect = chatContainer.getBoundingClientRect();
      let paddingLeft = 0;
      try {
        const style = window.getComputedStyle(chatContainer);
        paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
      } catch (_) {}

      // 关键：全屏非线程模式下，chatContainer 会通过较大的 padding-left 居中内容列。
      // 缩略图应锚定在“内容列左侧”，而不是容器左边缘，否则会在非线程模式下被挤出可见区域。
      const contentLeft = chatRect.left + paddingLeft;
      const availableLeft = contentLeft - layoutRect.left;
      const preferredLeft = availableLeft - MINIMAP_WIDTH - MINIMAP_OUTER_GAP;
      const fallbackLeft = (chatRect.left - layoutRect.left) + 4;
      const left = Math.round(Math.max(4, (preferredLeft >= 4 ? preferredLeft : fallbackLeft)));
      const top = Math.round(Math.max(0, chatRect.top - layoutRect.top + MINIMAP_VERTICAL_GAP));
      const height = Math.round(Math.max(MINIMAP_MIN_HEIGHT, chatRect.height - MINIMAP_VERTICAL_GAP * 2));

      minimapRoot.style.left = `${left}px`;
      minimapRoot.style.top = `${top}px`;
      minimapRoot.style.height = `${height}px`;
      return { trackHeight: height };
    }

    function drawMinimapOverview(messages, trackHeight, scrollHeight) {
      if (!minimapCanvas || !minimapRoot) return;
      const width = Math.max(1, minimapRoot.clientWidth);
      const height = Math.max(1, trackHeight);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const targetWidth = Math.max(1, Math.round(width * dpr));
      const targetHeight = Math.max(1, Math.round(height * dpr));

      if (minimapCanvas.width !== targetWidth || minimapCanvas.height !== targetHeight) {
        minimapCanvas.width = targetWidth;
        minimapCanvas.height = targetHeight;
      }

      const ctx = minimapCanvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const contentHeight = Math.max(1, scrollHeight);
      const innerPadding = 3;
      const innerWidth = Math.max(2, width - innerPadding * 2);

      for (const el of messages) {
        const topRatio = (el.offsetTop || 0) / contentHeight;
        const heightRatio = (el.offsetHeight || 0) / contentHeight;
        const y = Math.max(0, Math.floor(topRatio * height));
        const h = Math.max(1, Math.ceil(heightRatio * height));
        const isUser = el.classList.contains('user-message');
        const isError = el.classList.contains('error-message');
        const x = isUser ? innerPadding + 2 : innerPadding;
        const w = Math.max(2, innerWidth - (isUser ? 2 : 0));

        ctx.fillStyle = isError
          ? 'rgba(245, 87, 87, 0.78)'
          : (isUser ? 'rgba(98, 165, 255, 0.66)' : 'rgba(182, 182, 196, 0.52)');
        ctx.fillRect(x, y, w, h);
      }
    }

    function updateMinimapThumb(trackHeight, scrollHeight, clientHeight) {
      if (!minimapThumb) return;
      const safeTrackHeight = Math.max(1, trackHeight);
      const safeClientHeight = Math.max(0, clientHeight);
      const maxScroll = Math.max(0, scrollHeight - safeClientHeight);
      const thumbHeight = Math.max(
        MINIMAP_THUMB_MIN_HEIGHT,
        Math.round((safeClientHeight / Math.max(1, scrollHeight)) * safeTrackHeight)
      );
      const maxThumbTop = Math.max(0, safeTrackHeight - thumbHeight);
      const ratio = maxScroll > 0 ? (chatContainer.scrollTop || 0) / maxScroll : 0;
      const thumbTop = Math.round(maxThumbTop * clampNumber(ratio, 0, 1));

      minimapThumb.style.height = `${thumbHeight}px`;
      minimapThumb.style.transform = `translateY(${thumbTop}px)`;
      minimapThumb.dataset.maxThumbTop = String(maxThumbTop);
    }

    function setMinimapVisible(visible) {
      if (!minimapRoot) return;
      minimapRoot.classList.toggle('chat-scroll-minimap--active', !!visible);
      if (!visible) {
        minimapRoot.classList.remove('chat-scroll-minimap--dragging');
        minimapDragSession = null;
      }
    }

    function scrollChatFromMinimapClientY(clientY, options = {}) {
      if (!minimapRoot) return;
      const centerViewport = options.centerViewport !== false;
      const rect = minimapRoot.getBoundingClientRect();
      const y = clampNumber(clientY - rect.top, 0, Math.max(1, rect.height));
      const scrollHeight = chatContainer.scrollHeight || 0;
      const clientHeight = chatContainer.clientHeight || 0;
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      if (maxScroll <= 0) return;

      let target = (y / Math.max(1, rect.height)) * scrollHeight;
      if (centerViewport) {
        target -= clientHeight / 2;
      }
      chatContainer.scrollTop = clampNumber(target, 0, maxScroll);
    }

    function scrollChatByThumbTop(thumbTop) {
      if (!minimapRoot || !minimapThumb) return;
      const trackHeight = Math.max(1, minimapRoot.clientHeight || 0);
      const thumbHeight = Math.max(0, minimapThumb.offsetHeight || 0);
      const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
      const ratio = maxThumbTop > 0
        ? clampNumber(thumbTop / maxThumbTop, 0, 1)
        : 0;
      const maxScroll = Math.max(0, (chatContainer.scrollHeight || 0) - (chatContainer.clientHeight || 0));
      if (maxScroll <= 0) return;
      chatContainer.scrollTop = ratio * maxScroll;
    }

    function handleMinimapPointerDown(event) {
      if (!minimapRoot || !minimapRoot.classList.contains('chat-scroll-minimap--active')) return;
      if (event.button !== 0) return;
      if (event.target === minimapThumb) return;
      event.preventDefault();
      scrollChatFromMinimapClientY(event.clientY, { centerViewport: true });
      scheduleReadingAnchorCapture();
      scheduleMinimapRender();
    }

    function handleMinimapThumbPointerDown(event) {
      if (!minimapRoot || !minimapThumb || !minimapRoot.classList.contains('chat-scroll-minimap--active')) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const thumbRect = minimapThumb.getBoundingClientRect();
      minimapDragSession = {
        pointerId: event.pointerId,
        offsetY: event.clientY - thumbRect.top
      };
      minimapRoot.classList.add('chat-scroll-minimap--dragging');
      try {
        minimapThumb.setPointerCapture(event.pointerId);
      } catch (_) {}
    }

    function handleMinimapThumbPointerMove(event) {
      if (!minimapRoot || !minimapThumb || !minimapDragSession) return;
      if (event.pointerId !== minimapDragSession.pointerId) return;
      event.preventDefault();
      const rootRect = minimapRoot.getBoundingClientRect();
      const thumbHeight = Math.max(0, minimapThumb.offsetHeight || 0);
      const maxTop = Math.max(0, rootRect.height - thumbHeight);
      const rawTop = event.clientY - rootRect.top - minimapDragSession.offsetY;
      const clampedTop = clampNumber(rawTop, 0, maxTop);
      scrollChatByThumbTop(clampedTop);
      scheduleReadingAnchorCapture();
      scheduleMinimapRender();
    }

    function finishMinimapThumbDrag(event) {
      if (!minimapRoot || !minimapThumb || !minimapDragSession) return;
      if (event && event.pointerId != null && event.pointerId !== minimapDragSession.pointerId) return;
      minimapDragSession = null;
      minimapRoot.classList.remove('chat-scroll-minimap--dragging');
      if (event && event.pointerId != null) {
        try {
          minimapThumb.releasePointerCapture(event.pointerId);
        } catch (_) {}
      }
    }

    function renderMinimap() {
      if (!ensureMinimapElements()) return;
      const isFullscreen = isFullscreenLayoutActive();
      const { trackHeight } = syncMinimapGeometry();
      const messages = collectDirectMessageElements();
      const messageCount = messages.length;
      const scrollHeight = Math.max(0, chatContainer.scrollHeight || 0);
      const clientHeight = Math.max(0, chatContainer.clientHeight || 0);
      const hasOverflow = scrollHeight > clientHeight + 1;
      const shouldShow = isFullscreen && hasOverflow && messageCount > 0 && trackHeight >= MINIMAP_MIN_HEIGHT;
      setMinimapVisible(shouldShow);
      if (!shouldShow) return;

      const metricsChanged = scrollHeight !== minimapLastScrollHeight
        || clientHeight !== minimapLastClientHeight
        || messageCount !== minimapLastMessageCount;
      if (metricsChanged) minimapNeedsMapRedraw = true;

      if (minimapNeedsMapRedraw) {
        drawMinimapOverview(messages, trackHeight, scrollHeight);
        minimapNeedsMapRedraw = false;
        minimapLastScrollHeight = scrollHeight;
        minimapLastClientHeight = clientHeight;
        minimapLastMessageCount = messageCount;
      }

      updateMinimapThumb(trackHeight, scrollHeight, clientHeight);
    }

    function scheduleMinimapRender(options = {}) {
      if (options.rebuildMap) minimapNeedsMapRedraw = true;
      if (minimapRaf) return;
      minimapRaf = requestAnimationFrame(() => {
        minimapRaf = null;
        renderMinimap();
      });
    }

    function resetNavigation(options = {}) {
      const { preserveDraft = true } = options;
      historyState.inNavigation = false;
      historyState.pointer = historyState.items.length;
      historyState.draft = preserveDraft ? (input.textContent || '') : '';
    }

    function rebuildHistory() {
      const nodes = chatContainer.querySelectorAll('.message.user-message');
      historyState.items = Array.from(nodes, (node) => {
        const text = node.getAttribute('data-original-text') || node.textContent || '';
        return {
          id: node.getAttribute('data-message-id') || '',
          text
        };
      }).filter((item) => item.text.trim().length > 0);
      resetNavigation();
      updateEmptyStateClass();
    }

    function updateEmptyStateClass() {
      const hasMessage = !!chatContainer.querySelector('.message');
      document.body.classList.toggle('chat-empty', !hasMessage);
    }

    function scheduleHistoryRebuild() {
      if (rebuildTimer) return;
      rebuildTimer = setTimeout(() => {
        rebuildTimer = null;
        rebuildHistory();
      }, 0);
    }

    function updateScrollbarPadding() {
      // 说明：不要用 scrollHeight/clientHeight 来推断“是否需要滚动条”。
      // - 流式渲染/图片加载/字体加载/输入框高度变化等都会在不同时间点触发布局更新；
      // - 直接用 offsetWidth - clientWidth 可以拿到「滚动条/滚动条槽(gutter)」实际占用的像素宽度；
      // - 即使启用了 scrollbar-gutter: stable（滚动条槽可能常驻），这里也能给出稳定值，避免右侧留白偶发不对齐。
      const scrollbarWidth = Math.max(0, chatContainer.offsetWidth - chatContainer.clientWidth);
      let didChange = false;

      if (scrollbarWidth <= 0) {
        if (chatContainer.classList.contains('has-scrollbar')) {
          chatContainer.classList.remove('has-scrollbar');
          didChange = true;
        }
        if (chatContainer.style.getPropertyValue('--scrollbar-width')) {
          chatContainer.style.removeProperty('--scrollbar-width');
          didChange = true;
        }
        return didChange;
      }

      if (!chatContainer.classList.contains('has-scrollbar')) {
        chatContainer.classList.add('has-scrollbar');
        didChange = true;
      }
      const scrollbarWidthPx = `${scrollbarWidth}px`;
      if (chatContainer.style.getPropertyValue('--scrollbar-width') !== scrollbarWidthPx) {
        chatContainer.style.setProperty('--scrollbar-width', scrollbarWidthPx);
        didChange = true;
      }
      return didChange;
    }

    function scheduleScrollbarUpdate() {
      if (scrollbarRaf) return;
      scrollbarRaf = requestAnimationFrame(() => {
        scrollbarRaf = null;
        const scrollbarPaddingChanged = updateScrollbarPadding();
        const shouldCompensate = pendingWrapWidthCompensation || scrollbarPaddingChanged;
        pendingWrapWidthCompensation = false;
        if (shouldCompensate) applyWrapWidthCompensationIfNeeded();
        scheduleMinimapRender({ rebuildMap: true });
      });
    }

    function placeCaretAtEnd(element) {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function applyInputValue(value) {
      historyState.applying = true;
      input.textContent = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      placeCaretAtEnd(input);
      historyState.applying = false;
    }

    function handleContentLoad(event) {
      const target = event?.target;
      if (!target || target === chatContainer) return;

      // 图片/视频等资源加载完成会改变消息高度，但不会触发 MutationObserver。
      // 用捕获阶段监听 load 来兜底，确保滚动条占位变化时右侧 padding 能及时同步。
      const tagName = String(target.tagName || '').toUpperCase();
      if (tagName === 'IMG' || tagName === 'VIDEO' || tagName === 'IFRAME') {
        scheduleLayoutUpdate();
      }
    }

    function ensureNavigationSession() {
      if (historyState.inNavigation) return;
      historyState.draft = input.textContent || '';
      historyState.pointer = historyState.items.length;
      historyState.inNavigation = true;
    }

    function navigateHistory(direction) {
      if (!historyState.items.length) return;

      ensureNavigationSession();

      if (direction < 0 && historyState.pointer === 0) return;
      if (direction > 0 && historyState.pointer === historyState.items.length) {
        historyState.inNavigation = false;
        return;
      }

      const nextIndex = Math.min(
        Math.max(historyState.pointer + direction, 0),
        historyState.items.length
      );
      historyState.pointer = nextIndex;

      if (historyState.pointer === historyState.items.length) {
        applyInputValue(historyState.draft);
        historyState.inNavigation = false;
        return;
      }

      const entry = historyState.items[historyState.pointer];
      applyInputValue(entry.text);
    }

    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;

      if (event.key === 'ArrowUp') {
        if (!historyState.items.length) return;
        if (!historyState.inNavigation && input.textContent.trim().length > 0) return;
        event.preventDefault();
        navigateHistory(-1);
      } else if (event.key === 'ArrowDown') {
        if (!historyState.inNavigation) return;
        event.preventDefault();
        navigateHistory(1);
      }
    });

    input.addEventListener('input', () => {
      if (!historyState.applying) {
        resetNavigation();
      }
    });

    const observer = new MutationObserver((mutations) => {
      let shouldRefresh = false;
      let shouldUpdateScrollbar = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // 仅当 chatContainer 的直接子节点增删时才需要重建“用户输入历史”。
          // 流式渲染等会在消息内部产生大量 DOM 变化，不应触发重建。
          if (mutation.target === chatContainer && (mutation.addedNodes.length || mutation.removedNodes.length)) {
            shouldRefresh = true;
          }
          if (mutation.addedNodes.length || mutation.removedNodes.length) {
            shouldUpdateScrollbar = true;
          }
        } else if (mutation.type === 'characterData') {
          // 流式拼接文本可能只改动 textNode.data
          shouldUpdateScrollbar = true;
        } else if (mutation.type === 'attributes') {
          // class/style 切换（例如展开/收起）也可能改变内容高度，从而影响滚动条占位
          shouldUpdateScrollbar = true;
        }

        if (shouldRefresh && shouldUpdateScrollbar) {
          break;
        }
      }

      if (shouldRefresh) scheduleHistoryRebuild();
      if (shouldUpdateScrollbar) scheduleLayoutUpdate();
    });

    observer.observe(chatContainer, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });

    rebuildHistory();
    updateScrollbarPadding();
    scheduleMinimapRender({ rebuildMap: true });
    // 初始化锚点：确保第一次触发“宽度变化补偿”时已有可用的阅读位置基准。
    readingAnchorInfo = captureReadingAnchor(chatContainer);
    lastWrapWidth = measureChatWrapWidth(chatContainer);
    // 用户滚动时更新锚点；用 rAF 去抖，避免频繁 layout 查询。
    function handleChatScroll() {
      scheduleReadingAnchorCapture();
      scheduleMinimapRender();
    }
    chatContainer.addEventListener('scroll', handleChatScroll, { passive: true });

    function handleWindowResize() {
      scheduleLayoutUpdate({ checkWrapWidth: true });
    }
    window.addEventListener('resize', handleWindowResize);

    // chatContainer 的可视尺寸变化（常见于输入框高度变化、切换全屏布局等）不会触发 window.resize
    // 用 ResizeObserver 兜底，确保 padding-right 始终跟随滚动条占位宽度。
    try {
      chatResizeObserver = new ResizeObserver((entries) => {
        // 说明：ResizeObserver 可能因高度变化（输入框变高等）频繁触发。
        // 为避免每次都做“阅读位置补偿”的测量，只有在宽度确实变化时才启用补偿检查。
        let nextWidth = null;
        try {
          const entry = entries && entries[0];
          const w = entry?.contentRect?.width;
          if (Number.isFinite(w)) nextWidth = Math.round(w);
        } catch (_) {}
        if (nextWidth == null) nextWidth = Math.round(chatContainer.clientWidth || 0);

        const widthChanged = (lastObservedChatWidth != null) && nextWidth !== lastObservedChatWidth;
        lastObservedChatWidth = nextWidth;
        scheduleLayoutUpdate({ checkWrapWidth: widthChanged });
      });
      try {
        chatResizeObserver.observe(chatContainer, { box: 'border-box' });
      } catch (_) {
        chatResizeObserver.observe(chatContainer);
      }
    } catch (e) {
      // ResizeObserver 不可用时，至少保证原有 resize + MutationObserver 路径可用
      chatResizeObserver = null;
    }

    // 监听 <img> 等资源加载完成（load 不冒泡，需 capture）
    chatContainer.addEventListener('load', handleContentLoad, true);

    // 监听主题/全屏等通过切换根节点 class/style 引起的布局变化
    try {
      rootAttrObserver = new MutationObserver(() => scheduleLayoutUpdate({ checkWrapWidth: true }));
      if (document.documentElement) {
        rootAttrObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
      }
      if (document.body) {
        rootAttrObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
      }
    } catch (e) {
      rootAttrObserver = null;
    }

    // 字体加载完成后可能导致消息高度发生变化（尤其是 KaTeX/代码高亮字体），需要刷新一次滚动条占位。
    if (document.fonts) {
      try {
        document.fonts.ready.then(() => scheduleLayoutUpdate()).catch(() => {});
        if (typeof document.fonts.addEventListener === 'function') {
          fontsDoneHandler = () => scheduleLayoutUpdate();
          document.fonts.addEventListener('loadingdone', fontsDoneHandler);
          document.fonts.addEventListener('loadingerror', fontsDoneHandler);
        }
      } catch (_) {}
    }

    if (clearChatButtonRef) {
      clearChatButtonRef.addEventListener('click', () => {
        historyState.items = [];
        resetNavigation({ preserveDraft: false });
        scheduleLayoutUpdate({ checkWrapWidth: true });
      });
    }

    window.addEventListener('beforeunload', () => {
      observer.disconnect();
      if (chatResizeObserver) {
        try {
          chatResizeObserver.disconnect();
        } catch (_) {}
        chatResizeObserver = null;
      }
      if (rootAttrObserver) {
        try {
          rootAttrObserver.disconnect();
        } catch (_) {}
        rootAttrObserver = null;
      }
      if (document.fonts && fontsDoneHandler && typeof document.fonts.removeEventListener === 'function') {
        try {
          document.fonts.removeEventListener('loadingdone', fontsDoneHandler);
          document.fonts.removeEventListener('loadingerror', fontsDoneHandler);
        } catch (_) {}
        fontsDoneHandler = null;
      }
      chatContainer.removeEventListener('load', handleContentLoad, true);
      chatContainer.removeEventListener('scroll', handleChatScroll);
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
      }
      if (scrollbarRaf) {
        cancelAnimationFrame(scrollbarRaf);
        scrollbarRaf = null;
      }
      if (readingAnchorRaf) {
        cancelAnimationFrame(readingAnchorRaf);
        readingAnchorRaf = null;
      }
      if (minimapRaf) {
        cancelAnimationFrame(minimapRaf);
        minimapRaf = null;
      }
      if (minimapRoot) {
        try {
          minimapRoot.remove();
        } catch (_) {}
        minimapRoot = null;
        minimapCanvas = null;
        minimapThumb = null;
      }
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('message', handleWindowMessage);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
