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
    const threadContainer = document.getElementById('thread-container');
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
    let threadResizeObserver = null;
    let threadObserver = null;
    let rootAttrObserver = null;
    let fontsDoneHandler = null;
    const minimapStates = [];

    const MINIMAP_WIDTH = 24;
    const MINIMAP_OUTER_GAP = 10;
    const MINIMAP_VERTICAL_GAP = 10;
    const MINIMAP_MIN_HEIGHT = 96;
    const MINIMAP_THUMB_MIN_HEIGHT = 28;
    const MINIMAP_MESSAGE_MODE_PROPORTIONAL = 'proportional';
    const MINIMAP_MESSAGE_MODE_FIXED = 'fixed';
    const MINIMAP_WHEEL_STEP_PX = 56;
    const MINIMAP_WHEEL_IDLE_RESET_MS = 180;

    function createMinimapState(key, container, side) {
      if (!container) return null;
      return {
        key,
        side, // 'left' | 'right'
        container,
        root: null,
        canvas: null,
        thumb: null,
        needsMapRedraw: true,
        lastScrollHeight: 0,
        lastClientHeight: 0,
        lastMessageCount: 0,
        lastMessageMode: MINIMAP_MESSAGE_MODE_PROPORTIONAL,
        dragSession: null,
        renderContext: null,
        wheelDeltaAccumulator: 0,
        wheelResetTimer: null
      };
    }

    const chatMinimapState = createMinimapState('chat', chatContainer, 'left');
    if (chatMinimapState) minimapStates.push(chatMinimapState);
    const threadMinimapState = createMinimapState('thread', threadContainer, 'right');
    if (threadMinimapState) minimapStates.push(threadMinimapState);

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

    function readRootCssNumericVar(name, fallback) {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed)) return parsed;
      } catch (_) {}
      return fallback;
    }

    function readRootCssStringVar(name, fallback = '') {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
        const normalized = String(raw || '').trim();
        if (normalized) return normalized;
      } catch (_) {}
      return fallback;
    }

    function isMinimapFeatureEnabled() {
      return readRootCssNumericVar('--cerebr-scroll-minimap-enabled', 1) > 0.5;
    }

    function getConfiguredMinimapWidth() {
      const width = readRootCssNumericVar('--cerebr-scroll-minimap-width', MINIMAP_WIDTH);
      return Math.round(clampNumber(width, 12, 100));
    }

    function isMinimapAutoHideEnabled() {
      return readRootCssNumericVar('--cerebr-scroll-minimap-autohide', 0) > 0.5;
    }

    function getMinimapMessageDisplayMode() {
      const mode = readRootCssStringVar('--cerebr-scroll-minimap-message-mode', MINIMAP_MESSAGE_MODE_PROPORTIONAL)
        .toLowerCase();
      return mode === MINIMAP_MESSAGE_MODE_FIXED
        ? MINIMAP_MESSAGE_MODE_FIXED
        : MINIMAP_MESSAGE_MODE_PROPORTIONAL;
    }

    function isThreadModeActive() {
      return document.body.classList.contains('thread-mode-active');
    }

    function ensureMinimapElements(state) {
      if (!state) return false;
      if (state.root && state.canvas && state.thumb) return true;

      const root = document.createElement('div');
      root.id = `chat-scroll-minimap-${state.key}`;
      root.className = `chat-scroll-minimap chat-scroll-minimap--${state.key} chat-scroll-minimap--${state.side}`;
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

      root.addEventListener('pointerdown', (event) => handleMinimapPointerDown(state, event));
      root.addEventListener('wheel', (event) => handleMinimapWheel(state, event), { passive: false });
      thumb.addEventListener('pointerdown', (event) => handleMinimapThumbPointerDown(state, event));
      thumb.addEventListener('pointermove', (event) => handleMinimapThumbPointerMove(state, event));
      thumb.addEventListener('pointerup', (event) => finishMinimapThumbDrag(state, event));
      thumb.addEventListener('pointercancel', (event) => finishMinimapThumbDrag(state, event));
      thumb.addEventListener('lostpointercapture', (event) => finishMinimapThumbDrag(state, event));

      state.root = root;
      state.canvas = canvas;
      state.thumb = thumb;
      return true;
    }

    function collectDirectMessageElements(container) {
      const result = [];
      if (!container) return result;
      const children = container.children;
      const total = children ? children.length : 0;
      for (let i = 0; i < total; i += 1) {
        const el = children[i];
        if (el?.classList?.contains('message')) {
          result.push(el);
        }
      }
      return result;
    }

    function buildMinimapRenderContext(messages, scrollHeight, clientHeight, messageDisplayMode) {
      const safeScrollHeight = Math.max(1, Number(scrollHeight) || 0);
      const safeClientHeight = Math.max(0, Number(clientHeight) || 0);
      const mode = messageDisplayMode === MINIMAP_MESSAGE_MODE_FIXED
        ? MINIMAP_MESSAGE_MODE_FIXED
        : MINIMAP_MESSAGE_MODE_PROPORTIONAL;
      const messageLayout = [];
      for (const el of messages) {
        if (!el) continue;
        const top = Math.max(0, Number(el.offsetTop) || 0);
        const height = Math.max(1, Number(el.offsetHeight) || 0);
        messageLayout.push({
          top,
          height,
          bottom: top + height
        });
      }
      return {
        mode,
        scrollHeight: safeScrollHeight,
        clientHeight: safeClientHeight,
        maxScroll: Math.max(0, safeScrollHeight - safeClientHeight),
        messageLayout,
        messageCount: messageLayout.length
      };
    }

    function resolveProgressFromContentOffset(context, offset) {
      if (!context) return 0;
      const safeOffset = clampNumber(offset, 0, context.scrollHeight);
      if (context.mode !== MINIMAP_MESSAGE_MODE_FIXED || context.messageCount <= 0) {
        return clampNumber(safeOffset / Math.max(1, context.scrollHeight), 0, 1);
      }

      const items = context.messageLayout;
      const total = context.messageCount;
      const first = items[0];
      const last = items[total - 1];
      if (!first || !last) return 0;
      if (safeOffset <= first.top) return 0;
      if (safeOffset >= last.bottom) return 1;

      let low = 0;
      let high = total - 1;
      let idx = total - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (items[mid].bottom <= safeOffset) {
          low = mid + 1;
        } else {
          idx = mid;
          high = mid - 1;
        }
      }

      const current = items[idx];
      if (!current) return 0;
      if (safeOffset < current.top && idx > 0) {
        // 落在两条消息之间的间隙时，归入上一条消息末尾，避免拖拽时跳变。
        return clampNumber(idx / total, 0, 1);
      }

      const inMessageRatio = clampNumber(
        (safeOffset - current.top) / Math.max(1, current.height),
        0,
        1
      );
      return clampNumber((idx + inMessageRatio) / total, 0, 1);
    }

    function resolveContentOffsetFromProgress(context, progress) {
      if (!context) return 0;
      const safeProgress = clampNumber(progress, 0, 1);
      if (context.mode !== MINIMAP_MESSAGE_MODE_FIXED || context.messageCount <= 0) {
        return safeProgress * context.scrollHeight;
      }

      const total = context.messageCount;
      const scaled = safeProgress * total;
      let idx = Math.floor(scaled);
      let ratio = scaled - idx;
      if (idx >= total) {
        idx = total - 1;
        ratio = 1;
      }
      const current = context.messageLayout[idx];
      if (!current) return safeProgress * context.scrollHeight;
      return clampNumber(
        current.top + ratio * Math.max(1, current.height),
        0,
        context.scrollHeight
      );
    }

    function resolveScrollTopFromProgress(context, progress, options = {}) {
      if (!context) return 0;
      const centerViewport = options.centerViewport === true;
      const contentOffset = resolveContentOffsetFromProgress(context, progress);
      const target = centerViewport
        ? (contentOffset - context.clientHeight / 2)
        : contentOffset;
      return clampNumber(target, 0, context.maxScroll);
    }

    function resolveViewportProgressRange(context, scrollTop) {
      if (!context) {
        return {
          topProgress: 0,
          visibleSpan: 1
        };
      }
      const safeTop = clampNumber(scrollTop, 0, context.maxScroll);
      const viewportBottom = safeTop + context.clientHeight;
      const topProgress = resolveProgressFromContentOffset(context, safeTop);
      const bottomProgress = resolveProgressFromContentOffset(context, viewportBottom);
      let visibleSpan = Math.max(0, bottomProgress - topProgress);

      if (visibleSpan <= 0 && context.mode === MINIMAP_MESSAGE_MODE_FIXED && context.messageCount > 0) {
        let visibleMessageCount = 0;
        const items = context.messageLayout;
        for (const item of items) {
          if (!item) continue;
          if (item.bottom > safeTop && item.top < viewportBottom) {
            visibleMessageCount += 1;
          }
        }
        if (visibleMessageCount > 0) {
          visibleSpan = visibleMessageCount / context.messageCount;
        }
      }

      if (visibleSpan <= 0) {
        visibleSpan = context.clientHeight / Math.max(1, context.scrollHeight);
      }

      return {
        topProgress: clampNumber(topProgress, 0, 1),
        visibleSpan: clampNumber(visibleSpan, 0, 1)
      };
    }

    function syncMinimapGeometry(state, minimapWidth) {
      if (!state?.root || !state?.container) return { trackHeight: 0 };
      const layoutRect = chatLayout.getBoundingClientRect();
      const containerRect = state.container.getBoundingClientRect();
      let paddingLeft = 0;
      let paddingRight = 0;
      try {
        const style = window.getComputedStyle(state.container);
        paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
        paddingRight = Number.parseFloat(style.paddingRight) || 0;
      } catch (_) {}

      const minLeft = 4;
      const maxLeft = Math.max(minLeft, layoutRect.width - minimapWidth - 4);
      let left = minLeft;
      if (state.side === 'right') {
        const contentRight = containerRect.right - paddingRight;
        const preferredLeft = (contentRight - layoutRect.left) + MINIMAP_OUTER_GAP;
        left = Math.round(clampNumber(preferredLeft, minLeft, maxLeft));
      } else {
        // 左侧缩略图锚定在“内容列左边界”，确保全屏单列（大内边距）下不会跑出可视区域。
        const contentLeft = containerRect.left + paddingLeft;
        const preferredLeft = (contentLeft - layoutRect.left) - minimapWidth - MINIMAP_OUTER_GAP;
        const fallbackLeft = (containerRect.left - layoutRect.left) + 4;
        left = Math.round(clampNumber((preferredLeft >= minLeft ? preferredLeft : fallbackLeft), minLeft, maxLeft));
      }
      const top = Math.round(Math.max(0, containerRect.top - layoutRect.top + MINIMAP_VERTICAL_GAP));
      const height = Math.round(Math.max(MINIMAP_MIN_HEIGHT, containerRect.height - MINIMAP_VERTICAL_GAP * 2));

      state.root.style.width = `${minimapWidth}px`;
      state.root.style.left = `${left}px`;
      state.root.style.top = `${top}px`;
      state.root.style.height = `${height}px`;
      return { trackHeight: height };
    }

    function drawMinimapOverview(state, messages, trackHeight, scrollHeight, messageDisplayMode) {
      if (!state?.canvas || !state?.root) return;
      const width = Math.max(1, state.root.clientWidth);
      const height = Math.max(1, trackHeight);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const targetWidth = Math.max(1, Math.round(width * dpr));
      const targetHeight = Math.max(1, Math.round(height * dpr));

      if (state.canvas.width !== targetWidth || state.canvas.height !== targetHeight) {
        state.canvas.width = targetWidth;
        state.canvas.height = targetHeight;
      }

      const ctx = state.canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const contentHeight = Math.max(1, scrollHeight);
      const innerPadding = 3;
      const innerWidth = Math.max(2, width - innerPadding * 2);
      const useFixedMessageHeight = messageDisplayMode === MINIMAP_MESSAGE_MODE_FIXED;
      const safeMessageCount = Math.max(1, messages.length);
      const messageGap = 1;
      const messageCornerRadius = 2;
      let previousBarBottom = -messageGap;

      function fillRoundedRect(x, y, w, h, radius) {
        const safeRadius = Math.max(0, Math.min(radius, w / 2, h / 2));
        if (safeRadius < 0.5) {
          ctx.fillRect(x, y, w, h);
          return;
        }
        if (typeof ctx.roundRect === 'function') {
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, safeRadius);
          ctx.fill();
          return;
        }
        // 兼容 roundRect 不可用的环境，手动构造圆角路径。
        ctx.beginPath();
        ctx.moveTo(x + safeRadius, y);
        ctx.lineTo(x + w - safeRadius, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + safeRadius);
        ctx.lineTo(x + w, y + h - safeRadius);
        ctx.quadraticCurveTo(x + w, y + h, x + w - safeRadius, y + h);
        ctx.lineTo(x + safeRadius, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - safeRadius);
        ctx.lineTo(x, y + safeRadius);
        ctx.quadraticCurveTo(x, y, x + safeRadius, y);
        ctx.closePath();
        ctx.fill();
      }

      for (let index = 0; index < messages.length; index += 1) {
        const el = messages[index];
        let y = 0;
        let h = 1;
        if (useFixedMessageHeight) {
          // 固定消息高度模式：先分配等长槽位，随后统一走“间距+圆角”规则。
          const slotTop = Math.floor((index / safeMessageCount) * height);
          const slotBottom = Math.ceil(((index + 1) / safeMessageCount) * height);
          y = Math.max(0, Math.min(height - 1, slotTop));
          h = Math.max(1, slotBottom - slotTop);
        } else {
          const topRatio = (el.offsetTop || 0) / contentHeight;
          const heightRatio = (el.offsetHeight || 0) / contentHeight;
          y = Math.max(0, Math.floor(topRatio * height));
          h = Math.max(1, Math.ceil(heightRatio * height));
        }
        const isUser = el.classList.contains('user-message');
        const isError = el.classList.contains('error-message');
        // 消息块不再通过左右缩进区分角色，只用颜色区分，避免画面左右节奏过于杂乱。
        const x = innerPadding;
        const w = innerWidth;

        // 统一加 1px 竖向间距，确保连续同类型消息也有分界。
        if (index > 0) {
          const minTop = previousBarBottom + messageGap;
          if (y < minTop) y = minTop;
        }
        if (y >= height) break;
        h = Math.max(1, Math.min(height - y, h));

        ctx.fillStyle = isError
          ? 'rgba(245, 87, 87, 0.78)'
          : (isUser ? 'rgba(98, 165, 255, 0.66)' : 'rgba(182, 182, 196, 0.52)');
        const radius = Math.min(messageCornerRadius, Math.floor((Math.min(w, h) - 1) / 2));
        fillRoundedRect(x, y, w, h, radius);
        previousBarBottom = y + h;
      }
    }

    function updateMinimapThumb(state, trackHeight, renderContext) {
      if (!state?.thumb) return;
      const safeTrackHeight = Math.max(1, trackHeight);
      const context = renderContext || state.renderContext;
      const scrollTop = state.container?.scrollTop || 0;
      const range = resolveViewportProgressRange(context, scrollTop);
      const visibleSpan = clampNumber(range.visibleSpan, 0, 1);
      const rawThumbHeight = Math.max(
        MINIMAP_THUMB_MIN_HEIGHT,
        Math.round(visibleSpan * safeTrackHeight)
      );
      const thumbHeight = Math.min(safeTrackHeight, rawThumbHeight);
      const maxThumbTop = Math.max(0, safeTrackHeight - thumbHeight);
      const maxTopProgress = Math.max(0, 1 - visibleSpan);
      const normalizedTop = maxTopProgress > 0
        ? clampNumber(range.topProgress / maxTopProgress, 0, 1)
        : 0;
      const thumbTop = Math.round(maxThumbTop * normalizedTop);

      state.thumb.style.height = `${thumbHeight}px`;
      state.thumb.style.transform = `translateY(${thumbTop}px)`;
      state.thumb.dataset.maxThumbTop = String(maxThumbTop);
      state.thumb.dataset.viewportSpan = String(visibleSpan);
    }

    function setMinimapVisible(state, visible) {
      if (!state?.root) return;
      state.root.classList.toggle('chat-scroll-minimap--active', !!visible);
      if (!visible) {
        state.root.classList.remove('chat-scroll-minimap--dragging');
        state.dragSession = null;
        state.renderContext = null;
        resetMinimapWheelAccumulator(state);
      }
    }

    function scrollContainerFromMinimapClientY(state, clientY, options = {}) {
      if (!state?.root || !state?.container) return;
      const centerViewport = options.centerViewport !== false;
      const rect = state.root.getBoundingClientRect();
      const y = clampNumber(clientY - rect.top, 0, Math.max(1, rect.height));
      const progress = clampNumber(y / Math.max(1, rect.height), 0, 1);
      const context = state.renderContext;
      if (context && context.maxScroll > 0) {
        state.container.scrollTop = resolveScrollTopFromProgress(context, progress, { centerViewport });
        return;
      }

      const scrollHeight = state.container.scrollHeight || 0;
      const clientHeight = state.container.clientHeight || 0;
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      if (maxScroll <= 0) return;
      let target = progress * scrollHeight;
      if (centerViewport) target -= clientHeight / 2;
      state.container.scrollTop = clampNumber(target, 0, maxScroll);
    }

    function scrollContainerByThumbTop(state, thumbTop) {
      if (!state?.root || !state?.thumb || !state?.container) return;
      const trackHeight = Math.max(1, state.root.clientHeight || 0);
      const thumbHeight = Math.max(0, state.thumb.offsetHeight || 0);
      const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
      const ratio = maxThumbTop > 0
        ? clampNumber(thumbTop / maxThumbTop, 0, 1)
        : 0;
      const context = state.renderContext;
      if (context && context.maxScroll > 0) {
        const viewportSpan = clampNumber(Number.parseFloat(state.thumb.dataset.viewportSpan), 0, 1);
        const maxTopProgress = Math.max(0, 1 - viewportSpan);
        const topProgress = ratio * maxTopProgress;
        state.container.scrollTop = resolveScrollTopFromProgress(context, topProgress, { centerViewport: false });
        return;
      }

      const maxScroll = Math.max(0, (state.container.scrollHeight || 0) - (state.container.clientHeight || 0));
      if (maxScroll <= 0) return;
      state.container.scrollTop = ratio * maxScroll;
    }

    function normalizeWheelDeltaToPixels(event, pageSize) {
      const mode = Number(event?.deltaMode) || 0;
      const rawDelta = Number(event?.deltaY) || 0;
      if (mode === 1) return rawDelta * 16;
      if (mode === 2) return rawDelta * Math.max(1, pageSize);
      return rawDelta;
    }

    function findFirstVisibleMessageLayoutIndex(layout, scrollTop) {
      if (!Array.isArray(layout) || layout.length === 0) return -1;
      const targetTop = Math.max(0, Number(scrollTop) || 0);
      let low = 0;
      let high = layout.length - 1;
      let answer = layout.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const item = layout[mid];
        if ((item?.bottom || 0) <= targetTop + 1) {
          low = mid + 1;
        } else {
          answer = mid;
          high = mid - 1;
        }
      }
      return clampNumber(answer, 0, layout.length - 1);
    }

    function scrollContainerByMessageStep(state, stepCount) {
      if (!state?.container) return;
      const context = state.renderContext;
      const layout = context?.messageLayout;
      const total = context?.messageCount || 0;
      if (!Array.isArray(layout) || total <= 0 || !Number.isFinite(stepCount) || stepCount === 0) return;

      const currentTop = Math.max(0, state.container.scrollTop || 0);
      const currentIdx = findFirstVisibleMessageLayoutIndex(layout, currentTop);
      if (currentIdx < 0) return;

      let targetIdx = currentIdx + stepCount;
      if (stepCount < 0 && currentTop > (layout[currentIdx]?.top || 0) + 1) {
        // 向上滚动时，若当前视口落在消息中间，先对齐到当前消息顶部，再继续按消息步进。
        targetIdx += 1;
      }
      targetIdx = clampNumber(targetIdx, 0, total - 1);

      const rawTargetTop = layout[targetIdx]?.top || 0;
      const maxScroll = Math.max(0, context?.maxScroll || 0);
      const targetTop = clampNumber(rawTargetTop, 0, maxScroll);

      try {
        state.container.scrollTo({
          top: targetTop,
          behavior: 'smooth'
        });
      } catch (_) {
        state.container.scrollTop = targetTop;
      }
    }

    function resetMinimapWheelAccumulator(state) {
      if (!state) return;
      state.wheelDeltaAccumulator = 0;
      if (state.wheelResetTimer) {
        clearTimeout(state.wheelResetTimer);
        state.wheelResetTimer = null;
      }
    }

    function scheduleMinimapWheelAccumulatorReset(state) {
      if (!state) return;
      if (state.wheelResetTimer) clearTimeout(state.wheelResetTimer);
      state.wheelResetTimer = setTimeout(() => {
        state.wheelResetTimer = null;
        state.wheelDeltaAccumulator = 0;
      }, MINIMAP_WHEEL_IDLE_RESET_MS);
    }

    function handleMinimapWheel(state, event) {
      if (!state?.root || !state?.thumb || !state.root.classList.contains('chat-scroll-minimap--active')) return;
      const deltaPx = normalizeWheelDeltaToPixels(event, state.root.clientHeight || 120);
      if (Math.abs(deltaPx) < 0.01) return;

      event.preventDefault();
      event.stopPropagation();
      if (state.dragSession) return;

      const currentAcc = Number(state.wheelDeltaAccumulator) || 0;
      const currentSign = Math.sign(currentAcc);
      const deltaSign = Math.sign(deltaPx);
      if (currentSign !== 0 && deltaSign !== 0 && currentSign !== deltaSign) {
        state.wheelDeltaAccumulator = 0;
      }
      state.wheelDeltaAccumulator += deltaPx;
      scheduleMinimapWheelAccumulatorReset(state);

      const accumulator = Number(state.wheelDeltaAccumulator) || 0;
      const steps = Math.trunc(Math.abs(accumulator) / MINIMAP_WHEEL_STEP_PX);
      if (steps <= 0) return;

      const direction = accumulator > 0 ? 1 : -1;
      const residual = accumulator - direction * steps * MINIMAP_WHEEL_STEP_PX;
      state.wheelDeltaAccumulator = residual;
      scrollContainerByMessageStep(state, direction * steps);
      if (state.key === 'chat') scheduleReadingAnchorCapture();
      scheduleMinimapRender();
    }

    function handleMinimapPointerDown(state, event) {
      if (!state?.root || !state.root.classList.contains('chat-scroll-minimap--active')) return;
      if (event.button !== 0) return;
      if (event.target === state.thumb) return;
      event.preventDefault();
      scrollContainerFromMinimapClientY(state, event.clientY, { centerViewport: true });
      if (state.key === 'chat') scheduleReadingAnchorCapture();
      scheduleMinimapRender();
    }

    function handleMinimapThumbPointerDown(state, event) {
      if (!state?.root || !state?.thumb || !state.root.classList.contains('chat-scroll-minimap--active')) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const thumbRect = state.thumb.getBoundingClientRect();
      state.dragSession = {
        pointerId: event.pointerId,
        offsetY: event.clientY - thumbRect.top
      };
      state.root.classList.add('chat-scroll-minimap--dragging');
      try {
        state.thumb.setPointerCapture(event.pointerId);
      } catch (_) {}
    }

    function handleMinimapThumbPointerMove(state, event) {
      if (!state?.root || !state?.thumb || !state.dragSession) return;
      if (event.pointerId !== state.dragSession.pointerId) return;
      event.preventDefault();
      const rootRect = state.root.getBoundingClientRect();
      const thumbHeight = Math.max(0, state.thumb.offsetHeight || 0);
      const maxTop = Math.max(0, rootRect.height - thumbHeight);
      const rawTop = event.clientY - rootRect.top - state.dragSession.offsetY;
      const clampedTop = clampNumber(rawTop, 0, maxTop);
      scrollContainerByThumbTop(state, clampedTop);
      if (state.key === 'chat') scheduleReadingAnchorCapture();
      scheduleMinimapRender();
    }

    function finishMinimapThumbDrag(state, event) {
      if (!state?.root || !state?.thumb || !state.dragSession) return;
      if (event && event.pointerId != null && event.pointerId !== state.dragSession.pointerId) return;
      state.dragSession = null;
      state.root.classList.remove('chat-scroll-minimap--dragging');
      if (event && event.pointerId != null) {
        try {
          state.thumb.releasePointerCapture(event.pointerId);
        } catch (_) {}
      }
    }

    function renderMinimapState(state, minimapWidth, featureEnabled, fullscreenEnabled, autoHideEnabled, messageDisplayMode) {
      if (!ensureMinimapElements(state)) return;
      state.root.classList.toggle('chat-scroll-minimap--auto-hide', !!autoHideEnabled);
      const container = state.container;
      const isThreadState = state.key === 'thread';
      const threadModeActive = isThreadModeActive();
      const containerRect = container.getBoundingClientRect();
      const containerVisible = containerRect.width > 1 && containerRect.height > 1;
      const { trackHeight } = syncMinimapGeometry(state, minimapWidth);
      const messages = collectDirectMessageElements(container);
      const messageCount = messages.length;
      const scrollHeight = Math.max(0, container.scrollHeight || 0);
      const clientHeight = Math.max(0, container.clientHeight || 0);
      const renderContext = buildMinimapRenderContext(messages, scrollHeight, clientHeight, messageDisplayMode);
      state.renderContext = renderContext;
      const hasOverflow = scrollHeight > clientHeight + 1;
      const shouldShow = featureEnabled
        && fullscreenEnabled
        && containerVisible
        && (!isThreadState || threadModeActive)
        && hasOverflow
        && messageCount > 0
        && trackHeight >= MINIMAP_MIN_HEIGHT;

      setMinimapVisible(state, shouldShow);
      if (!shouldShow) return;

      const metricsChanged = scrollHeight !== state.lastScrollHeight
        || clientHeight !== state.lastClientHeight
        || messageCount !== state.lastMessageCount
        || messageDisplayMode !== state.lastMessageMode;
      if (metricsChanged) state.needsMapRedraw = true;

      if (state.needsMapRedraw) {
        drawMinimapOverview(state, messages, trackHeight, scrollHeight, messageDisplayMode);
        state.needsMapRedraw = false;
        state.lastScrollHeight = scrollHeight;
        state.lastClientHeight = clientHeight;
        state.lastMessageCount = messageCount;
        state.lastMessageMode = messageDisplayMode;
      }

      updateMinimapThumb(state, trackHeight, renderContext);
    }

    function renderMinimap() {
      const featureEnabled = isMinimapFeatureEnabled();
      const fullscreenEnabled = isFullscreenLayoutActive();
      const minimapWidth = getConfiguredMinimapWidth();
      const autoHideEnabled = isMinimapAutoHideEnabled();
      const messageDisplayMode = getMinimapMessageDisplayMode();
      for (const state of minimapStates) {
        renderMinimapState(state, minimapWidth, featureEnabled, fullscreenEnabled, autoHideEnabled, messageDisplayMode);
      }
    }

    function scheduleMinimapRender(options = {}) {
      if (options.rebuildMap) {
        minimapStates.forEach((state) => {
          state.needsMapRedraw = true;
        });
      }
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
      if (!target || target === chatContainer || target === threadContainer) return;

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

    if (threadContainer) {
      threadObserver = new MutationObserver((mutations) => {
        let shouldRefreshMinimap = false;
        for (const mutation of mutations) {
          if (mutation.type === 'childList' || mutation.type === 'characterData' || mutation.type === 'attributes') {
            shouldRefreshMinimap = true;
            break;
          }
        }
        if (shouldRefreshMinimap) {
          scheduleMinimapRender({ rebuildMap: true });
        }
      });

      threadObserver.observe(threadContainer, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }

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
    function handleThreadScroll() {
      scheduleMinimapRender();
    }
    if (threadContainer) {
      threadContainer.addEventListener('scroll', handleThreadScroll, { passive: true });
    }

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

    if (threadContainer) {
      try {
        threadResizeObserver = new ResizeObserver(() => {
          scheduleMinimapRender({ rebuildMap: true });
        });
        try {
          threadResizeObserver.observe(threadContainer, { box: 'border-box' });
        } catch (_) {
          threadResizeObserver.observe(threadContainer);
        }
      } catch (_) {
        threadResizeObserver = null;
      }
    }

    // 监听 <img> 等资源加载完成（load 不冒泡，需 capture）
    chatContainer.addEventListener('load', handleContentLoad, true);
    if (threadContainer) {
      threadContainer.addEventListener('load', handleContentLoad, true);
    }

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
      if (threadResizeObserver) {
        try {
          threadResizeObserver.disconnect();
        } catch (_) {}
        threadResizeObserver = null;
      }
      if (threadObserver) {
        try {
          threadObserver.disconnect();
        } catch (_) {}
        threadObserver = null;
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
      if (threadContainer) {
        threadContainer.removeEventListener('load', handleContentLoad, true);
        threadContainer.removeEventListener('scroll', handleThreadScroll);
      }
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
      minimapStates.forEach((state) => {
        try {
          state.root?.remove?.();
        } catch (_) {}
        state.root = null;
        state.canvas = null;
        state.thumb = null;
        state.dragSession = null;
        state.renderContext = null;
        resetMinimapWheelAccumulator(state);
      });
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
