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
    const chatContainer = document.getElementById('chat-container');
    const input = document.getElementById('message-input');
    clearChatButtonRef = document.getElementById('clear-chat');

    if (!chatContainer || !input) return;

    const historyState = {
      items: [],
      pointer: 0,
      draft: '',
      inNavigation: false,
      applying: false
    };

    let rebuildTimer = null;
    let scrollbarRaf = null;
    let chatResizeObserver = null;
    let rootAttrObserver = null;
    let fontsDoneHandler = null;

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

      if (scrollbarWidth <= 0) {
        if (chatContainer.classList.contains('has-scrollbar')) {
          chatContainer.classList.remove('has-scrollbar');
        }
        if (chatContainer.style.getPropertyValue('--scrollbar-width')) {
          chatContainer.style.removeProperty('--scrollbar-width');
        }
        return;
      }

      if (!chatContainer.classList.contains('has-scrollbar')) {
        chatContainer.classList.add('has-scrollbar');
      }
      const scrollbarWidthPx = `${scrollbarWidth}px`;
      if (chatContainer.style.getPropertyValue('--scrollbar-width') !== scrollbarWidthPx) {
        chatContainer.style.setProperty('--scrollbar-width', scrollbarWidthPx);
      }
    }

    function scheduleScrollbarUpdate() {
      if (scrollbarRaf) return;
      scrollbarRaf = requestAnimationFrame(() => {
        scrollbarRaf = null;
        updateScrollbarPadding();
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
        scheduleScrollbarUpdate();
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
      if (shouldUpdateScrollbar) scheduleScrollbarUpdate();
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

    window.addEventListener('resize', scheduleScrollbarUpdate);

    // chatContainer 的可视尺寸变化（常见于输入框高度变化、切换全屏布局等）不会触发 window.resize
    // 用 ResizeObserver 兜底，确保 padding-right 始终跟随滚动条占位宽度。
    try {
      chatResizeObserver = new ResizeObserver(() => scheduleScrollbarUpdate());
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
      rootAttrObserver = new MutationObserver(() => scheduleScrollbarUpdate());
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
        document.fonts.ready.then(() => scheduleScrollbarUpdate()).catch(() => {});
        if (typeof document.fonts.addEventListener === 'function') {
          fontsDoneHandler = () => scheduleScrollbarUpdate();
          document.fonts.addEventListener('loadingdone', fontsDoneHandler);
          document.fonts.addEventListener('loadingerror', fontsDoneHandler);
        }
      } catch (_) {}
    }

    if (clearChatButtonRef) {
      clearChatButtonRef.addEventListener('click', () => {
        historyState.items = [];
        resetNavigation({ preserveDraft: false });
        scheduleScrollbarUpdate();
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
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
      }
      if (scrollbarRaf) {
        cancelAnimationFrame(scrollbarRaf);
        scrollbarRaf = null;
      }
      window.removeEventListener('resize', scheduleScrollbarUpdate);
      window.removeEventListener('message', handleWindowMessage);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
