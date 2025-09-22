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
    let scrollbarTimer = null;

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
      const needsScrollbar = chatContainer.scrollHeight > chatContainer.clientHeight;
      if (!needsScrollbar) {
        chatContainer.classList.remove('has-scrollbar');
        chatContainer.style.removeProperty('--scrollbar-width');
        return;
      }
      const scrollbarWidth = chatContainer.offsetWidth - chatContainer.clientWidth;
      chatContainer.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      chatContainer.classList.add('has-scrollbar');
    }

    function scheduleScrollbarUpdate() {
      if (scrollbarTimer) return;
      scrollbarTimer = setTimeout(() => {
        scrollbarTimer = null;
        updateScrollbarPadding();
      }, 0);
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
        if (mutation.type !== 'childList') continue;
        if (mutation.addedNodes.length || mutation.removedNodes.length) {
          shouldRefresh = true;
          shouldUpdateScrollbar = true;
          break;
        }
      }

      if (shouldRefresh) scheduleHistoryRebuild();
      if (shouldUpdateScrollbar) scheduleScrollbarUpdate();
    });

    observer.observe(chatContainer, { childList: true });

    rebuildHistory();
    updateScrollbarPadding();

    window.addEventListener('resize', scheduleScrollbarUpdate);

    if (clearChatButtonRef) {
      clearChatButtonRef.addEventListener('click', () => {
        historyState.items = [];
        resetNavigation({ preserveDraft: false });
        scheduleScrollbarUpdate();
      });
    }

    window.addEventListener('beforeunload', () => {
      observer.disconnect();
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
      }
      if (scrollbarTimer) {
        clearTimeout(scrollbarTimer);
        scrollbarTimer = null;
      }
      window.removeEventListener('message', handleWindowMessage);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
