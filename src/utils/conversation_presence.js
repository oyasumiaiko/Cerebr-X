/**
 * @file 会话-标签页“存在性”管理（侧栏端）
 *
 * 目标：
 * - 侧栏(iframe) / 独立聊天页会在不同的浏览器标签页中运行；
 * - 当用户从“聊天记录”面板打开某条历史会话时，如果该会话已在其它标签页打开，
 *   同时编辑/保存可能造成冲突；
 * - 这里负责把“当前标签页正在打开的 conversationId”上报到 background，
 *   并接收 background 广播的全局快照，用于 UI 做“已打开/跳转”提示。
 *
 * 设计要点：
 * - 使用 `chrome.runtime.connect` 建立长连接：Port 的生命周期与当前侧栏实例绑定；
 * - background 端通过 onDisconnect 自动清理，降低 stale 映射；
 * - 本模块只维护轻量状态与订阅通知，尽量保持纯函数/低耦合。
 */

const PRESENCE_PORT_NAME = 'cerebr-conversation-presence';

function normalizeConversationId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function safeObject(value) {
  return value && typeof value === 'object' ? value : {};
}

/**
 * 创建会话存在性服务。
 * @param {ReturnType<import('../ui/sidebar/sidebar_app_context.js').createSidebarAppContext>} appContext
 */
export function createConversationPresence(appContext) {
  const state = appContext?.state || {};
  const isStandalone = !!state.isStandalone;

  let port = null;
  let selfTabId = null;
  let selfWindowId = null;
  let selfTabIdConfirmed = false;
  let activeConversationId = null;
  let openConversations = {};
  const instanceId = `presence_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let lockSnapshot = {};
  const pendingLockRequests = new Map();

  const listeners = new Set();
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  function getTabMetaForTooltip() {
    if (isStandalone) {
      return {
        tabTitle: (document?.title || '独立聊天').toString(),
        tabUrl: (location?.href || '').toString()
      };
    }
    return {
      tabTitle: (state?.pageInfo?.title || document?.title || '').toString(),
      tabUrl: (state?.pageInfo?.url || '').toString()
    };
  }

  function emitChange() {
    for (const listener of listeners) {
      try { listener(); } catch (_) {}
    }
  }

  function applySnapshot(snapshot) {
    openConversations = safeObject(snapshot?.openConversations || snapshot);
    emitChange();
  }

  function applyLockSnapshot(snapshot) {
    lockSnapshot = safeObject(snapshot?.locks || snapshot);
    emitChange();
  }

  function resolveLockInfo(conversationId) {
    const convId = normalizeConversationId(conversationId);
    if (!convId) return null;
    const info = lockSnapshot?.[convId] || null;
    if (!info || typeof info !== 'object') return null;
    return {
      tabId: Number.isFinite(Number(info?.tabId)) ? Number(info.tabId) : null,
      windowId: Number.isFinite(Number(info?.windowId)) ? Number(info.windowId) : null,
      instanceId: typeof info?.instanceId === 'string' ? info.instanceId : null,
      lastUpdated: Number.isFinite(Number(info?.lastUpdated)) ? Number(info.lastUpdated) : 0
    };
  }

  function getSelfInstanceId() {
    return instanceId;
  }

  async function ensureSelfTabResolved() {
    if (!chrome?.tabs) return;
    if (selfTabIdConfirmed && Number.isFinite(Number(selfTabId))) return;

    const normalizeUrlForCompare = (url) => {
      try { return String(url || '').split('#')[0]; } catch (_) { return ''; }
    };

    // 优先尝试 getCurrent：若可用，它能准确返回“承载当前扩展页(含 iframe)的 tab”，不依赖是否激活
    try {
      if (typeof chrome.tabs.getCurrent === 'function') {
        let tab = null;
        try {
          const maybe = chrome.tabs.getCurrent();
          if (maybe && typeof maybe.then === 'function') {
            tab = await maybe;
          }
        } catch (_) {
          tab = null;
        }
        if (!tab) {
          tab = await new Promise((resolve) => {
            try { chrome.tabs.getCurrent((t) => resolve(t || null)); } catch (_) { resolve(null); }
          });
        }
        if (Number.isFinite(Number(tab?.id))) {
          selfTabId = Number(tab.id);
          selfWindowId = Number.isFinite(Number(tab?.windowId)) ? Number(tab.windowId) : null;
          selfTabIdConfirmed = true;
          return;
        }
      }
    } catch (_) {}

    try {
      if (typeof chrome.tabs.query !== 'function') return;

      // 兜底方案：只有在我们能拿到“本侧栏对应的期望 URL”时，才用 active tab 去推断 tabId，
      // 避免在后台标签页/多窗口场景下把 tabId 误绑定到其它标签页。
      const expectedUrl = isStandalone ? (location?.href || '') : (state?.pageInfo?.url || '');
      const expectedNormalized = normalizeUrlForCompare(expectedUrl);
      if (!expectedNormalized) return;

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      const activeNormalized = normalizeUrlForCompare(tab?.url || '');
      if (expectedNormalized && activeNormalized && expectedNormalized === activeNormalized && Number.isFinite(Number(tab?.id))) {
        selfTabId = Number(tab.id);
        selfWindowId = Number.isFinite(Number(tab?.windowId)) ? Number(tab.windowId) : null;
        selfTabIdConfirmed = true;
      }
    } catch (_) {}
  }

  async function sendActiveConversation() {
    if (!port) return;
    await ensureSelfTabResolved();
    const { tabTitle, tabUrl } = getTabMetaForTooltip();
    try {
      port.postMessage({
        type: 'SET_ACTIVE_CONVERSATION',
        conversationId: activeConversationId,
        isStandalone,
        tabId: selfTabId,
        windowId: selfWindowId,
        tabTitle,
        tabUrl
      });
    } catch (_) {}
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(8000, 300 * Math.pow(2, reconnectAttempt));
    reconnectAttempt = Math.min(6, reconnectAttempt + 1);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    // 若运行环境不支持（极端情况），直接降级为空实现
    if (!chrome?.runtime?.connect) return;

    try {
      port = chrome.runtime.connect({ name: PRESENCE_PORT_NAME });
    } catch (e) {
      port = null;
      scheduleReconnect();
      return;
    }

    reconnectAttempt = 0;

    port.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'PRESENCE_ACK') {
        if (Number.isFinite(Number(message.tabId))) selfTabId = Number(message.tabId);
        if (Number.isFinite(Number(message.windowId))) selfWindowId = Number(message.windowId);
        if (message.openConversations) applySnapshot(message.openConversations);
        if (message.lockSnapshot) applyLockSnapshot(message.lockSnapshot);
        // ACK 到达后补发一次当前会话，确保 background 端快速收敛到正确状态
        setTimeout(sendActiveConversation, 0);
        return;
      }

      if (message.type === 'OPEN_CONVERSATIONS_SNAPSHOT') {
        applySnapshot(message.openConversations);
      }

      if (message.type === 'CONVERSATION_LOCK_SNAPSHOT') {
        applyLockSnapshot(message.locks);
        return;
      }

      if (message.type === 'CONVERSATION_LOCK_RESULT') {
        const requestId = message.requestId;
        const resolver = pendingLockRequests.get(requestId);
        if (resolver) {
          pendingLockRequests.delete(requestId);
          resolver(message);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      scheduleReconnect();
    });

    // 初次连接后立即上报一次（即使为 null，也能让 background 端更新 tab 元信息）
    setTimeout(sendActiveConversation, 0);
  }

  async function refreshOpenConversations() {
    if (!chrome?.runtime?.sendMessage) return;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_OPEN_CONVERSATION_TABS' });
      if (resp && typeof resp === 'object') {
        if (Number.isFinite(Number(resp.requesterTabId))) selfTabId = Number(resp.requesterTabId);
        // 兜底：部分环境下 sender.tab 不可用，这里主动解析当前活动 tab
        if (!Number.isFinite(Number(selfTabId))) {
          await ensureSelfTabResolved();
        }
        applySnapshot(resp.openConversations);
      }
    } catch (_) {}
  }

  async function focusConversation(conversationId, options = {}) {
    if (!chrome?.runtime?.sendMessage) return { status: 'error', message: 'runtime_sendMessage_unavailable' };
    const convId = normalizeConversationId(conversationId);
    if (!convId) return { status: 'error', message: 'invalid_conversation_id' };

    try {
      return await chrome.runtime.sendMessage({
        type: 'FOCUS_CONVERSATION_TAB',
        conversationId: convId,
        excludeTabId: Number.isFinite(Number(options.excludeTabId)) ? Number(options.excludeTabId) : selfTabId
      });
    } catch (e) {
      return { status: 'error', message: e?.message || 'focus_failed' };
    }
  }

  function setActiveConversationId(conversationId) {
    activeConversationId = normalizeConversationId(conversationId);
    sendActiveConversation();
  }

  async function requestConversationLock(conversationId, options = {}) {
    if (!port) return { status: 'error', reason: 'port_unavailable' };
    const convId = normalizeConversationId(conversationId);
    if (!convId) return { status: 'error', reason: 'invalid_conversation_id' };
    await ensureSelfTabResolved();
    const requestId = `lock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const payload = {
      type: 'REQUEST_CONVERSATION_LOCK',
      conversationId: convId,
      requestId,
      instanceId,
      tabId: selfTabId,
      windowId: selfWindowId,
      force: options?.force === true
    };
    const responsePromise = new Promise((resolve) => {
      pendingLockRequests.set(requestId, resolve);
      setTimeout(() => {
        if (pendingLockRequests.has(requestId)) {
          pendingLockRequests.delete(requestId);
          resolve({ status: 'timeout', conversationId: convId, requestId });
        }
      }, 1800);
    });
    try {
      port.postMessage(payload);
    } catch (_) {
      pendingLockRequests.delete(requestId);
      return { status: 'error', reason: 'post_failed', conversationId: convId };
    }
    return responsePromise;
  }

  async function releaseConversationLock(conversationId) {
    if (!port) return { status: 'error', reason: 'port_unavailable' };
    const convId = normalizeConversationId(conversationId);
    if (!convId) return { status: 'error', reason: 'invalid_conversation_id' };
    await ensureSelfTabResolved();
    const requestId = `unlock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const payload = {
      type: 'RELEASE_CONVERSATION_LOCK',
      conversationId: convId,
      requestId,
      instanceId,
      tabId: selfTabId,
      windowId: selfWindowId
    };
    const responsePromise = new Promise((resolve) => {
      pendingLockRequests.set(requestId, resolve);
      setTimeout(() => {
        if (pendingLockRequests.has(requestId)) {
          pendingLockRequests.delete(requestId);
          resolve({ status: 'timeout', conversationId: convId, requestId });
        }
      }, 1800);
    });
    try {
      port.postMessage(payload);
    } catch (_) {
      pendingLockRequests.delete(requestId);
      return { status: 'error', reason: 'post_failed', conversationId: convId };
    }
    return responsePromise;
  }

  function getSelfTabId() {
    return Number.isFinite(Number(selfTabId)) ? Number(selfTabId) : null;
  }

  function getConversationLock(conversationId) {
    return resolveLockInfo(conversationId);
  }

  function getConversationTabs(conversationId) {
    const convId = normalizeConversationId(conversationId);
    if (!convId) return [];
    const items = openConversations?.[convId];
    return Array.isArray(items) ? items.slice() : [];
  }

  function getOpenConversationsSnapshot() {
    return openConversations;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // 建立连接（失败则自动重连）
  connect();

  return {
    setActiveConversationId,
    refreshOpenConversations,
    focusConversation,
    getSelfTabId,
    getSelfInstanceId,
    getConversationTabs,
    getConversationLock,
    requestConversationLock,
    releaseConversationLock,
    getOpenConversationsSnapshot,
    subscribe
  };
}
