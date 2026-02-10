/**
 * 消息处理模块 - 负责消息的显示、更新和格式化
 * @module MessageProcessor
 */

/**
 * 创建消息处理器实例
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {Object} appContext.services.chatHistoryManager - 聊天历史管理器
 * @param {Function} appContext.services.imageHandler.processImageTags - 处理图片标签的函数
 * @returns {Object} 消息处理API
 */
import { renderMarkdownSafe } from '../utils/markdown_renderer.js';
import { extractThinkingFromText, mergeThoughts } from '../utils/thoughts_parser.js';

/**
 * 纯函数：从 pageInfo 中提取“可持久化的页面元数据快照”（仅 url/title）。
 *
 * 为什么要做这一步：
 * - sidebar 里的 state.pageInfo 会随着用户切换标签页实时更新；
 * - 但“对话记录的来源页面”更符合直觉的语义是：以首条用户消息发出时所在的页面为准；
 * - 因此在创建首条用户消息节点时，冻结一份小而稳定的 {url,title}，供首次落盘会话时使用。
 *
 * 注意：
 * - 这里刻意不保存 pageInfo.content 等大字段，避免 IndexedDB 膨胀；
 * - 若 url/title 都为空，则返回 null（表示无法确定来源页）。
 *
 * @param {any} pageInfo
 * @returns {{url: string, title: string} | null}
 */
function createPageMetaSnapshot(pageInfo) {
  const url = typeof pageInfo?.url === 'string' ? pageInfo.url.trim() : '';
  const title = typeof pageInfo?.title === 'string' ? pageInfo.title.trim() : '';
  if (!url && !title) return null;
  return { url, title };
}

function buildMessageSelector(rawMessageId) {
  if (!rawMessageId) return '';
  const raw = String(rawMessageId);
  const safeId = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(raw)
    : raw.replace(/["\\]/g, '\\$&');
  return `.message[data-message-id="${safeId}"]`;
}

/**
 * 规范化 pathname，避免“尾部斜杠差异”导致的同页误判。
 * - 根路径 "/" 保持不变；
 * - 其它路径移除末尾 "/"。
 * @param {string} pathname
 * @returns {string}
 */
function normalizePathname(pathname) {
  if (typeof pathname !== 'string' || !pathname) return '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * 安全解析 URL：失败时返回 null，避免在纯函数中抛错。
 * @param {string} value
 * @returns {URL|null}
 */
function safeParseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value);
  } catch (_) {
    return null;
  }
}

/**
 * 生成“Markdown 链接解析上下文”，提前缓存 base URL，避免重复解析。
 * @param {string} baseUrl - 当前页面 URL（来自 content script 的 pageInfo）
 * @param {boolean} isStandalone - 是否独立模式（非 iframe）
 * @returns {{ baseUrl: string, base: URL|null, isStandalone: boolean }}
 */
function buildMarkdownLinkContext(baseUrl, isStandalone) {
  const normalizedBase = (typeof baseUrl === 'string') ? baseUrl.trim() : '';
  return {
    baseUrl: normalizedBase,
    base: safeParseUrl(normalizedBase),
    isStandalone: !!isStandalone
  };
}

/**
 * 解析 Markdown 链接并产出“打开策略”。
 *
 * 设计说明（新接手同学重点看这里）：
 * - 侧栏运行在扩展 iframe 内，Markdown 的相对链接/哈希默认会解析到扩展页面；
 * - 这会导致“本页内跳转”失效（例如 #anchor、#:~:text 或 ?t= 时间跳转）；
 * - 因此需要用“当前页面 URL”作为 base 重新解析，并判断是否属于“同页跳转”。
 *
 * 判定规则：
 * - 仅在 iframe 模式（非 standalone）下生效；
 * - 若解析后与当前页面“同源 + 同路径”，视为“同页跳转”，在当前标签页打开（target=_top）；
 * - 其它链接保持新标签页打开（target=_blank）；
 * - 无论打开方式如何，只要能解析出绝对 URL，就回写到 href，确保相对链接指向正确页面。
 *
 * @param {string} rawHref - 原始 href（未解析）
 * @param {{ baseUrl: string, base: URL|null, isStandalone: boolean }} context
 * @returns {{ resolvedUrl: string, target: string, rel: string }}
 */
function getMarkdownLinkPolicy(rawHref, context) {
  const result = {
    resolvedUrl: '',
    target: '_blank',
    rel: 'noopener noreferrer'
  };

  const hrefText = (typeof rawHref === 'string') ? rawHref.trim() : '';
  if (!hrefText) return result;

  const base = context?.base || null;
  let resolved = null;
  if (base) {
    try {
      resolved = new URL(hrefText, base.href);
    } catch (_) {
      resolved = null;
    }
  } else {
    resolved = safeParseUrl(hrefText);
  }

  if (resolved) {
    result.resolvedUrl = resolved.href;
  }

  // 独立模式不做“同页跳转”判断，避免导航离开扩展页面。
  if (context?.isStandalone) return result;

  if (!base || !resolved) return result;

  const sameOrigin = resolved.origin === base.origin;
  const samePath = normalizePathname(resolved.pathname) === normalizePathname(base.pathname);

  if (sameOrigin && samePath) {
    result.target = '_top';
    result.rel = '';
  }

  return result;
}

export function createMessageProcessor(appContext) {
  const {
    dom,
    services,
    state,
    utils
  } = appContext;

  const chatContainer = dom.chatContainer;
  const chatHistoryManager = services.chatHistoryManager;
  const imageHandler = services.imageHandler;
  const scrollToBottom = utils.scrollToBottom;
  
  // 保留占位：数学渲染现改为在 Markdown 渲染阶段由 KaTeX 完成

  /**
   * 为 Markdown 渲染区域设置“智能链接打开策略”。
   * @param {HTMLElement} rootElement - 消息容器或具体的 Markdown 区域
   */
  function decorateMarkdownLinks(rootElement) {
    if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;

    const baseUrl = (typeof state?.pageInfo?.url === 'string') ? state.pageInfo.url : '';
    const linkContext = buildMarkdownLinkContext(baseUrl, state?.isStandalone);

    const containers = [];
    if (typeof rootElement.matches === 'function' && rootElement.matches('.text-content, .thoughts-content')) {
      containers.push(rootElement);
    }
    rootElement.querySelectorAll('.text-content, .thoughts-content').forEach((node) => containers.push(node));

    const uniqueContainers = Array.from(new Set(containers));
    uniqueContainers.forEach((container) => {
      container.querySelectorAll('a').forEach((link) => {
        const rawHref = link.getAttribute('href') || '';
        const policy = getMarkdownLinkPolicy(rawHref, linkContext);
        const isSamePage = policy.target === '_top';
        const rawTextFragment = typeof rawHref === 'string' && rawHref.includes(':~:text=');
        const resolvedTextFragment = typeof policy.resolvedUrl === 'string' && policy.resolvedUrl.includes('#:~:text=');
        const hasTextFragment = rawTextFragment || resolvedTextFragment;

        if (policy.resolvedUrl) {
          link.setAttribute('href', policy.resolvedUrl);
          link.dataset.cerebrResolvedUrl = policy.resolvedUrl;
        } else {
          delete link.dataset.cerebrResolvedUrl;
        }

        link.target = policy.target;
        if (policy.rel) {
          link.setAttribute('rel', policy.rel);
        } else {
          link.removeAttribute('rel');
        }
        link.dataset.cerebrSamePage = isSamePage ? 'true' : 'false';
        link.dataset.cerebrTextFragment = hasTextFragment ? 'true' : 'false';
      });
    });
  }

  let markdownLinkInterceptorInstalled = false;

  /**
   * 在侧栏内拦截“同页跳转”链接，交由父页面执行跳转/定位。
   * 目的：解决 text fragment 在 iframe 内点击无效的问题。
   */
  function installMarkdownLinkInterceptor() {
    if (markdownLinkInterceptorInstalled) return;
    const handler = (event) => {
      if (!event || event.defaultPrevented) return;
      if (event.button !== 0) return; // 仅处理左键点击
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const link = target.closest('a');
      if (!link) return;
      if (link.dataset.cerebrSamePage !== 'true') return;
      if (link.dataset.cerebrTextFragment !== 'true') return;

      const url = link.dataset.cerebrResolvedUrl || link.getAttribute('href') || '';
      if (!url) return;
      if (!window.parent || window.parent === window) return;

      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage({ type: 'OPEN_MARKDOWN_LINK', url }, '*');
    };

    if (chatContainer) {
      chatContainer.addEventListener('click', handler);
    }
    if (dom?.threadContainer && dom.threadContainer !== chatContainer) {
      dom.threadContainer.addEventListener('click', handler);
    }
    markdownLinkInterceptorInstalled = true;
  }

  function resolveMessageElement(messageId) {
    if (!messageId) return null;
    const selector = buildMessageSelector(messageId);
    if (!selector) return null;
    let element = chatContainer?.querySelector(selector) || null;
    if (element) return element;

    const threadContainer = dom?.threadContainer || null;
    if (threadContainer && threadContainer !== chatContainer) {
      element = threadContainer.querySelector(selector) || null;
    }
    return element;
  }

  function resolveScrollContainerForMessage(messageElement) {
    if (!messageElement) return chatContainer;
    const threadContainer = dom?.threadContainer || null;
    if (threadContainer && threadContainer.contains(messageElement)) {
      // 若线程容器嵌入在 chatContainer 内（侧栏模式），滚动容器仍应使用 chatContainer
      const isNestedInChat = typeof threadContainer.closest === 'function'
        ? !!threadContainer.closest('#chat-container')
        : false;
      if (!isNestedInChat) {
        return threadContainer;
      }
    }
    return chatContainer;
  }

  function resolveMessageListContainer(messageElement) {
    if (!messageElement) return chatContainer;
    const threadContainer = dom?.threadContainer || null;
    if (threadContainer && threadContainer.contains(messageElement)) {
      return threadContainer;
    }
    return chatContainer;
  }

  // --- 超长对话虚拟化（远距离消息折叠）---
  // 目标：当消息数量极大时，只让“视野附近”的消息保持完整 DOM；
  //      对于视野很远处的消息，仅保留高度占位，从而显著降低布局/绘制压力。
  const messageVirtualizer = createMessageVirtualizer();

  function createMessageVirtualizer() {
    const virtualizedMap = new WeakMap();
    const containerStateMap = new WeakMap();

    // 可调参数：数值越大，越保守（渲染更多消息）；越小越激进（虚拟化更多消息）。
    const MIN_MESSAGES_FOR_VIRTUALIZE = 120;
    const KEEP_BUFFER_MULTIPLIER = 1.2; // 视口上下各保留 1.2x 高度
    const DROP_BUFFER_MULTIPLIER = 2.8; // 超过 2.8x 视口高度才进入虚拟化
    const MIN_KEEP_BUFFER_PX = 800;
    const MIN_DROP_BUFFER_PX = 1600;
    const PIN_TAIL_COUNT = 6; // 永远保留末尾若干消息（流式更新/快速查看）
    const BLUR_CULL_BUFFER_MULTIPLIER = 1.1; // 离屏模糊剔除缓冲区（避免临界抖动）
    const MIN_BLUR_CULL_BUFFER_PX = 420;

    function getContainerState(container) {
      let state = containerStateMap.get(container);
      if (!state) {
        state = {
          raf: null,
          pending: false,
          installed: false,
          scrollHandler: null,
          resizeObserver: null,
          mutationObserver: null
        };
        containerStateMap.set(container, state);
      }
      return state;
    }

    function shouldPinMessage(messageEl, index, total, tailStart) {
      if (!messageEl || !messageEl.classList) return true;
      if (index >= tailStart) return true;
      if (messageEl.classList.contains('loading-message')) return true;
      if (messageEl.classList.contains('updating')) return true;
      if (messageEl.classList.contains('regenerating')) return true;
      if (messageEl.classList.contains('editing')) return true;
      if (messageEl.dataset?.virtualPin === '1') return true;
      try {
        if (messageEl.contains(document.activeElement)) return true;
      } catch (_) {}
      return false;
    }

    function snapshotInlineStyle(messageEl) {
      return {
        height: messageEl.style.height || '',
        minHeight: messageEl.style.minHeight || '',
        boxSizing: messageEl.style.boxSizing || '',
        overflow: messageEl.style.overflow || ''
      };
    }

    function restoreInlineStyle(messageEl, snapshot) {
      if (!messageEl) return;
      messageEl.style.height = snapshot?.height || '';
      messageEl.style.minHeight = snapshot?.minHeight || '';
      messageEl.style.boxSizing = snapshot?.boxSizing || '';
      messageEl.style.overflow = snapshot?.overflow || '';
    }

    function virtualizeMessage(messageEl) {
      if (!messageEl || messageEl.dataset?.virtualized === '1') return;
      const measuredHeight = messageEl.offsetHeight || 0;
      if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;

      const fragment = document.createDocumentFragment();
      while (messageEl.firstChild) {
        fragment.appendChild(messageEl.firstChild);
      }

      const styleSnapshot = snapshotInlineStyle(messageEl);
      messageEl.style.boxSizing = 'border-box';
      messageEl.style.height = `${Math.round(measuredHeight)}px`;
      messageEl.style.minHeight = `${Math.round(measuredHeight)}px`;
      messageEl.style.overflow = 'hidden';
      messageEl.classList.add('message-virtualized');
      messageEl.dataset.virtualized = '1';
      messageEl.dataset.virtualHeight = String(Math.round(measuredHeight));

      virtualizedMap.set(messageEl, { fragment, styleSnapshot });
    }

    function restoreMessage(messageEl) {
      if (!messageEl || messageEl.dataset?.virtualized !== '1') return;
      const record = virtualizedMap.get(messageEl);
      if (record) {
        while (messageEl.firstChild) {
          messageEl.removeChild(messageEl.firstChild);
        }
        messageEl.appendChild(record.fragment);
        restoreInlineStyle(messageEl, record.styleSnapshot);
        virtualizedMap.delete(messageEl);
      } else {
        restoreInlineStyle(messageEl, null);
      }
      messageEl.classList.remove('message-virtualized');
      delete messageEl.dataset.virtualized;
      delete messageEl.dataset.virtualHeight;
    }

    function ensureMessageVisible(messageEl) {
      if (!messageEl) return;
      if (messageEl.dataset?.virtualized === '1') {
        restoreMessage(messageEl);
      }
    }

    // 二分查找：找到第一个 bottom > offset 的消息索引
    function findFirstIndexByBottom(list, offset) {
      let low = 0;
      let high = list.length - 1;
      let first = list.length;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const el = list[mid];
        const bottom = (el?.offsetTop || 0) + (el?.offsetHeight || 0);
        if (bottom <= offset) {
          low = mid + 1;
        } else {
          first = mid;
          high = mid - 1;
        }
      }
      return first;
    }

    // 二分查找：找到最后一个 top < offset 的消息索引
    function findLastIndexByTop(list, offset) {
      let low = 0;
      let high = list.length - 1;
      let last = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const el = list[mid];
        const top = el?.offsetTop || 0;
        if (top < offset) {
          last = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return last;
    }

    function restoreAll(container) {
      if (!container) return;
      const nodes = container.querySelectorAll('.message[data-virtualized="1"]');
      nodes.forEach((node) => restoreMessage(node));
    }

    function applyOffscreenBlurCull(messages, viewportTop, viewportBottom, viewportHeight, tailStart) {
      if (!Array.isArray(messages) || !messages.length) return;
      const blurKeepBuffer = Math.max(MIN_BLUR_CULL_BUFFER_PX, viewportHeight * BLUR_CULL_BUFFER_MULTIPLIER);
      const blurKeepTop = viewportTop - blurKeepBuffer;
      const blurKeepBottom = viewportBottom + blurKeepBuffer;
      const total = messages.length;

      for (let i = 0; i < total; i += 1) {
        const node = messages[i];
        if (!node || !node.classList) continue;
        // 尾部/更新中消息保持滤镜，避免流式输出与交互中的视觉跳变。
        const pinned = shouldPinMessage(node, i, total, tailStart);
        if (pinned) {
          node.classList.remove('message-offscreen-blur-disabled');
          continue;
        }
        const top = Number(node.offsetTop) || 0;
        const height = Math.max(1, Number(node.offsetHeight) || 0);
        const bottom = top + height;
        const isOutside = bottom < blurKeepTop || top > blurKeepBottom;
        node.classList.toggle('message-offscreen-blur-disabled', isOutside);
      }
    }

    function updateContainer(container) {
      if (!container) return;
      const messageNodes = Array.from(container.querySelectorAll('.message'));
      const messages = messageNodes.filter((node) => (node?.offsetHeight || 0) > 0);
      const total = messages.length;
      if (!total) return;

      const viewportHeight = container.clientHeight || 0;
      if (viewportHeight <= 0) return;
      const viewportTop = container.scrollTop || 0;
      const viewportBottom = viewportTop + viewportHeight;
      const tailStart = Math.max(total - PIN_TAIL_COUNT, 0);

      // 轻量优化：无论是否进入“DOM 虚拟化”，都先剔除离屏消息的 backdrop blur。
      applyOffscreenBlurCull(messages, viewportTop, viewportBottom, viewportHeight, tailStart);

      if (total < MIN_MESSAGES_FOR_VIRTUALIZE) {
        restoreAll(container);
        return;
      }

      const keepBuffer = Math.max(MIN_KEEP_BUFFER_PX, viewportHeight * KEEP_BUFFER_MULTIPLIER);
      const dropBuffer = Math.max(MIN_DROP_BUFFER_PX, viewportHeight * DROP_BUFFER_MULTIPLIER);

      const keepTop = viewportTop - keepBuffer;
      const keepBottom = viewportBottom + keepBuffer;
      const dropTop = viewportTop - dropBuffer;
      const dropBottom = viewportBottom + dropBuffer;

      const firstKeepIdx = findFirstIndexByBottom(messages, keepTop);
      const lastKeepIdx = findLastIndexByTop(messages, keepBottom);
      const firstDropIdx = findFirstIndexByBottom(messages, dropTop);
      const lastDropIdx = findLastIndexByTop(messages, dropBottom);

      for (let i = 0; i < total; i += 1) {
        const node = messages[i];
        if (!node || !node.classList) continue;
        const isVirtualized = node.dataset?.virtualized === '1';
        const pinned = shouldPinMessage(node, i, total, tailStart);

        if (pinned) {
          if (isVirtualized) restoreMessage(node);
          continue;
        }

        const inKeepRange = i >= firstKeepIdx && i <= lastKeepIdx;
        const outsideDropRange = i < firstDropIdx || i > lastDropIdx;

        if (isVirtualized) {
          if (inKeepRange) restoreMessage(node);
          continue;
        }
        if (outsideDropRange) {
          virtualizeMessage(node);
        }
      }
    }

    function scheduleUpdate(container) {
      if (!container) return;
      const state = getContainerState(container);
      if (state.raf) {
        state.pending = true;
        return;
      }
      state.raf = requestAnimationFrame(() => {
        state.raf = null;
        updateContainer(container);
        if (state.pending) {
          state.pending = false;
          scheduleUpdate(container);
        }
      });
    }

    function installContainer(container) {
      if (!container) return;
      const state = getContainerState(container);
      if (state.installed) return;

      const onScroll = () => scheduleUpdate(container);
      container.addEventListener('scroll', onScroll, { passive: true });
      state.scrollHandler = onScroll;

      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => scheduleUpdate(container));
        ro.observe(container);
        state.resizeObserver = ro;
      }

      const mo = new MutationObserver(() => scheduleUpdate(container));
      mo.observe(container, { childList: true });
      state.mutationObserver = mo;

      state.installed = true;
    }

    function init() {
      installContainer(chatContainer);
      installContainer(dom?.threadContainer || null);
      scheduleUpdate(chatContainer);
      scheduleUpdate(dom?.threadContainer || null);
    }

    return {
      init,
      scheduleUpdate,
      ensureMessageVisible
    };
  }

  /**
   * 设置或更新思考过程的显示区域
   * @param {HTMLElement} messageWrapperDiv - 包裹单条消息的顶层div (e.g., .message)
   * @param {string|null} rawThoughts - 原始的思考过程文本，为null则移除该区域
   * @param {Function} processMathAndMarkdownFn - 用于处理Markdown和数学的函数引用
   */
  function setupThoughtsDisplay(messageWrapperDiv, rawThoughts, processMathAndMarkdownFn) {
    let thoughtsContentDiv = messageWrapperDiv.querySelector('.thoughts-content');

    if (rawThoughts && rawThoughts.trim() !== '') {
      let thoughtsInnerContent;
      let toggleButton;

      if (!thoughtsContentDiv) {
        thoughtsContentDiv = document.createElement('div');
        thoughtsContentDiv.className = 'thoughts-content';

        // 说明：折叠态只显示“思考内容”这一行；展开后才显示完整思考文本。
        // 设计目标：当 AI 开始输出正文（data-original-text 非空）时，默认自动折叠，避免思考块占用过多高度。
        toggleButton = document.createElement('button');
        toggleButton.className = 'thoughts-toggle';
        toggleButton.setAttribute('type', 'button');
        toggleButton.setAttribute('aria-label', '切换思考内容');
        toggleButton.setAttribute('aria-expanded', 'false');
        toggleButton.textContent = '思考内容';
        thoughtsContentDiv.appendChild(toggleButton);

        thoughtsInnerContent = document.createElement('div');
        thoughtsInnerContent.className = 'thoughts-inner-content';
        thoughtsContentDiv.appendChild(thoughtsInnerContent);

        toggleButton.addEventListener('click', (e) => {
          e.stopPropagation();
          // 用户手动操作后，不再执行“自动折叠/自动展开”，避免与用户意图冲突。
          thoughtsContentDiv.dataset.userToggled = 'true';
          const isExpanded = thoughtsContentDiv.classList.toggle('expanded');
          toggleButton.setAttribute('aria-expanded', isExpanded.toString());
        });
        toggleButton.dataset.listenerAdded = 'true';
        
        const textContentElement = messageWrapperDiv.querySelector('.text-content');
        if (textContentElement) {
             messageWrapperDiv.insertBefore(thoughtsContentDiv, textContentElement);
        } else {
             messageWrapperDiv.appendChild(thoughtsContentDiv); // Fallback
        }
      } else {
        // Thoughts section already exists, get its parts (兼容旧结构：清理旧的 prefix/button)
        const legacyPrefix = thoughtsContentDiv.querySelector('.thoughts-prefix');
        if (legacyPrefix) legacyPrefix.remove();
        const legacyExpandButton = thoughtsContentDiv.querySelector('.expand-thoughts-btn');
        if (legacyExpandButton) legacyExpandButton.remove();

        thoughtsInnerContent = thoughtsContentDiv.querySelector('.thoughts-inner-content');
        toggleButton = thoughtsContentDiv.querySelector('.thoughts-toggle');
        if (!toggleButton) {
          toggleButton = document.createElement('button');
          toggleButton.className = 'thoughts-toggle';
          toggleButton.setAttribute('type', 'button');
          toggleButton.setAttribute('aria-label', '切换思考内容');
          toggleButton.setAttribute('aria-expanded', 'false');
          toggleButton.textContent = '思考内容';
          thoughtsContentDiv.insertBefore(toggleButton, thoughtsContentDiv.firstChild);
        }
        if (!toggleButton.dataset.listenerAdded) {
          toggleButton.addEventListener('click', (e) => {
            e.stopPropagation();
            thoughtsContentDiv.dataset.userToggled = 'true';
            const isExpanded = thoughtsContentDiv.classList.toggle('expanded');
            toggleButton.setAttribute('aria-expanded', isExpanded.toString());
          });
          toggleButton.dataset.listenerAdded = 'true';
        }
        if (!thoughtsInnerContent) {
          thoughtsInnerContent = document.createElement('div');
          thoughtsInnerContent.className = 'thoughts-inner-content';
          thoughtsContentDiv.appendChild(thoughtsInnerContent);
        }
      }
      
      if (thoughtsInnerContent) {
          thoughtsInnerContent.innerHTML = processMathAndMarkdownFn(rawThoughts);
      }

      // 自动折叠策略：
      // - 在 AI 还未开始输出正文时（data-original-text 为空），默认展开，便于实时查看思考流。
      // - 一旦正文开始输出，则默认折叠为单行，仅保留“思考内容”入口；用户点击后可再次展开。
      // - 如果用户已经手动展开/折叠过，则尊重用户选择，不再自动干预。
      const answerText = messageWrapperDiv.getAttribute('data-original-text') || '';
      const hasAnswerContent = (typeof answerText === 'string') && answerText.trim() !== '';
      const userHasToggled = thoughtsContentDiv.dataset.userToggled === 'true';

      if (!userHasToggled) {
        if (hasAnswerContent) {
          thoughtsContentDiv.classList.remove('expanded');
        } else {
          thoughtsContentDiv.classList.add('expanded');
        }
      }
      if (toggleButton) {
        toggleButton.setAttribute('aria-expanded', thoughtsContentDiv.classList.contains('expanded') ? 'true' : 'false');
      }

    } else if (thoughtsContentDiv) {
      // No new thoughts, or thoughts are cleared, remove the entire thoughts section
      thoughtsContentDiv.remove();
    }
  }

  /**
   * 添加消息到聊天窗口
   * @param {string} text - 消息文本内容
  * @param {string} sender - 发送者 ('user' 或 'ai')
  * @param {boolean} skipHistory - 是否不更新历史记录
  * @param {DocumentFragment|null} fragment - 如使用文档片段则追加到此处，否则直接追加到聊天容器
  * @param {string|null} imagesHTML - 图片部分的 HTML 内容（可为空）
  * @param {string|null} [initialThoughtsRaw=null] - AI的初始思考过程文本 (可选)
  * @param {string|null} [messageIdToUpdate=null] - 如果是更新现有消息，则提供其ID
  * @param {{promptType?: string|null, promptMeta?: Object|null}|null} [meta=null] - 可选：写入历史节点的附加元信息（主要用于用户消息）
  * @param {{container?: HTMLElement|null, skipDom?: boolean, historyParentId?: string|null, preserveCurrentNode?: boolean, historyPatch?: Object|null}|null} [options=null] - 可选：渲染/历史写入控制
   * @returns {HTMLElement|null} 新生成或更新的消息元素（若 skipDom=true 则返回 null）
  */
  function appendMessage(text, sender, skipHistory = false, fragment = null, imagesHTML = null, initialThoughtsRaw = null, messageIdToUpdate = null, meta = null, options = null) {
    const renderOptions = (options && typeof options === 'object') ? options : {};
    const targetContainer = renderOptions.container || chatContainer;
    const shouldRenderDom = !renderOptions.skipDom;
    const historyParentId = (typeof renderOptions.historyParentId === 'string' && renderOptions.historyParentId.trim())
      ? renderOptions.historyParentId.trim()
      : chatHistoryManager.chatHistory.currentNode;
    const preserveCurrentNode = !!renderOptions.preserveCurrentNode;
    const historyPatch = (renderOptions.historyPatch && typeof renderOptions.historyPatch === 'object')
      ? renderOptions.historyPatch
      : null;

    let messageDiv;
    let node;
    // 提前拆分 <think> 段落，确保正文与思考摘要分离
    let messageText = text;
    let thoughtsForMessage = initialThoughtsRaw;
    if (typeof messageText === 'string') {
      const thinkExtraction = extractThinkingFromText(messageText);
      if (thinkExtraction.thoughtText) {
        thoughtsForMessage = mergeThoughts(thoughtsForMessage, thinkExtraction.thoughtText);
        messageText = thinkExtraction.cleanText;
      }
    }

    if (shouldRenderDom) {
      if (messageIdToUpdate) {
        const selector = buildMessageSelector(messageIdToUpdate);
        messageDiv = selector ? targetContainer.querySelector(selector) : null;
        if (!messageDiv) {
          console.error('appendMessage: 试图更新的消息未找到 DOM 元素', messageIdToUpdate);
          // Create a new one if update target is missing, this indicates a potential logic flaw elsewhere
          messageDiv = document.createElement('div');
          messageDiv.classList.add('message', `${sender}-message`);
          if (fragment) messageDiv.classList.add('batch-load'); // if it was intended for a fragment
        }
        // For updates, main text and thoughts are handled by updateAIMessage or setupThoughtsDisplay called from there.
        // appendMessage when messageIdToUpdate is present is mostly for ensuring the messageDiv exists.
        // So, we'll mostly clear and let updateAIMessage fill.
        // However, this function signature with messageIdToUpdate might be part of a specific workflow.
        // For now, let's assume if messageIdToUpdate is given, it's for initial AI message shell creation in streaming.
        // And actual content updates will be handled by updateAIMessage.

      } else {
        messageDiv = document.createElement('div');
        messageDiv.classList.add('message', `${sender}-message`);
      }

      if (fragment && !messageIdToUpdate) {
        messageDiv.classList.add('batch-load');
      }

      messageDiv.setAttribute('data-original-text', messageText); // Main answer text
      // thoughtsForMessage is handled below by setupThoughtsDisplay

      if (imagesHTML && imagesHTML.trim() && !messageIdToUpdate) {
        const imageContentDiv = document.createElement('div');
        imageContentDiv.classList.add('image-content');
        imageContentDiv.innerHTML = imagesHTML;
        imageContentDiv.querySelectorAll('img').forEach(img => {
          img.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            imageHandler.showImagePreview(img.src);
          });
        });
        messageDiv.appendChild(imageContentDiv);
      }
      
      // Setup thoughts display (handles creation/removal)
      // Pass `processMathAndMarkdown` from the outer scope
      setupThoughtsDisplay(messageDiv, thoughtsForMessage, processMathAndMarkdown);


      let textContentDiv = messageDiv.querySelector('.text-content');
      if (!textContentDiv) {
          textContentDiv = document.createElement('div');
          textContentDiv.classList.add('text-content');
          // Ensure textContentDiv is after thoughtsDiv if thoughtsDiv was added
          const thoughtsDiv = messageDiv.querySelector('.thoughts-content');
          if (thoughtsDiv && thoughtsDiv.nextSibling) {
              messageDiv.insertBefore(textContentDiv, thoughtsDiv.nextSibling);
          } else {
              messageDiv.appendChild(textContentDiv);
          }
      }
      try {
        if (sender === 'user') {
          textContentDiv.innerText = messageText;
        } else {
          textContentDiv.innerHTML = processMathAndMarkdown(messageText);
        }
      } catch (error) {
        console.error('处理数学公式和Markdown失败:', error);
        textContentDiv.innerText = messageText;
      }
      
      decorateMarkdownLinks(messageDiv);

      messageDiv.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
      });

      bindInlineImagePreviews(messageDiv);

      // 数学公式已在渲染阶段通过 KaTeX 输出，无需二次 auto-render

      if (!messageIdToUpdate) {
        if (fragment) {
          fragment.appendChild(messageDiv);
        } else if (targetContainer) {
          targetContainer.appendChild(messageDiv);
        }
      }
      
      // 为消息元素添加双击事件监听器，用于展开/折叠 foldMessageContent 创建的 details 元素
      if (!messageDiv.dataset.dblclickListenerAdded) {
        messageDiv.addEventListener('dblclick', function(event) { // 使用 function 关键字使 this 指向 messageDiv
          const detailsElement = this.querySelector('details.folded-message');
          if (detailsElement) {
            const summaryElement = detailsElement.querySelector('summary');
            if (summaryElement && summaryElement.contains(event.target)) {
              return;
            }

            const scrollContainer = targetContainer || chatContainer; // chatContainer 来自外部作用域
            // const scrollYBefore = scrollContainer.scrollTop; // 不再需要
            // const rectBefore = this.getBoundingClientRect(); // 不再需要

            // 切换 details 元素的 open 状态
            if (detailsElement.hasAttribute('open')) {
              detailsElement.removeAttribute('open');
            } else {
              detailsElement.setAttribute('open', '');
            }

            // 使用 requestAnimationFrame 等待浏览器完成布局更新
            requestAnimationFrame(() => {
              const messageTopRelativeToViewport = this.getBoundingClientRect().top;
              const scrollContainerTopRelativeToViewport = scrollContainer.getBoundingClientRect().top;
              const offsetToScroll = messageTopRelativeToViewport - scrollContainerTopRelativeToViewport;
              scrollContainer.scrollTop += offsetToScroll;
            });
          }
        });
      messageDiv.dataset.dblclickListenerAdded = 'true';
    }
  } else {
    messageDiv = null;
  }
    
    if (!skipHistory) {
      if (messageIdToUpdate) {
        node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageIdToUpdate);
        if (node) {
          node.content = messageText; // Main answer
          if (thoughtsForMessage !== undefined) { // Allow setting thoughts to null/empty
             node.thoughtsRaw = thoughtsForMessage;
          }
          if (historyPatch && typeof historyPatch === 'object') {
            Object.assign(node, historyPatch);
          }
        } else {
             console.warn(`appendMessage: History node not found for update: ${messageIdToUpdate}`);
        }
      } else {
        const processedContent = imageHandler.processImageTags(messageText, imagesHTML);
        const addWithOptions = typeof chatHistoryManager.addMessageToTreeWithOptions === 'function'
          && (preserveCurrentNode || historyParentId !== chatHistoryManager.chatHistory.currentNode);
        if (addWithOptions) {
          node = chatHistoryManager.addMessageToTreeWithOptions(
            sender === 'user' ? 'user' : 'assistant',
            processedContent,
            historyParentId,
            { preserveCurrentNode }
          );
        } else {
          node = chatHistoryManager.addMessageToTree(
            sender === 'user' ? 'user' : 'assistant',
            processedContent,
            historyParentId
          );
        }
        if (thoughtsForMessage) {
          node.thoughtsRaw = thoughtsForMessage;
        }
        if (node) {
          node.hasInlineImages = (!imagesHTML && Array.isArray(processedContent) && processedContent.some(p => p?.type === 'image_url'));
        }
        // 将“指令类型”等元信息写入历史节点（只对用户消息生效）
        // 说明：这类信息一旦持久化，后续功能（例如对话标题生成）即可完全脱离“字符串/正则”猜测。
        if (node && node.role === 'user' && meta && typeof meta === 'object') {
          if (typeof meta.promptType === 'string') {
            node.promptType = meta.promptType;
          }
          if (meta.promptMeta && typeof meta.promptMeta === 'object') {
            node.promptMeta = meta.promptMeta;
          }
        }

        if (node && historyPatch && typeof historyPatch === 'object') {
          Object.assign(node, historyPatch);
        }

        // 关键：仅在“首条用户消息”写入页面元数据快照，用于固定会话来源页。
        // 这样即使在 AI 生成过程中用户切换到其它标签页，最终落盘的会话 URL/标题也不会被错误覆盖。
        try {
          if (node && node.role === 'user') {
            const hasOtherUserMessage = chatHistoryManager.chatHistory.messages.some(
              (m) => m && m.id !== node.id && String(m.role || '').toLowerCase() === 'user'
            );
            if (!hasOtherUserMessage) {
              const snapshot = createPageMetaSnapshot(state?.pageInfo);
              if (snapshot) node.pageMeta = snapshot;
            }
          }
        } catch (e) {
          console.warn('写入首条用户消息 pageMeta 失败（将回退为保存时读取 pageInfo）:', e);
        }
        if (messageDiv && node) {
          messageDiv.setAttribute('data-message-id', node.id);
          // 初次创建 AI 消息时插入一个空的 API footer，占位以便样式稳定
          if (sender === 'ai') {
            const apiFooter = document.createElement('div');
            apiFooter.className = 'api-footer';
            messageDiv.appendChild(apiFooter);
          }
        }
      }

      if (sender === 'ai' && !messageIdToUpdate && messageDiv) {
        messageDiv.classList.add('updating');
      }
    }

    // 如果存在划词线程管理器，则在渲染后补充高亮装饰
    try {
      if (messageDiv && node) {
        services.selectionThreadManager?.decorateMessageElement?.(messageDiv, node);
      }
    } catch (e) {
      console.warn('应用划词线程高亮失败:', e);
    }
    if (shouldRenderDom && messageDiv && targetContainer) {
      messageVirtualizer.scheduleUpdate(targetContainer);
    }
    return messageDiv;
  }

  /**
   * 更新AI消息内容，包括思考过程和最终答案
   * @param {string} messageId - 要更新的消息的ID
   * @param {string} newAnswerContent - 最新的完整答案文本
   * @param {string|null} newThoughtsRaw - 最新的完整思考过程原始文本 (可选)
   */
  function updateAIMessage(messageId, newAnswerContent, newThoughtsRaw) {
    const messageDiv = resolveMessageElement(messageId);
    const node = chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId);

    messageVirtualizer.ensureMessageVisible(messageDiv);

    // 统一拆分 <think> 思考段落，保证思考摘要独立存储与展示
    let safeAnswerContent = newAnswerContent;
    let resolvedThoughts = newThoughtsRaw;
    let shouldUpdateThoughts = (newThoughtsRaw !== undefined);
    if (typeof safeAnswerContent === 'string') {
      const thinkExtraction = extractThinkingFromText(safeAnswerContent);
      safeAnswerContent = thinkExtraction.cleanText;
      if (thinkExtraction.thoughtText) {
        resolvedThoughts = mergeThoughts(resolvedThoughts, thinkExtraction.thoughtText);
        shouldUpdateThoughts = true;
      }
    }

    if (!node) {
      console.error('updateAIMessage: 消息或历史节点未找到', messageId);
      return;
    }

    // --- 同步历史记录中的内容结构（支持图片 + 文本的混合内容） ---
    try {
      // 提取当前消息中已有的图片 HTML（如果存在）
      const imageContentDiv = messageDiv ? messageDiv.querySelector('.image-content') : null;
      const imagesHTML = imageContentDiv ? imageContentDiv.innerHTML : null;
      // 使用与 appendMessage 相同的逻辑，将文本和图片转换为统一的消息内容格式
      const processedContent = imageHandler.processImageTags(safeAnswerContent, imagesHTML || '');
      node.content = processedContent;
    } catch (e) {
      console.warn('updateAIMessage: 处理图片标签失败，回退为纯文本内容:', e);
      node.content = safeAnswerContent;
    }
    try {
      const hasImageParts = Array.isArray(node.content) && node.content.some(p => p?.type === 'image_url');
      const hasImageContainer = !!(messageDiv && messageDiv.querySelector('.image-content'));
      node.hasInlineImages = (!hasImageContainer && hasImageParts);
    } catch (_) {
      node.hasInlineImages = false;
    }

    if (shouldUpdateThoughts) { // 允许显式将思考过程设置为 null/空字符串
      node.thoughtsRaw = resolvedThoughts;
    }

    // 线程切换/面板关闭时可能找不到 DOM，仍需保证历史数据完整。
    if (!messageDiv) {
      return;
    }

    messageDiv.setAttribute('data-original-text', safeAnswerContent);
    // 思考过程文本由 setupThoughtsDisplay 统一处理

    // Setup/Update thoughts display
    // Pass `processMathAndMarkdown` from the outer scope
    setupThoughtsDisplay(messageDiv, resolvedThoughts, processMathAndMarkdown);

    let textContentDiv = messageDiv.querySelector('.text-content');
    if (!textContentDiv) { // Should exist if appendMessage created it, but good to check
        textContentDiv = document.createElement('div');
        textContentDiv.classList.add('text-content');
        // Ensure textContentDiv is after thoughtsDiv if thoughtsDiv was added
        const thoughtsDiv = messageDiv.querySelector('.thoughts-content');
        if (thoughtsDiv && thoughtsDiv.nextSibling) {
            messageDiv.insertBefore(textContentDiv, thoughtsDiv.nextSibling);
        } else {
            messageDiv.appendChild(textContentDiv);
        }
    }
    
    textContentDiv.innerHTML = processMathAndMarkdown(safeAnswerContent);

    decorateMarkdownLinks(messageDiv);

    textContentDiv.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });

    bindInlineImagePreviews(messageDiv);

    try {
      services.selectionThreadManager?.decorateMessageElement?.(messageDiv, node);
    } catch (e) {
      console.warn('更新 AI 消息时应用划词线程高亮失败:', e);
    }
    scrollToBottom(resolveScrollContainerForMessage(messageDiv));
    messageVirtualizer.scheduleUpdate(resolveMessageListContainer(messageDiv));
  }

  function bindInlineImagePreviews(container) {
    if (!container) return;
    try {
      const previewTargets = container.querySelectorAll('.image-tag img, img.ai-inline-image');
      previewTargets.forEach(img => {
        if (img.dataset.previewBound === 'true') return;
        img.dataset.previewBound = 'true';
        img.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          imageHandler.showImagePreview(img.src);
        });
      });
    } catch (e) {
      console.error('绑定图片预览失败:', e);
    }
  }

  /**
   * 切换美元符号数学渲染时，重新处理当前所有 AI 消息
   */
  function rerenderAiMessagesForMathSetting() {
    if (!chatContainer) return;
    const aiMessages = chatContainer.querySelectorAll('.message.ai-message');
    if (!aiMessages.length) return;

    aiMessages.forEach((messageDiv) => {
      const messageId = messageDiv.getAttribute('data-message-id');
      const originalText = messageDiv.getAttribute('data-original-text');
      if (!messageId || typeof originalText !== 'string') return;

      const historyNode = chatHistoryManager?.chatHistory?.messages?.find(msg => msg.id === messageId);
      if (!historyNode) return;

      try {
        updateAIMessage(messageId, originalText, historyNode.thoughtsRaw ?? null);
      } catch (error) {
        console.error('重新渲染消息失败:', messageId, error);
      }
    });
  }

  /**
   * 获取提示词类型
   * @param {HTMLElement|string} content - 输入内容，可以是HTML元素或字符串
   * @param {Object} prompts - 提示词设置对象
   * @returns {string} 提示词类型 ('summary'|'selection'|'query'|'none')
   */
  function getPromptTypeFromContent(content, prompts) {
    if (!prompts) return 'none';
    // 归一化输入文本（去掉前后空白）
    const normalizedContent = (typeof content === 'string') ? content.trim() : content;

    // 检查是否是页面总结提示词
    if (prompts.summary?.prompt && normalizedContent === prompts.summary.prompt.trim()) {
      return 'summary';
    }

    // 检查是否是划词搜索提示词，将 selection prompt 中的 "<SELECTION>" 移除后进行匹配
    if (prompts.selection?.prompt) {
      const selectionPromptKeyword = prompts.selection.prompt.split('<SELECTION>')[0].trim();
      if (selectionPromptKeyword && normalizedContent.startsWith(selectionPromptKeyword)) {
        return 'selection';
      }
    }

    // 检查是否是普通查询提示词
    if (prompts.query?.prompt) {
      const queryPromptKeyword = prompts.query.prompt.split('<SELECTION>')[0].trim();
      if (queryPromptKeyword && normalizedContent.startsWith(queryPromptKeyword)) {
        return 'query';
      }
    }

    return 'none';
  }

  /**
   * 提取提示文本中的系统消息内容
   *
   * 此函数扫描输入的提示文本，并提取被 {{system}} 和 {{end_system}} 标记包裹的内容，
   * 该内容通常作为系统级指令被单独处理。
   *
   * @param {string} promptText - 包含自定义系统标记的提示文本
   * @returns {string} 返回提取出的系统消息内容；如果不存在则返回空字符串
   * @example
   * // 输入 "请总结以下内容 {{system}}额外指令{{end_system}}"，返回 "额外指令"
   */
  function extractSystemContent(promptText) {
    if (!promptText) return '';
    const regex = /{{system}}([\s\S]*?){{end_system}}/; // 使用捕获组
    const match = promptText.match(regex);
    return match ? match[1].trim() : '';
  }

  /**
   * 处理数学公式和Markdown
   * @param {string} text - 要处理的文本
   * @returns {string} 处理后的HTML
   */
  function processMathAndMarkdown(text) {
    const settingsManager = appContext.services.settingsManager;
    const enableDollarMath = settingsManager?.getSetting?.('enableDollarMath');
    // 折叠“搜索过程/思考过程”等自定义片段
    const foldedText = foldMessageContent(text || '');
    // 使用纯函数式渲染管线（禁用内联 HTML、支持 KaTeX、严格 DOMPurify）
    return renderMarkdownSafe(foldedText, { allowDetails: true, enableDollarMath });
  }

  try {
    services.settingsManager?.subscribe?.('enableDollarMath', () => {
      rerenderAiMessagesForMathSetting();
    });
  } catch (error) {
    console.warn('订阅 enableDollarMath 设置变化失败:', error);
  }

  // 在创建消息处理器时安装一次全局链接拦截器
  installMarkdownLinkInterceptor();
  messageVirtualizer.init();

  /**
   * 预处理 Markdown 文本，修正 "**bold**text" 这类连写导致的粗体解析问题
   * @param {string} text - 原始文本
   * @returns {string} 处理后的文本
   */
  // 旧的粗体修复、数学占位处理已内聚至 utils/markdown_renderer.js

  /**
   * 根据正则折叠消息文本，使用自定义正则表达式和摘要文本
   * @param {string} text - 原始消息文本
   * @returns {string} 处理后的消息文本，其中符合条件的部分被包裹在一个折叠元素中
   */
  function foldMessageContent(text) {
    if (typeof text !== 'string') return text;
    // 预先去掉 <think> 段落，思考摘要改由独立区域展示
    const { cleanText } = extractThinkingFromText(text);
    let normalizedText = cleanText;
    // 定义折叠配置
    const foldConfigs = [
      {
        regex: /^([\s\S]*)<\/search>/,
        summary: '搜索过程'
      }
    ];

    // 对每个配置应用折叠处理
    for (const config of foldConfigs) {
      const match = normalizedText.match(config.regex);
      if (match && match[1] && match[1].trim() !== '') {
        const foldedPart = match[1];
        const remainingPart = normalizedText.slice(match[0].length);
        const quotedFoldedPart = `<blockquote>${foldedPart}</blockquote>`;
        normalizedText = `<details class="folded-message"><summary>${config.summary}</summary><div>\n${quotedFoldedPart}</div></details>\n\n${remainingPart}`;
      }
    }

    return normalizedText;
  }

  /**
   * 预处理数学表达式
   * @param {string} text - 原始文本
   * @returns {Object} 包含处理后的文本和数学表达式的对象
   */
  // 数学预/后处理逻辑交由渲染器统一处理

  /**
   * 后处理数学表达式
   * @param {string} text - 处理后的文本
   * @param {Array} mathExpressions - 数学表达式数组
   * @returns {string} 替换数学表达式后的文本
   */
  // 参见 utils/markdown_renderer.js 中的 KaTeX 渲染
  
  // 返回公共API
  return {
    appendMessage,
    updateAIMessage,
    processMathAndMarkdown,
    decorateMarkdownLinks,
    getPromptTypeFromContent,
    extractSystemContent
  };
}
